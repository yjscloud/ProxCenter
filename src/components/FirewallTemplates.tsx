/* ==========================================================================
   ProxCenter — 防火墙规则模板 + 批量下发

   模板是面板侧的概念（Proxmox 只有单机规则）：把一套规则存下来，再一次性
   刷到多台虚拟机上，用于「新机器上线统一放行 22/80/443」这类场景。

   下发是危险操作：会先清空目标机现有规则（可关闭），后端要求二次确认。
   ========================================================================== */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { firewallApi, vmsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Card, CardHeader } from './ui/Card';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Field, Input, Switch } from './ui/Input';
import { Modal } from './ui/Modal';
import { Table, type Column } from './ui/Table';
import { Notice } from './ui/EmptyState';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { IconCheck, IconClose, IconPlus, IconRefresh, IconSave, IconTrash } from './Icons';
import { useToast } from '../hooks/useToast';
import type {
  FirewallApplyResult,
  FirewallRule,
  FirewallRuleInput,
  FirewallTemplate,
} from '../api/types';

/** 模板规则 = 当前作用域规则的快照（去掉位置与 digest） */
function toTemplateRules(rules: FirewallRule[]): FirewallRuleInput[] {
  return rules.map((rule) => {
    const { pos: _pos, digest: _digest, ...rest } = rule;
    return rest;
  });
}

export interface FirewallTemplatesProps {
  canManage: boolean;
  /** 当前作用域的规则，用于「用当前规则新建模板」 */
  currentRules: FirewallRule[];
  /** 描述这些规则的来源，例如「pve1 节点规则」 */
  currentLabel: string;
}

