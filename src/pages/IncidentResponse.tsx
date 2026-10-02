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
import { useT, type MessageKey } from '../i18n';
import { formatBytes, formatDateTime } from '../utils/format';
import type { ProtectedBackup, ProtectedBackupState, QuarantineResult } from '../api/types';

const STATE_META: Record<
  ProtectedBackupState,
  { label: MessageKey; variant: 'success' | 'danger' | 'warning' | 'neutral' }
> = {
  ok: { label: 'incident.state.ok', variant: 'success' },
  missing: { label: 'incident.state.missing', variant: 'danger' },
  changed: { label: 'incident.state.changed', variant: 'warning' },
  unknown: { label: 'incident.state.unknown', variant: 'neutral' },
};

/** 处置步骤的文案键 */
const STEP_LABEL: Record<string, MessageKey> = {
  snapshot: 'incident.step.snapshot',
  network: 'incident.step.network',
  power: 'incident.step.power',
  protect: 'incident.step.protect',
};

function StepList({ result }: { result: QuarantineResult }) {
  const t = useT();
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
                {STEP_LABEL[step.step] ? t(STEP_LABEL[step.step]) : step.step}
              </span>
              <Badge variant={step.ok ? 'success' : 'danger'} size="sm">
                {step.ok ? t('status.audit.success') : t('status.audit.failed')}
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
  const t = useT();
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
      toast.error(t('incident.selectVmFirst'));
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
        toast.destructive(t('incident.quarantineDone'), result.summary);
      } else {
        toast.warning(t('incident.quarantinePartial'), result.summary);
      }
      await queryClient.invalidateQueries({ queryKey: ['incident'] });
      await queryClient.invalidateQueries({ queryKey: ['vms'] });
    } catch (err) {
      toast.error(t('incident.quarantineFailed'), errorMessage(err));
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
      toast.success(t('incident.released'), result.summary);
      await queryClient.invalidateQueries({ queryKey: ['incident'] });
      await queryClient.invalidateQueries({ queryKey: ['vms'] });
    } catch (err) {
      toast.error(t('incident.releaseFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const protectBackup = async () => {
    if (!volid.trim() || !bNode.trim() || !bStorage.trim()) {
      toast.error(t('incident.fillFields'));
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
      toast.success(t('incident.protectDone'), result.detail);
      setVolid('');
      setBNote('');
      await refreshProtected();
    } catch (err) {
      toast.error(t('incident.protectFailed'), errorMessage(err));
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
      const scopeHint = result.scoped ? t('incident.scopeHint') : '';
      if (result.missing || result.changed) {
        toast.error(
          t('incident.verifyProblem'),
          t('incident.verifyProblemDetail', {
            missing: result.missing,
            changed: result.changed,
            tail: result.scoped ? scopeHint : t('incident.verifyAlertsPushed'),
          }),
        );
      } else {
        toast.success(
          t('incident.verifyDone'),
          t('incident.verifyDoneDetail', { n: result.checked, scopeHint }),
        );
      }
      await refreshProtected();
    } catch (err) {
      toast.error(t('incident.verifyFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const doUnprotect = async () => {
    if (!unprotectTarget) return;
    try {
      await protectedBackupsApi.unprotect(unprotectTarget);
      toast.success(t('incident.unprotectDone'), t('incident.unprotectDoneDetail'));
      await refreshProtected();
    } catch (err) {
      toast.error(t('incident.unprotectFailed'), errorMessage(err));
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
  const plannedSteps: Array<{ on: boolean; key: MessageKey; offKey: MessageKey }> = [
    { on: snapshot, key: 'incident.plan.snapshot', offKey: 'incident.planOff.snapshot' },
    { on: cutNetwork, key: 'incident.plan.network', offKey: 'incident.planOff.network' },
    {
      on: powerAction !== 'none',
      key: powerAction === 'stop' ? 'incident.plan.stop' : 'incident.plan.shutdown',
      offKey:
        powerAction === 'stop' ? 'incident.planOff.stop' : 'incident.planOff.shutdown',
    },
    { on: protect, key: 'incident.plan.protect', offKey: 'incident.planOff.protect' },
  ];

  const columns: Array<Column<ProtectedBackup>> = [
    {
      key: 'volid',
      header: t('incident.colVolid'),
      render: (row) => <span className="mono fs-xs">{row.volid}</span>,
    },
    {
      key: 'where',
      header: t('incident.colStorage'),
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
      header: t('incident.colSize'),
      width: 100,
      render: (row) => <span className="fs-xs">{formatBytes(row.size)}</span>,
    },
    {
      key: 'state',
      header: t('incident.colState'),
      width: 200,
      render: (row) => (
        <span className="form-row" style={{ gap: 4 }}>
          <Badge variant={STATE_META[row.state].variant} size="sm">
            {t(STATE_META[row.state].label)}
          </Badge>
          {row.pve_protected ? (
            <Badge variant="accent" size="sm" title={t('incident.pveProtectedTitle')}>
              {t('incident.pveProtectedBadge')}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: 'detail',
      header: t('incident.colDetail'),
      render: (row) => (
        <span className="fs-xs text-muted">{row.state_detail || row.note || '—'}</span>
      ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      width: 90,
      render: (row) =>
        canBackup ? (
          <Button size="sm" variant="ghost" onClick={() => setUnprotectTarget(row.volid)}>
            {t('incident.remove')}
          </Button>
        ) : null,
    },
  ];

  return (
    <PageShell
      title={t('incident.title')}
      subtitle={t('incident.subtitle')}
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon={<IconRefresh size={14} />}
          loading={protectedQuery.isFetching}
          onClick={() => void protectedQuery.refetch()}
        >
          {t('common.refresh')}
        </Button>
      }
    >
      {/* ============================================== 虚拟机隔离 */}
      <div className="section-block">
        <div className="section-title">
          <IconLock size={15} />
          <span className="section-name">{t('incident.isoSection')}</span>
          <span className="section-hint">{t('incident.isoSectionHint')}</span>
        </div>

        <Card collapsible={false}>
          <CardHeader
            title={t('incident.targetTitle')}
            subtitle={t('incident.targetSubtitle')}
            icon={<IconAlert size={16} />}
          />

          {!canIsolate ? (
            <Notice tone="info" title={t('incident.needPermTitle')}>
              {t('incident.needPermPre')}
              <span className="mono">vm.isolate</span>
              {t('incident.needPermMid')}
            </Notice>
          ) : (
            <>
              {/* 状态横幅：一进页面就知道这台机器现在是死是活 */}
              {statusQuery.isError ? (
                <Notice tone="warning" title={t('incident.statusReadError')}>
                  {errorMessage(statusQuery.error)}
                </Notice>
              ) : null}

              {statusQuery.data ? (
                <Notice
                  tone={statusQuery.data.isolated ? 'warning' : 'success'}
                  title={
                    statusQuery.data.isolated
                      ? t('incident.isolatedTitle', {
                          n: statusQuery.data.cut_interfaces.length,
                          protectSuffix: statusQuery.data.protected
                            ? t('incident.isolatedProtectSuffix')
                            : '',
                        })
                      : t('incident.notIsolated')
                  }
                >
                  {statusQuery.data.evidence_snapshots.length ? (
                    <>
                      {t('incident.evidenceLabel')}
                      {statusQuery.data.evidence_snapshots
                        .map((item) =>
                          t('incident.evidenceItem', {
                            name: item.name,
                            time: formatDateTime(item.snaptime ?? 0),
                          }),
                        )
                        .join(t('incident.evidenceSeparator'))}
                    </>
                  ) : (
                    t('incident.noEvidence')
                  )}
                </Notice>
              ) : null}

              <div className="split-panel is-even">
                {/* 左：控制台 */}
                <div className="inc-col">
                  <div className="dyn-row">
                    <Select
                      label={t('incident.selectVmLabel')}
                      placeholder={t('incident.selectVmPlaceholder')}
                      value={target}
                      onChange={(event) => setTarget(event.target.value)}
                      options={vmOptions}
                    />
                    <Select
                      label={t('incident.step.power')}
                      value={powerAction}
                      onChange={(event) =>
                        setPowerAction(event.target.value as 'none' | 'shutdown' | 'stop')
                      }
                      options={[
                        { label: t('incident.powerShutdown'), value: 'shutdown' },
                        { label: t('incident.powerNone'), value: 'none' },
                        { label: t('incident.powerStop'), value: 'stop' },
                      ]}
                    />
                  </div>

                  <div className="dyn-row">
                    <Switch
                      checked={snapshot}
                      onChange={setSnapshot}
                      label={t('incident.snapSwitch')}
                      hint={t('incident.snapSwitchHint')}
                    />
                    <Switch
                      checked={cutNetwork}
                      onChange={setCutNetwork}
                      label={t('incident.netSwitch')}
                      hint={t('incident.netSwitchHint')}
                    />
                    <Switch
                      checked={protect}
                      onChange={setProtect}
                      label={t('incident.protectSwitch')}
                      hint={t('incident.protectSwitchHint')}
                    />
                  </div>

                  <Textarea
                    label={t('incident.noteLabel')}
                    hint={t('incident.noteHint')}
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
                      {t('incident.isolateNow')}
                    </Button>
                    <Button
                      variant="secondary"
                      loading={busy}
                      disabled={!parsed || !statusQuery.data?.isolated}
                      onClick={() => void runRelease(false)}
                    >
                      {t('incident.release')}
                    </Button>
                    <Button
                      variant="secondary"
                      loading={busy}
                      disabled={!parsed || !statusQuery.data?.isolated}
                      onClick={() => setPowerOnConfirm(true)}
                    >
                      {t('incident.releasePowerOn')}
                    </Button>
                  </div>
                  <div className="inc-hint">
                    {t('incident.actionsHint')}
                  </div>
                </div>

                {/* 右：动作预览 / 上次结果 —— 让危险操作在按下之前就能看清 */}
                <div className="inc-col">
                  <div className="inc-side-title">
                    {lastResult ? t('incident.lastResult') : t('incident.previewTitle')}
                  </div>

                  {lastResult ? (
                    <>
                      <div className="fs-sm">{lastResult.summary}</div>
                      <StepList result={lastResult} />
                      {lastResult.caveats?.length ? (
                        <Notice tone="info" title={t('incident.caveatsTitle')}>
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
                          key={step.key}
                          className={`inc-explain-item ${step.on ? '' : 'is-off'}`}
                        >
                          <span className="inc-explain-index" aria-hidden="true">
                            {index + 1}
                          </span>
                          <span>{step.on ? t(step.key) : t(step.offKey)}</span>
                        </div>
                      ))}
                      {!parsed ? (
                        <div className="inc-hint">{t('incident.pickVmHint')}</div>
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
          <span className="section-name">{t('incident.backupSection')}</span>
          <span className="section-hint">{t('incident.backupSectionHint')}</span>
        </div>

        <div className="grid grid-4">
        <KpiCard
          label={t('incident.kpi.total')}
          value={stats.total}
          icon={<IconStorage size={16} />}
          tone="accent"
          hint={t('incident.kpi.totalHint')}
        />
        <KpiCard
          label={t('incident.state.missing')}
          value={stats.missing}
          icon={<IconAlert size={16} />}
          tone={stats.missing ? 'danger' : 'success'}
          hint={stats.missing ? t('incident.kpi.missingHint') : t('incident.kpi.noneMissing')}
        />
        <KpiCard
          label={t('incident.state.changed')}
          value={stats.changed}
          icon={<IconInfo size={16} />}
          tone={stats.changed ? 'warning' : 'success'}
          hint={stats.changed ? t('incident.kpi.changedHint') : t('incident.kpi.metaOk')}
        />
        <KpiCard
          label={t('incident.kpi.pveProtected')}
          value={stats.pveProtected}
          icon={<IconShield size={16} />}
          tone="neutral"
          hint={t('incident.kpi.pveProtectedHint')}
        />
      </div>

        <CollapsibleCard
          title={t('incident.immutableTitle')}
          icon={<IconInfo size={15} />}
        >
          <div className="inc-note">
            <p>
              {t('incident.worm1a')}<b>{t('incident.worm1b')}</b>{t('incident.worm1c')}
            </p>
            <p>
              {t('incident.worm2a')}<b>{t('incident.worm2b')}</b>{t('incident.worm2c')}
              <span className="mono"> protected</span>{t('incident.worm2d')}
            </p>
            <p>
              {t('incident.worm3a')}<b>{t('incident.worm3b')}</b>{t('incident.worm3c')}
              <b>{t('incident.worm3d')}</b>{t('incident.worm3e')}
            </p>
          </div>
        </CollapsibleCard>

      <Card collapsible={false}>
        <CardHeader
          title={t('incident.protectedTitle', { n: items.length })}
          subtitle={t('incident.protectedSubtitle')}
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
                {t('incident.verifyNow')}
              </Button>
            ) : null
          }
        />

        {canBackup ? (
          <div className="create-bar">
            <div className="field-row">
              <Field label={t('common.node')} required className="field-narrow">
                <Input
                  placeholder="pve1"
                  value={bNode}
                  onChange={(event) => setBNode(event.target.value)}
                />
              </Field>
              <Field label={t('incident.fieldStorage')} required className="field-narrow">
                <Input
                  placeholder="backup"
                  value={bStorage}
                  onChange={(event) => setBStorage(event.target.value)}
                />
              </Field>
              <Field
                label={t('incident.colVolid')}
                required
                hint={t('incident.volidHint')}
                className="field-wide"
              >
                <Input
                  placeholder="backup:backup/vzdump-qemu-100-2026_09_25-00_00_00.vma.zst"
                  mono
                  value={volid}
                  onChange={(event) => setVolid(event.target.value)}
                />
              </Field>
              <Field label={t('incident.fieldNote')}>
                <Input
                  placeholder={t('incident.notePlaceholder')}
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
                {t('incident.protectBtn')}
              </Button>
            </div>
          </div>
        ) : null}

        {protectedQuery.isError ? (
          <ErrorState
            title={t('incident.listLoadFailed')}
            message={errorMessage(protectedQuery.error)}
            onRetry={() => void protectedQuery.refetch()}
          />
        ) : items.length ? (
          <Table
            columns={columns}
            rows={items}
            rowKey={(row) => row.volid}
            caption={t('incident.caption')}
            dense
            emptyTitle={t('incident.emptyTitle')}
          />
        ) : (
          <EmptyState
            title={t('incident.emptyTitle')}
            description={t('incident.emptyDesc')}
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
        title={t('incident.unprotectTitle')}
        message={t('incident.unprotectMessage', { volid: unprotectTarget ?? '' })}
        confirmText={t('incident.unprotectConfirm')}
        danger
        onCancel={() => setUnprotectTarget(null)}
        onConfirm={() => void doUnprotect()}
      />

      <ConfirmDialog
        open={powerOnConfirm}
        title={t('incident.releasePowerOn')}
        message={t('incident.powerOnMessage')}
        confirmText={t('incident.powerOnConfirm')}
        requireText={t('incident.powerOnRequire')}
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
