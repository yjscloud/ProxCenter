/* ==========================================================================
   ProxCenter — 应急响应

   两块内容，都是「出事时用的」：

   1. **可疑虚拟机隔离**：一键完成「取证快照 → 断网 → 关机 → 加保护」，以及解除
      隔离。首页大字写明**处置能力的边界**（快照不是内存取证、link_down 不覆盖
      PCI 直通网卡、回滚快照会覆盖现场），不做任何超出实际能力的承诺。
   2. **备份防护（防删）**：把关键备份登记为受保护 —— 面板层禁止删除 + 定期核对
      是否被删除 / 改动。同时如实说明：真正的不可变（WORM）要靠 PBS immutability
      或 S3 Object Lock，只靠 PVE API 做不到。
   ========================================================================== */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isolationApi,
  protectedBackupsApi,
  vmsApi,
  type QuarantineInput,
} from '../api/endpoints';
import { errorMessage } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card, CardHeader, KpiCard } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Field, Input, Select, Switch, Textarea } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import {
  CollapsibleCard,
  EmptyState,
  ErrorState,
  Notice,
} from '../components/ui/EmptyState';
import {
  IconAlert,
  IconCheck,
  IconInfo,
  IconLock,
  IconRefresh,
  IconShield,
  IconStorage,
} from '../components/Icons';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { formatBytes, formatDateTime } from '../utils/format';
import type { ProtectedBackup, ProtectedBackupState, QuarantineResult } from '../api/types';

const STATE_META: Record<
  ProtectedBackupState,
  { label: string; variant: 'success' | 'danger' | 'warning' | 'neutral' }
> = {
  ok: { label: '正常', variant: 'success' },
  missing: { label: '已丢失', variant: 'danger' },
  changed: { label: '被改动', variant: 'warning' },
  unknown: { label: '无法确认', variant: 'neutral' },
};

/** 处置步骤的中文名 */
const STEP_LABEL: Record<string, string> = {
  snapshot: '取证快照',
  network: '切断网络',
  power: '电源动作',
  protect: '开启保护',
};