export function FirewallTemplates({
  canManage,
  currentRules,
  currentLabel,
}: FirewallTemplatesProps) {
  const qc = useQueryClient();
  const toast = useToast();

  const templatesQuery = useQuery({
    queryKey: ['firewall', 'templates'],
    queryFn: firewallApi.templates,
    retry: false,
  });
  const vmsQuery = useQuery({
    queryKey: ['vms', 'all'],
    queryFn: () => vmsApi.list(),
    staleTime: 60_000,
  });

  const [editing, setEditing] = useState<FirewallTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FirewallTemplate | null>(null);
  const [applyTarget, setApplyTarget] = useState<FirewallTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<FirewallApplyResult | null>(null);

  const templates = templatesQuery.data ?? [];
  const vms = useMemo(
    () => (vmsQuery.data ?? []).filter((vm) => !vm.template),
    [vmsQuery.data],
  );

  const saveTemplate = async (draft: FirewallTemplate) => {
    setBusy(true);
    try {
      await firewallApi.saveTemplate(draft);
      await qc.invalidateQueries({ queryKey: ['firewall', 'templates'] });
      toast.success('模板已保存', draft.rules.length + ' 条规则');
      setEditing(null);
    } catch (err) {
      toast.error('保存失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const removeTemplate = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await firewallApi.deleteTemplate(deleteTarget.id);
      await qc.invalidateQueries({ queryKey: ['firewall', 'templates'] });
      toast.success('模板已删除', deleteTarget.name);
      setDeleteTarget(null);
    } catch (err) {
      toast.error('删除失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startFromCurrent = () => {
    if (currentRules.length === 0) {
      toast.warning('当前没有规则', '先加几条规则，再另存为模板');
      return;
    }
    setEditing({
      id: '',
      name: `${currentLabel}模板`,
      description: `来自${currentLabel}（${currentRules.length} 条规则）`,
      enable: true,
      policy_in: '',
      policy_out: '',
      rules: toTemplateRules(currentRules),
    });
  };

  const columns: Array<Column<FirewallTemplate>> = [
    {
      key: 'name',
      header: '模板',
      render: (t) => (
        <div>
          <div className="fw-600">{t.name}</div>
          {t.description ? (
            <div className="fs-xs text-muted">{t.description}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'rules',
      header: '规则',
      width: 90,
      render: (t) => <Badge variant="neutral" size="sm">{t.rules.length} 条</Badge>,
    },
    {
      key: 'policy',
      header: '下发时',
      width: 190,
      render: (t) => (
        <span className="fs-xs text-muted">
          {t.enable ? '打开防火墙开关' : '不改开关'}
          {t.policy_in ? ` · 入站默认 ${t.policy_in}` : ''}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      width: 176,
      align: 'right',
      render: (t) => (
        <span className="row-actions">
          {canManage ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setApplyTarget(t)}
                disabled={vms.length === 0}
              >
                下发
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                编辑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDeleteTarget(t)}
                title="删除模板"
              >
                <IconTrash size={14} />
              </Button>
            </>
          ) : (
            <span className="fs-xs text-muted">只读</span>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <Card collapsible={false}>
        <CardHeader
          title="规则模板"
          subtitle="把一套规则存下来，一次刷到多台虚拟机上"
          icon={<IconSave size={16} />}
          actions={
            <div className="form-row">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void templatesQuery.refetch()}
                loading={templatesQuery.isFetching}
              >
                <IconRefresh size={14} />
              </Button>
              {canManage ? (
                <Button size="sm" variant="primary" onClick={startFromCurrent}>
                  <IconPlus size={14} /> 用当前规则新建
                </Button>
              ) : null}
            </div>
          }
        />

        {results ? (
          <Notice
            tone={results.failed === 0 ? 'success' : 'warning'}
            title={`下发完成：成功 ${results.applied} 台，失败 ${results.failed} 台`}
            action={
              <Button size="sm" variant="ghost" onClick={() => setResults(null)}>
                关闭
              </Button>
            }
          >
            <div className="dyn-list">
              {results.results.map((item) => (
                <div key={`${item.node}-${item.vmid}`} className="fs-sm">
                  <span className="mono">
                    {item.node}/{item.vmid}
                  </span>{' '}
                  {item.ok ? (
                    <span style={{ color: 'var(--success)' }}>
                      已下发（+{item.added} 条，清掉 {item.removed} 条）
                    </span>
                  ) : (
                    <span style={{ color: 'var(--danger)' }}>失败：{item.error}</span>
                  )}
                  {item.ok && item.warning ? (
                    <div className="fs-xs text-muted">{item.warning}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </Notice>
        ) : null}

        <Table
          caption="防火墙规则模板"
          rows={templates}
          columns={columns}
          rowKey={(t) => t.id}
          loading={templatesQuery.isLoading}
          emptyTitle="还没有模板"
          emptyDescription="在「安全策略」页配好规则后，点「用当前规则新建」即可存成模板"
        />
      </Card>

      {editing ? (
        <TemplateEditor
          template={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={saveTemplate}
        />
      ) : null}

      {applyTarget ? (
        <ApplyTemplateModal
          template={applyTarget}
          vms={vms}
          busy={busy}
          onClose={() => setApplyTarget(null)}
          onDone={(result) => {
            setResults(result);
            setApplyTarget(null);
          }}
          setBusy={setBusy}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除模板"
        message={`确定删除模板「${deleteTarget?.name ?? ''}」？已下发的规则不受影响。`}
        danger
        loading={busy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void removeTemplate()}
      />
    </>
  );
}

/* -------------------------------------------------------------- 模板编辑 */
function TemplateEditor({
  template,
  busy,
  onClose,
  onSubmit,
}: {
  template: FirewallTemplate;
  busy: boolean;
  onClose: () => void;
  onSubmit: (t: FirewallTemplate) => void;
}) {
  const [draft, setDraft] = useState(template);
  const [error, setError] = useState<string | undefined>();

  return (
    <Modal
      open
      onClose={onClose}
      title={template.id ? '编辑模板' : '新建模板'}
      description={`包含 ${template.rules.length} 条规则（规则内容来自保存时的快照）`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              if (!draft.name.trim()) {
                setError('请填写模板名称');
                return;
              }
              onSubmit({ ...draft, name: draft.name.trim() });
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <Field label="模板名称" required error={error}>
          <Input
            value={draft.name}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
              if (error) setError(undefined);
            }}
            placeholder="例如：Web 服务器基线"
          />
        </Field>
        <Field label="说明">
          <Input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="这套规则适用于哪些机器"
          />
        </Field>
        <Switch
          checked={draft.enable}
          onChange={(v) => setDraft({ ...draft, enable: v })}
          label="下发时打开目标机的防火墙开关"
          hint="关掉则只写规则、不动开关（机器本来就没开防火墙时很有用）"
        />
        <Notice tone="info">
          规则的「默认策略」（入站 / 出站）留空表示不改动目标机原有设置。
        </Notice>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- 批量下发 */
function ApplyTemplateModal({
  template,
  vms,
  busy,
  onClose,
  onDone,
  setBusy,
}: {
  template: FirewallTemplate;
  vms: Array<{ node: string; vmid: number; name: string; type?: string }>;
  busy: boolean;
  onClose: () => void;
  onDone: (result: FirewallApplyResult) => void;
  setBusy: (v: boolean) => void;
}) {
  const toast = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [keyword, setKeyword] = useState('');
  const [replace, setReplace] = useState(true);

  const visible = vms.filter((vm) => {
    const text = keyword.trim().toLowerCase();
    if (!text) return true;
    return (
      vm.name.toLowerCase().includes(text) || String(vm.vmid).includes(text)
    );
  });

  const toggle = (vmid: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(vmid)) next.delete(vmid);
      else next.add(vmid);
      return next;
    });
  };

  const apply = async () => {
    const targets = vms
      .filter((vm) => selected.has(vm.vmid))
      .map((vm) => ({ node: vm.node, vmid: vm.vmid, type: vm.type ?? '' }));
    if (targets.length === 0) {
      toast.warning('请先选择虚拟机');
      return;
    }
    setBusy(true);
    try {
      const result = await firewallApi.applyTemplate(template.id, targets, replace);
      onDone(result);
    } catch (err) {
      toast.error('下发失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`下发模板：${template.name}`}
      description={`${template.rules.length} 条规则 · 已选 ${selected.size} 台`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={selected.size === 0}
            onClick={() => void apply()}
          >
            <IconCheck size={15} /> 下发到 {selected.size} 台
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <Notice tone={replace ? 'warning' : 'info'}>
          {replace
            ? '覆盖式下发：会先清空目标机现有的（非安全组引用的）规则，再写入模板规则。'
            : '追加式下发：目标机已有规则保留，模板规则追加在最后。'}
        </Notice>

        <Switch
          checked={replace}
          onChange={setReplace}
          label="覆盖目标机现有规则"
        />

        <div className="form-row">
          <div className="flex-1">
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索名称或 VMID"
              aria-label="搜索虚拟机"
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setSelected(new Set(visible.map((vm) => vm.vmid)))
            }
          >
            全选当前 {visible.length} 台
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            <IconClose size={14} /> 清空
          </Button>
        </div>

        <div className="fw-pick-list">
          {visible.map((vm) => (
            <label key={`${vm.node}-${vm.vmid}`} className="fw-pick-row">
              <input
                type="checkbox"
                checked={selected.has(vm.vmid)}
                onChange={() => toggle(vm.vmid)}
              />
              <span className="fw-500">{vm.name}</span>
              <span className="mono fw-pick-meta">
                {vm.node}/{vm.vmid}
              </span>
            </label>
          ))}
          {visible.length === 0 ? (
            <div className="fw-pick-empty">没有匹配的虚拟机</div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
