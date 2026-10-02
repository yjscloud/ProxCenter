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
import { useT } from '../i18n';
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
  const t = useT();
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
      toast.success(
        t('fwTpl.saved'),
        t('fwTpl.savedDetail', { n: draft.rules.length }),
      );
      setEditing(null);
    } catch (err) {
      toast.error(t('firewall.saveFailed'), errorMessage(err));
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
      toast.success(t('fwTpl.deleted'), deleteTarget.name);
      setDeleteTarget(null);
    } catch (err) {
      toast.error(t('firewall.deleteFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startFromCurrent = () => {
    if (currentRules.length === 0) {
      toast.warning(t('fwTpl.noRules'), t('fwTpl.noRulesHint'));
      return;
    }
    setEditing({
      id: '',
      name: t('fwTpl.defaultName', { label: currentLabel }),
      description: t('fwTpl.defaultDesc', {
        label: currentLabel,
        n: currentRules.length,
      }),
      enable: true,
      policy_in: '',
      policy_out: '',
      rules: toTemplateRules(currentRules),
    });
  };

  const columns: Array<Column<FirewallTemplate>> = [
    {
      key: 'name',
      header: t('fwTpl.colTemplate'),
      render: (tpl) => (
        <div>
          <div className="fw-600">{tpl.name}</div>
          {tpl.description ? (
            <div className="fs-xs text-muted">{tpl.description}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'rules',
      header: t('fwTpl.colRules'),
      width: 90,
      render: (tpl) => (
        <Badge variant="neutral" size="sm">
          {t('fwTpl.ruleCount', { n: tpl.rules.length })}
        </Badge>
      ),
    },
    {
      key: 'policy',
      header: t('fwTpl.colOnApply'),
      width: 190,
      render: (tpl) => (
        <span className="fs-xs text-muted">
          {tpl.enable ? t('fwTpl.enableSwitch') : t('fwTpl.keepSwitch')}
          {tpl.policy_in ? t('fwTpl.policyIn', { policy: tpl.policy_in }) : ''}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      width: 176,
      align: 'right',
      render: (tpl) => (
        <span className="row-actions">
          {canManage ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setApplyTarget(tpl)}
                disabled={vms.length === 0}
              >
                {t('fwTpl.apply')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(tpl)}>
                {t('common.edit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDeleteTarget(tpl)}
                title={t('fwTpl.deleteTitle')}
              >
                <IconTrash size={14} />
              </Button>
            </>
          ) : (
            <span className="fs-xs text-muted">{t('firewall.readonly')}</span>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <Card collapsible={false}>
        <CardHeader
          title={t('fwTpl.title')}
          subtitle={t('fwTpl.subtitle')}
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
                  <IconPlus size={14} /> {t('fwTpl.createFromCurrent')}
                </Button>
              ) : null}
            </div>
          }
        />

        {results ? (
          <Notice
            tone={results.failed === 0 ? 'success' : 'warning'}
            title={t('fwTpl.done', {
              applied: results.applied,
              failed: results.failed,
            })}
            action={
              <Button size="sm" variant="ghost" onClick={() => setResults(null)}>
                {t('common.close')}
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
                      {t('fwTpl.appliedOk', {
                        added: item.added,
                        removed: item.removed,
                      })}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--danger)' }}>
                      {t('fwTpl.appliedFail', { error: item.error })}
                    </span>
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
          caption={t('fwTpl.caption')}
          rows={templates}
          columns={columns}
          rowKey={(tpl) => tpl.id}
          loading={templatesQuery.isLoading}
          emptyTitle={t('fwTpl.empty')}
          emptyDescription={t('fwTpl.emptyDesc')}
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
        title={t('fwTpl.deleteTitle')}
        message={t('fwTpl.deleteMessage', { name: deleteTarget?.name ?? '' })}
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
  const t = useT();
  const [draft, setDraft] = useState(template);
  const [error, setError] = useState<string | undefined>();

  return (
    <Modal
      open
      onClose={onClose}
      title={template.id ? t('fwTpl.editTitle') : t('fwTpl.newTitle')}
      description={t('fwTpl.editorDesc', { n: template.rules.length })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              if (!draft.name.trim()) {
                setError(t('fwTpl.nameRequired'));
                return;
              }
              onSubmit({ ...draft, name: draft.name.trim() });
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <Field label={t('fwTpl.fieldName')} required error={error}>
          <Input
            value={draft.name}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
              if (error) setError(undefined);
            }}
            placeholder={t('fwTpl.namePlaceholder')}
          />
        </Field>
        <Field label={t('fwTpl.fieldDesc')}>
          <Input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder={t('fwTpl.descPlaceholder')}
          />
        </Field>
        <Switch
          checked={draft.enable}
          onChange={(v) => setDraft({ ...draft, enable: v })}
          label={t('fwTpl.enableLabel')}
          hint={t('fwTpl.enableHint')}
        />
        <Notice tone="info">{t('fwTpl.policyNote')}</Notice>
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
  const t = useT();
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
      toast.warning(t('fwTpl.selectFirst'));
      return;
    }
    setBusy(true);
    try {
      const result = await firewallApi.applyTemplate(template.id, targets, replace);
      onDone(result);
    } catch (err) {
      toast.error(t('fwTpl.applyFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('fwTpl.applyTitle', { name: template.name })}
      description={t('fwTpl.applyDesc', {
        n: template.rules.length,
        m: selected.size,
      })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={selected.size === 0}
            onClick={() => void apply()}
          >
            <IconCheck size={15} /> {t('fwTpl.applyTo', { n: selected.size })}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <Notice tone={replace ? 'warning' : 'info'}>
          {replace ? t('fwTpl.replaceNote') : t('fwTpl.appendNote')}
        </Notice>

        <Switch
          checked={replace}
          onChange={setReplace}
          label={t('fwTpl.replaceLabel')}
        />

        <div className="form-row">
          <div className="flex-1">
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t('fwTpl.searchPlaceholder')}
              aria-label={t('fwTpl.searchAria')}
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setSelected(new Set(visible.map((vm) => vm.vmid)))
            }
          >
            {t('fwTpl.selectAll', { n: visible.length })}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            <IconClose size={14} /> {t('fwTpl.clear')}
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
            <div className="fw-pick-empty">{t('fwTpl.noMatch')}</div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