function StepList({ result }: { result: QuarantineResult }) {
  return (
    <div className="baseline-todo">
      {result.steps.map((step) => (
        <div
          key={step.step}
          className={`baseline-item is-${step.ok ? 'pass' : 'fail'}`}
        >
          <span className="baseline-item-icon" aria-hidden="true">
            {step.ok ? <IconCheck size={15} /> : <IconAlert size={15} />}
          </span>
          <div className="baseline-item-body">
            <div className="baseline-item-head">
              <span className="baseline-item-title">
                {STEP_LABEL[step.step] ?? step.step}
              </span>
              <Badge variant={step.ok ? 'success' : 'danger'} size="sm">
                {step.ok ? '成功' : '失败'}
              </Badge>
            </div>
            <div className="fs-xs text-muted">{step.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function IncidentResponse() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canBackup = hasPermission('vm.backup');
  const canIsolate = hasPermission('vm.isolate');

  /* ---- 隔离表单 ---- */
  const [target, setTarget] = useState('');
  const [snapshot, setSnapshot] = useState(true);
  const [cutNetwork, setCutNetwork] = useState(true);
  const [powerAction, setPowerAction] = useState<'none' | 'shutdown' | 'stop'>('shutdown');
  const [protect, setProtect] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<QuarantineResult | null>(null);
  const [powerOnConfirm, setPowerOnConfirm] = useState(false);

  /* ---- 备份防护表单 ---- */
  const [volid, setVolid] = useState('');
  const [bNode, setBNode] = useState('');
  const [bStorage, setBStorage] = useState('');
  const [bNote, setBNote] = useState('');
  const [unprotectTarget, setUnprotectTarget] = useState<string | null>(null);

  const vmsQuery = useQuery({
    queryKey: ['incident', 'vms'],
    queryFn: () => vmsApi.list(),
    staleTime: 120_000,
    retry: false,
  });
  const protectedQuery = useQuery({
    queryKey: ['incident', 'protected'],
    queryFn: () => protectedBackupsApi.list(false),
    retry: false,
  });

  const parsed = useMemo(() => {
    const [node, vmidText] = target.split('/');
    const vmid = Number(vmidText);
    return node && Number.isFinite(vmid) && vmid > 0 ? { node, vmid } : null;
  }, [target]);

  const statusQuery = useQuery({
    queryKey: ['incident', 'quarantine', target],
    queryFn: () => isolationApi.status(parsed!.node, parsed!.vmid),
    enabled: Boolean(parsed),
    retry: false,
  });

  const vmOptions = useMemo(
    () =>
      (vmsQuery.data ?? []).map((vm) => ({
        label: `${vm.name || `VM ${vm.vmid}`}（${vm.vmid} · ${vm.node} · ${vm.status}）`,
        value: `${vm.node}/${vm.vmid}`,
      })),
    [vmsQuery.data],
  );

  const refreshProtected = async () => {
    await queryClient.invalidateQueries({ queryKey: ['incident', 'protected'] });
  };

  const runQuarantine = async () => {
    if (!parsed) {
      toast.error('请先选择一台虚拟机');
      return;
    }
    const body: QuarantineInput = {
      snapshot,
      cut_network: cutNetwork,
      power_action: powerAction,
      protect,
      note: note.trim(),
    };
    setBusy(true);
    try {
      const result = await isolationApi.quarantine(parsed.node, parsed.vmid, body);
      setLastResult(result);
      if (result.ok) {
        /* 隔离会断网并关机，属于不可撤销的处置动作：成功也要让人一眼看到 */
        toast.destructive('隔离处置完成', result.summary);
      } else {
        toast.warning('隔离处置部分失败', result.summary);
      }
      await queryClient.invalidateQueries({ queryKey: ['incident'] });
      await queryClient.invalidateQueries({ queryKey: ['vms'] });
    } catch (err) {
      toast.error('隔离失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const runRelease = async (powerOn: boolean) => {
    if (!parsed) return;
    setBusy(true);
    try {
      const result = await isolationApi.release(parsed.node, parsed.vmid, {
        restore_network: true,
        unprotect: true,
        power_on: powerOn,
        note: '',
      });
      setLastResult(result);
      toast.success('已解除隔离', result.summary);
      await queryClient.invalidateQueries({ queryKey: ['incident'] });
      await queryClient.invalidateQueries({ queryKey: ['vms'] });
    } catch (err) {
      toast.error('解除隔离失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const protectBackup = async () => {
    if (!volid.trim() || !bNode.trim() || !bStorage.trim()) {
      toast.error('请填写节点、存储与备份卷 ID');
      return;
    }
    setBusy(true);
    try {
      const result = await protectedBackupsApi.protect({
        node: bNode.trim(),
        storage: bStorage.trim(),
        volid: volid.trim(),
        note: bNote.trim(),
      });
      toast.success('已登记为受保护备份', result.detail);
      setVolid('');
      setBNote('');
      await refreshProtected();
    } catch (err) {
      toast.error('登记失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const verifyNow = async () => {
    setBusy(true);
    try {
      const result = await protectedBackupsApi.verify(true);
      /* 普通用户拿到的是「只统计自己那份」的结果，也不会给他推告警 ——
         文案要说清，否则「已推送告警」会让人以为全站都收到了通知 */
      const scopeHint = result.scoped ? '（仅统计你自己登记的备份，未推送告警）' : '';
      if (result.missing || result.changed) {
        toast.error(
          '核对发现异常',
          `丢失 ${result.missing} 个，被改动 ${result.changed} 个` +
            (result.scoped ? scopeHint : '，已推送告警'),
        );
      } else {
        toast.success(
          '核对完成',
          `${result.checked} 个受保护备份均与登记信息一致${scopeHint}`,
        );
      }
      await refreshProtected();
    } catch (err) {
      toast.error('核对失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const doUnprotect = async () => {
    if (!unprotectTarget) return;
    try {
      await protectedBackupsApi.unprotect(unprotectTarget);
      toast.success('已从受保护清单移除', '现在可以在「备份」页删除它了');
      await refreshProtected();
    } catch (err) {
      toast.error('移除失败', errorMessage(err));
    } finally {
      setUnprotectTarget(null);
    }
  };

  const items = protectedQuery.data?.items ?? [];
  const stats = useMemo(
    () => ({
      total: items.length,
      missing: items.filter((item) => item.state === 'missing').length,
      changed: items.filter((item) => item.state === 'changed').length,
      pveProtected: items.filter((item) => item.pve_protected).length,
    }),
    [items],
  );

  /* 按当前勾选实时排出的动作清单：让「立即隔离」按下去之前就能看清会发生什么，
     而不是点完再从结果里读。 */
  const plannedSteps = [
    { on: snapshot, text: '取证快照 —— 唯一的磁盘现场，关掉就没了' },
    { on: cutNetwork, text: '切断虚拟网卡 —— 逐张 net* 置 link_down=1' },
    {
      on: powerAction !== 'none',
      text:
        powerAction === 'stop'
          ? '强制关机 —— 可能丢数据，仅在必须立刻止血时用'
          : '优雅关机 —— 等 guest 自己关机',
    },
    { on: protect, text: '开启 VM 保护 —— 防止慌乱中误删证据机' },
  ];

  const columns: Array<Column<ProtectedBackup>> = [
    {
      key: 'volid',
      header: '备份卷',
      render: (row) => <span className="mono fs-xs">{row.volid}</span>,
    },
    {
      key: 'where',
      header: '存储',
      width: 180,
      render: (row) => (
        <span className="fs-xs">
          {row.node}/{row.storage}
          {row.vmid ? <span className="text-muted"> · VM {row.vmid}</span> : null}
        </span>
      ),
    },
    {
      key: 'size',
      header: '大小',
      width: 100,
      render: (row) => <span className="fs-xs">{formatBytes(row.size)}</span>,
    },
    {
      key: 'state',
      header: '核对状态',
      width: 200,
      render: (row) => (
        <span className="form-row" style={{ gap: 4 }}>
          <Badge variant={STATE_META[row.state].variant} size="sm">
            {STATE_META[row.state].label}
          </Badge>
          {row.pve_protected ? (
            <Badge variant="accent" size="sm" title="PVE 侧已打上 protected 旗标">
              PVE 保护
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: 'detail',
      header: '说明',
      render: (row) => (
        <span className="fs-xs text-muted">{row.state_detail || row.note || '—'}</span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      width: 90,
      render: (row) =>
        canBackup ? (
          <Button size="sm" variant="ghost" onClick={() => setUnprotectTarget(row.volid)}>
            移除
          </Button>
        ) : null,
    },
  ];

  return (
    <PageShell
      title="应急响应"
      subtitle="可疑虚拟机一键隔离（取证快照 + 断网 + 关机）与备份防删核对"
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon={<IconRefresh size={14} />}
          loading={protectedQuery.isFetching}
          onClick={() => void protectedQuery.refetch()}
        >
          刷新
        </Button>
      }
    >
      {/* ============================================== 虚拟机隔离 */}
      <div className="section-block">
        <div className="section-title">
          <IconLock size={15} />
          <span className="section-name">虚拟机隔离处置</span>
          <span className="section-hint">先取证、再断网、最后关机 —— 顺序反了现场就没了</span>
        </div>

        <Card collapsible={false}>
          <CardHeader
            title="处置目标与动作"
            subtitle="隔离是不可逆的现场保全动作，先看状态，再动手"
            icon={<IconAlert size={16} />}
          />

          {!canIsolate ? (
            <Notice tone="info" title="需要「应急隔离」权限">
              你的账号没有 <span className="mono">vm.isolate</span> 权限，只能查看隔离状态。
              请联系管理员在「用户管理 → 角色」里授予。
            </Notice>
          ) : (
            <>
              {/* 状态横幅：一进页面就知道这台机器现在是死是活 */}
              {statusQuery.isError ? (
                <Notice tone="warning" title="读不到隔离状态">
                  {errorMessage(statusQuery.error)}
                </Notice>
              ) : null}

              {statusQuery.data ? (
                <Notice
                  tone={statusQuery.data.isolated ? 'warning' : 'success'}
                  title={
                    statusQuery.data.isolated
                      ? `当前处于隔离状态：已断 ${statusQuery.data.cut_interfaces.length} 张网卡${
                          statusQuery.data.protected ? '，并已开启 VM 保护' : ''
                        }`
                      : '当前未隔离'
                  }
                >
                  {statusQuery.data.evidence_snapshots.length ? (
                    <>
                      取证快照：
                      {statusQuery.data.evidence_snapshots
                        .map((item) => `${item.name}（${formatDateTime(item.snaptime ?? 0)}）`)
                        .join('、')}
                    </>
                  ) : (
                    '没有这台机器的取证快照。'
                  )}
                </Notice>
              ) : null}

              <div className="split-panel is-even">
                {/* 左：控制台 */}
                <div className="inc-col">
                  <div className="dyn-row">
                    <Select
                      label="选择虚拟机"
                      placeholder="选择一台虚拟机"
                      value={target}
                      onChange={(event) => setTarget(event.target.value)}
                      options={vmOptions}
                    />
                    <Select
                      label="电源动作"
                      value={powerAction}
                      onChange={(event) =>
                        setPowerAction(event.target.value as 'none' | 'shutdown' | 'stop')
                      }
                      options={[
                        { label: '优雅关机（推荐）', value: 'shutdown' },
                        { label: '只断网，不关机', value: 'none' },
                        { label: '强制关机（可能丢数据）', value: 'stop' },
                      ]}
                    />
                  </div>

                  <div className="dyn-row">
                    <Switch
                      checked={snapshot}
                      onChange={setSnapshot}
                      label="先创建取证快照"
                      hint="强烈建议保留：这是唯一的磁盘现场"
                    />
                    <Switch
                      checked={cutNetwork}
                      onChange={setCutNetwork}
                      label="切断虚拟网卡"
                      hint="逐张 net* 置 link_down=1"
                    />
                    <Switch
                      checked={protect}
                      onChange={setProtect}
                      label="开启 VM 保护"
                      hint="防止慌乱中把证据机误删"
                    />
                  </div>

                  <Textarea
                    label="处置备注"
                    hint="会写进取证快照的描述与审计日志，例如「疑似挖矿，源头工单 #123」"
                    rows={2}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />

                  <div className="inc-actions">
                    <Button
                      variant="danger"
                      icon={<IconLock size={15} />}
                      loading={busy}
                      disabled={!parsed}
                      onClick={() => void runQuarantine()}
                    >
                      立即隔离
                    </Button>
                    <Button
                      variant="secondary"
                      loading={busy}
                      disabled={!parsed || !statusQuery.data?.isolated}
                      onClick={() => void runRelease(false)}
                    >
                      解除隔离
                    </Button>
                    <Button
                      variant="secondary"
                      loading={busy}
                      disabled={!parsed || !statusQuery.data?.isolated}
                      onClick={() => setPowerOnConfirm(true)}
                    >
                      解除隔离并开机
                    </Button>
                  </div>
                  <div className="inc-hint">
                    未选虚拟机时无法执行；「解除隔离」在机器未隔离时不可用。
                  </div>
                </div>

                {/* 右：动作预览 / 上次结果 —— 让危险操作在按下之前就能看清 */}
                <div className="inc-col">
                  <div className="inc-side-title">
                    {lastResult ? '上次处置结果' : '按下「立即隔离」会发生什么'}
                  </div>

                  {lastResult ? (
                    <>
                      <div className="fs-sm">{lastResult.summary}</div>
                      <StepList result={lastResult} />
                      {lastResult.caveats?.length ? (
                        <Notice tone="info" title="这次处置的能力边界">
                          <ul style={{ paddingLeft: 18, margin: 0 }}>
                            {lastResult.caveats.map((text) => (
                              <li key={text} className="fs-xs">
                                {text}
                              </li>
                            ))}
                          </ul>
                        </Notice>
                      ) : null}
                    </>
                  ) : (
                    <div className="inc-explain">
                      {plannedSteps.map((step, index) => (
                        <div
                          key={step.text}
                          className={`inc-explain-item ${step.on ? '' : 'is-off'}`}
                        >
                          <span className="inc-explain-index" aria-hidden="true">
                            {index + 1}
                          </span>
                          <span>
                            {step.on ? step.text : `${step.text.split(' —— ')[0]}（已关闭）`}
                          </span>
                        </div>
                      ))}
                      {!parsed ? (
                        <div className="inc-hint">先在左边选一台虚拟机。</div>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </Card>
      </div>

      {/* ============================================== 备份防删 */}
      <div className="section-block">
        <div className="section-title">
          <IconShield size={15} />
          <span className="section-name">备份防删与核对</span>
          <span className="section-hint">面板层禁删 + 定期核对，异常即告警</span>
        </div>

        <div className="grid grid-4">
        <KpiCard
          label="受保护备份"
          value={stats.total}
          icon={<IconStorage size={16} />}
          tone="accent"
          hint="面板拒绝删除这些备份"
        />
        <KpiCard
          label="已丢失"
          value={stats.missing}
          icon={<IconAlert size={16} />}
          tone={stats.missing ? 'danger' : 'success'}
          hint={stats.missing ? '备份被删了，先查存储侧' : '没有丢失'}
        />
        <KpiCard
          label="被改动"
          value={stats.changed}
          icon={<IconInfo size={16} />}
          tone={stats.changed ? 'warning' : 'success'}
          hint={stats.changed ? '元数据与登记时不一致' : '元数据一致'}
        />
        <KpiCard
          label="PVE 侧已加保护"
          value={stats.pveProtected}
          icon={<IconShield size={16} />}
          tone="neutral"
          hint="能拦住 PVE 的 prune，但不是 WORM"
        />
      </div>

        <CollapsibleCard
          title="关于「不可变备份」的实话 —— 能力边界在这里说清"
          icon={<IconInfo size={15} />}
        >
          <div className="inc-note">
            <p>
              真正的不可变（WORM）必须由<b>存储侧</b>保证：PBS 的 retention/immutability、
              S3 Object Lock，或只读挂载的文件系统。只靠 PVE API 做不到，这里也没有假装做到。
            </p>
            <p>
              这一页提供的是<b>检测型</b>防护：① 面板层禁止删除受保护备份（勒索软件即使拿到
              管理员会话，也得先在界面上解除保护）；② 尽力给 PVE 卷打上
              <span className="mono"> protected</span> 旗标（拦住 PVE 的 prune 与常规删除，
              root 仍可清除）；③ 定期核对备份是否还在、元数据是否被改动，异常即告警。
            </p>
            <p>
              另外：PVE 不提供 vzdump 归档的内容校验和，所以「核对」比的是
              <b>大小与创建时间</b>，能发现<b>删除 / 替换 / 元数据变化</b>，但发现不了存储层的
              静默位翻转。需要后者请接入 PBS。
            </p>
          </div>
        </CollapsibleCard>

      <Card collapsible={false}>
        <CardHeader
          title={`受保护备份（${items.length}）`}
          subtitle="登记后面板拒绝删除，并参与定期核对"
          icon={<IconShield size={16} />}
          actions={
            canBackup ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<IconShield size={14} />}
                loading={busy}
                onClick={() => void verifyNow()}
              >
                立即核对
              </Button>
            ) : null
          }
        />

        {canBackup ? (
          <div className="create-bar">
            <div className="field-row">
              <Field label="节点" required className="field-narrow">
                <Input
                  placeholder="pve1"
                  value={bNode}
                  onChange={(event) => setBNode(event.target.value)}
                />
              </Field>
              <Field label="存储" required className="field-narrow">
                <Input
                  placeholder="backup"
                  value={bStorage}
                  onChange={(event) => setBStorage(event.target.value)}
                />
              </Field>
              <Field
                label="备份卷 ID"
                required
                hint="可在「备份」页的归档列表里复制"
                className="field-wide"
              >
                <Input
                  placeholder="backup:backup/vzdump-qemu-100-2026_09_25-00_00_00.vma.zst"
                  mono
                  value={volid}
                  onChange={(event) => setVolid(event.target.value)}
                />
              </Field>
              <Field label="备注">
                <Input
                  placeholder="例如：上线前基线备份，保留 30 天"
                  value={bNote}
                  onChange={(event) => setBNote(event.target.value)}
                />
              </Field>
              <Button
                variant="primary"
                icon={<IconShield size={15} />}
                loading={busy}
                onClick={() => void protectBackup()}
              >
                登记为受保护
              </Button>
            </div>
          </div>
        ) : null}

        {protectedQuery.isError ? (
          <ErrorState
            title="读取受保护清单失败"
            message={errorMessage(protectedQuery.error)}
            onRetry={() => void protectedQuery.refetch()}
          />
        ) : items.length ? (
          <Table
            columns={columns}
            rows={items}
            rowKey={(row) => row.volid}
            caption="受保护备份清单"
            dense
            emptyTitle="还没有受保护的备份"
          />
        ) : (
          <EmptyState
            title="还没有受保护的备份"
            description="把关键备份登记进来：面板会拒绝删除它，并定期核对是否被删除或改动。"
            icon={<IconShield size={26} />}
          />
        )}

        {protectedQuery.data?.note ? (
          <div className="fs-xs text-muted" style={{ marginTop: 10 }}>
            {protectedQuery.data.note}
          </div>
        ) : null}
        </Card>
      </div>

      <ConfirmDialog
        open={Boolean(unprotectTarget)}
        title="移除受保护标记"
        message={`移除后「${unprotectTarget ?? ''}」将重新可以在「备份」页被删除，并停止核对告警。确定吗？`}
        confirmText="移除保护"
        danger
        onCancel={() => setUnprotectTarget(null)}
        onConfirm={() => void doUnprotect()}
      />

      <ConfirmDialog
        open={powerOnConfirm}
        title="解除隔离并开机"
        message="将恢复网卡、解除 VM 保护并启动这台虚拟机。如果还没取证完成，开机可能产生新的写入，覆盖磁盘现场。"
        confirmText="确认开机"
        requireText="开机"
        danger
        onCancel={() => setPowerOnConfirm(false)}
        onConfirm={() => {
          setPowerOnConfirm(false);
          void runRelease(true);
        }}
      />
    </PageShell>
  );
}
