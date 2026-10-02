/* ==========================================================================
   ProxCenter — 防火墙 / 安全组

   直接管理 Proxmox 原生防火墙，三个作用域一张页面：

   * 集群：默认策略与全局规则（影响所有主机，需要 firewall.cluster）
   * 节点：单台宿主机的规则
   * 虚拟机 / 容器：某台机器的规则（普通用户只能碰自己名下的机器）

   外加集群级共享对象：安全组（groups）、IP 集合（ipset），以及面板侧的
   规则模板 —— 把一套规则一次刷到多台机器（见 FirewallTemplates）。
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { firewallApi, nodesApi, vmsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Field, Input, Select, SegmentedControl, Switch } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { Notice } from '../components/ui/EmptyState';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { FirewallRuleEditor } from '../components/FirewallRuleEditor';
import { FirewallTemplates } from '../components/FirewallTemplates';
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconClose,
  IconLayers,
  IconLock,
  IconPlus,
  IconRefresh,
  IconShield,
  IconTrash,
} from '../components/Icons';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { tStatic, useT } from '../i18n';
import type {
  FirewallGroup,
  FirewallIpset,
  FirewallOptions,
  FirewallRule,
  FirewallRuleInput,
  FirewallScope,
} from '../api/types';

type Tab = 'rules' | 'groups' | 'ipsets' | 'templates';

const ACTIONS = ['ACCEPT', 'DROP', 'REJECT'];

function actionTone(action: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (action === 'ACCEPT') return 'success';
  if (action === 'DROP') return 'danger';
  if (action === 'REJECT') return 'warning';
  return 'neutral';
}

/** 规则 → 提交模型（去掉 pos / digest） */
function toInput(rule: FirewallRule, override: Partial<FirewallRuleInput> = {}): FirewallRuleInput {
  const { pos: _pos, digest: _digest, ...rest } = rule;
  return { ...rest, pos: null, ...override };
}

/** 端口列的展示：宏 > 端口 > 任意 */
function targetText(rule: FirewallRule): string {
  if (rule.macro) return tStatic('firewall.macro', { name: rule.macro });
  const proto = rule.proto || 'any';
  const port = rule.dport || 'any';
  return `${proto}/${port}`;
}

export function Firewall() {
  const t = useT();
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const scopes = useMemo<Array<{ label: string; value: FirewallScope }>>(
    () => [
      { label: t('firewall.scopeVm'), value: 'vm' },
      { label: t('firewall.scopeNode'), value: 'node' },
      { label: t('firewall.scopeCluster'), value: 'cluster' },
    ],
    [t],
  );

  const canManage = hasPermission('firewall.manage');
  const canCluster = hasPermission('firewall.cluster');

  const [tab, setTab] = useState<Tab>('rules');
  const [scope, setScope] = useState<FirewallScope>('vm');
  const [node, setNode] = useState('');
  const [vmid, setVmid] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  /* ---- 编辑器 ---- */
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<FirewallRule | null>(null);
  /** 编辑安全组内的规则时带上组名 */
  const [editingGroup, setEditingGroup] = useState<string>('');

  /* ---- 安全组 / IP 集合 ---- */
  const [activeGroup, setActiveGroup] = useState('');
  const [groupDraft, setGroupDraft] = useState({ name: '', comment: '' });
  const [ipsetDraft, setIpsetDraft] = useState({ name: '', comment: '' });
  const [entryDraft, setEntryDraft] = useState({ cidr: '', comment: '', nomask: false });
  const [activeIpset, setActiveIpset] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<
    { kind: 'group' | 'ipset' | 'rule' | 'group-rule' | 'entry'; name: string; pos?: number } | null
  >(null);

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    staleTime: 60_000,
  });
  const vmsQuery = useQuery({
    queryKey: ['vms', 'all'],
    queryFn: () => vmsApi.list(),
    staleTime: 30_000,
  });

  const nodes = nodesQuery.data ?? [];
  const vms = useMemo(
    () => (vmsQuery.data ?? []).filter((vm) => !vm.template),
    [vmsQuery.data],
  );

  /* 默认选中第一台机器 / 第一个节点，省掉「先选一次」的空屏 */
  useEffect(() => {
    if (vmid === null && vms.length > 0) {
      setVmid(vms[0].vmid);
      setNode(vms[0].node);
    }
  }, [vms, vmid]);
  useEffect(() => {
    if (scope === 'node' && !node && nodes.length > 0) setNode(nodes[0].node);
  }, [scope, node, nodes]);

  const scopeReady =
    scope === 'cluster' ||
    (scope === 'node' && Boolean(node)) ||
    (scope === 'vm' && Boolean(node) && vmid !== null);

  const scopeParams = useMemo((): [FirewallScope, string, number | undefined] => {
    if (scope === 'cluster') return ['cluster', '', undefined];
    if (scope === 'node') return ['node', node, undefined];
    return ['vm', node, vmid ?? undefined];
  }, [scope, node, vmid]);

  const scopeLabel = useMemo(() => {
    if (scope === 'cluster') return t('firewall.scopeClusterLabel');
    if (scope === 'node') {
      return t('firewall.scopeNodeLabel', {
        node: node || t('firewall.scopeNodeFallback'),
      });
    }
    const vm = vms.find((item) => item.vmid === vmid);
    return vm
      ? t('firewall.scopeVmLabel', { name: vm.name, vmid: vm.vmid })
      : t('firewall.scopeVmFallback', { vmid: vmid ?? '' });
  }, [scope, node, vmid, vms, t]);

  const rulesQuery = useQuery({
    queryKey: ['firewall', 'rules', ...scopeParams],
    queryFn: () => firewallApi.rules(...scopeParams),
    enabled: scopeReady,
    retry: false,
  });
  const optionsQuery = useQuery({
    queryKey: ['firewall', 'options', ...scopeParams],
    queryFn: () => firewallApi.options(...scopeParams),
    enabled: scopeReady,
    retry: false,
  });
  const refsQuery = useQuery({
    queryKey: ['firewall', 'refs'],
    queryFn: firewallApi.refs,
    staleTime: 300_000,
    retry: false,
  });
  const groupsQuery = useQuery({
    queryKey: ['firewall', 'groups'],
    queryFn: firewallApi.groups,
    enabled: tab === 'groups' || tab === 'rules',
    retry: false,
  });
  const groupRulesQuery = useQuery({
    queryKey: ['firewall', 'group-rules', activeGroup],
    queryFn: () => firewallApi.groupRules(activeGroup),
    enabled: tab === 'groups' && Boolean(activeGroup),
    retry: false,
  });
  const ipsetsQuery = useQuery({
    queryKey: ['firewall', 'ipsets'],
    queryFn: firewallApi.ipsets,
    enabled: tab === 'ipsets',
    retry: false,
  });

  const rules = rulesQuery.data ?? [];
  const groups = groupsQuery.data ?? [];
  const groupRules = groupRulesQuery.data ?? [];
  const ipsets = ipsetsQuery.data ?? [];
  const options = optionsQuery.data ?? {};
  const currentIpset = ipsets.find((item) => item.name === activeIpset) ?? null;

  const writable =
    canManage && (scope !== 'cluster' || canCluster);

  const enabledCount = rules.filter((rule) => rule.enable).length;

  const invalidateRules = () =>
    qc.invalidateQueries({ queryKey: ['firewall', 'rules'] });

  /* ---------------------------------------------------------- 规则操作 */

  const submitRule = async (rule: FirewallRuleInput) => {
    setBusy(true);
    try {
      if (editingGroup) {
        if (editingRule) {
          await firewallApi.updateGroupRule(editingGroup, editingRule.pos, rule);
        } else {
          await firewallApi.createGroupRule(editingGroup, rule);
        }
        await qc.invalidateQueries({
          queryKey: ['firewall', 'group-rules', editingGroup],
        });
      } else if (editingRule) {
        await firewallApi.updateRule(...scopeParams, editingRule.pos, rule);
        await invalidateRules();
      } else {
        await firewallApi.createRule(...scopeParams, rule);
        await invalidateRules();
      }
      toast.success(editingRule ? t('firewall.ruleUpdated') : t('firewall.ruleAdded'));
      setEditorOpen(false);
      setEditingRule(null);
      setEditingGroup('');
    } catch (err) {
      toast.error(t('firewall.saveFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleRule = async (rule: FirewallRule, group = '') => {
    setBusy(true);
    try {
      const payload = toInput(rule, { enable: !rule.enable });
      if (group) {
        await firewallApi.updateGroupRule(group, rule.pos, payload);
        await qc.invalidateQueries({ queryKey: ['firewall', 'group-rules', group] });
      } else {
        await firewallApi.updateRule(...scopeParams, rule.pos, payload);
        await invalidateRules();
      }
      toast.success(payload.enable ? t('firewall.ruleEnabled') : t('firewall.ruleDisabled'));
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const moveRule = async (rule: FirewallRule, to: number) => {
    if (to < 0) return;
    setBusy(true);
    try {
      await firewallApi.moveRule(...scopeParams, rule.pos, to);
      await invalidateRules();
    } catch (err) {
      toast.error(t('firewall.moveFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const removeRule = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      if (deleteTarget.kind === 'group') {
        await firewallApi.deleteGroup(deleteTarget.name);
        await groupsQuery.refetch();
        if (activeGroup === deleteTarget.name) setActiveGroup('');
      } else if (deleteTarget.kind === 'ipset') {
        await firewallApi.deleteIpset(deleteTarget.name);
        await ipsetsQuery.refetch();
        if (activeIpset === deleteTarget.name) setActiveIpset('');
      } else if (deleteTarget.kind === 'entry' && currentIpset) {
        await firewallApi.deleteIpsetEntry(currentIpset.name, deleteTarget.name);
        await ipsetsQuery.refetch();
      } else if (deleteTarget.kind === 'group-rule') {
        await firewallApi.deleteGroupRule(deleteTarget.name, deleteTarget.pos ?? 0);
        await qc.invalidateQueries({
          queryKey: ['firewall', 'group-rules', deleteTarget.name],
        });
      } else {
        await firewallApi.deleteRule(...scopeParams, deleteTarget.pos ?? 0);
        await invalidateRules();
      }
      toast.success(t('firewall.deleted'));
      setDeleteTarget(null);
    } catch (err) {
      toast.error(t('firewall.deleteFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const saveOptions = async (patch: FirewallOptions) => {
    setBusy(true);
    try {
      await firewallApi.saveOptions(...scopeParams, patch);
      await qc.invalidateQueries({ queryKey: ['firewall', 'options'] });
      toast.success(t('firewall.optionsSaved'));
    } catch (err) {
      toast.error(t('firewall.saveFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const createGroup = async () => {
    if (!groupDraft.name.trim()) {
      toast.warning(t('firewall.groupNameRequired'));
      return;
    }
    setBusy(true);
    try {
      await firewallApi.createGroup(groupDraft.name.trim(), groupDraft.comment.trim());
      setGroupDraft({ name: '', comment: '' });
      await groupsQuery.refetch();
      await refsQuery.refetch();
      toast.success(t('firewall.groupCreated'));
    } catch (err) {
      toast.error(t('firewall.createFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const createIpset = async () => {
    if (!ipsetDraft.name.trim()) {
      toast.warning(t('firewall.ipsetNameRequired'));
      return;
    }
    setBusy(true);
    try {
      await firewallApi.createIpset(ipsetDraft.name.trim(), ipsetDraft.comment.trim());
      setIpsetDraft({ name: '', comment: '' });
      await ipsetsQuery.refetch();
      await refsQuery.refetch();
      toast.success(t('firewall.ipsetCreated'));
    } catch (err) {
      toast.error(t('firewall.createFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addEntry = async () => {
    if (!currentIpset || !entryDraft.cidr.trim()) {
      toast.warning(t('firewall.entryRequired'));
      return;
    }
    setBusy(true);
    try {
      await firewallApi.createIpsetEntry(currentIpset.name, {
        cidr: entryDraft.cidr.trim(),
        comment: entryDraft.comment.trim(),
        nomatch: entryDraft.nomask,
      });
      setEntryDraft({ cidr: '', comment: '', nomask: false });
      await ipsetsQuery.refetch();
    } catch (err) {
      toast.error(t('firewall.entryAddFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------------------------------------- 表格 */

  const ruleColumns = (
    group: string,
  ): Array<Column<FirewallRule>> => [
    {
      key: 'pos',
      header: '#',
      width: 56,
      align: 'center',
      render: (rule) => <span className="mono fs-sm">{rule.pos}</span>,
    },
    {
      key: 'state',
      header: t('firewall.colState'),
      width: 74,
      render: (rule) =>
        rule.enable ? (
          <Badge variant="success" size="sm">
            {t('firewall.active')}
          </Badge>
        ) : (
          <Badge variant="neutral" size="sm">
            {t('firewall.inactive')}
          </Badge>
        ),
    },
    {
      key: 'dir',
      header: t('firewall.colDir'),
      width: 84,
      render: (rule) => (
        <span className="fs-sm">
          {rule.type === 'group'
            ? t('firewall.dirGroup')
            : rule.type === 'out'
              ? t('firewall.dirOut')
              : t('firewall.dirIn')}
        </span>
      ),
    },
    {
      key: 'action',
      header: t('firewall.colAction'),
      width: 90,
      render: (rule) => (
        <Badge variant={actionTone(rule.action)} size="sm">
          {rule.action}
        </Badge>
      ),
    },
    {
      key: 'match',
      header: t('firewall.colMatch'),
      render: (rule) => (
        <span className="fs-sm mono">
          {rule.type === 'group' ? `+${rule.group}` : targetText(rule)}
        </span>
      ),
    },
    {
      key: 'source',
      header: t('firewall.colSource'),
      render: (rule) => (
        <span className="fs-xs text-muted mono">
          {rule.source || 'any'} → {rule.dest || 'any'}
        </span>
      ),
    },
    {
      key: 'log',
      header: t('firewall.colLog'),
      width: 72,
      render: (rule) =>
        rule.log && rule.log !== 'nolog' ? (
          <Badge variant="warning" size="sm">
            {rule.log}
          </Badge>
        ) : (
          <span className="fs-xs text-muted">—</span>
        ),
    },
    {
      key: 'comment',
      header: t('firewall.colComment'),
      render: (rule) => (
        <span className="fs-sm">{rule.comment || <span className="text-muted">—</span>}</span>
      ),
    },
    {
      key: 'ops',
      header: t('common.actions'),
      width: 224,
      align: 'right',
      render: (rule) => (
        <span className="row-actions">
          {canManage ? (
            <>
              {group ? null : (
                <>
                  <IconButton
                    label={t('firewall.moveUp')}
                    disabled={busy || rule.pos === 0}
                    onClick={() => void moveRule(rule, rule.pos - 1)}
                  >
                    <IconChevronUp size={15} />
                  </IconButton>
                  <IconButton
                    label={t('firewall.moveDown')}
                    disabled={busy}
                    onClick={() => void moveRule(rule, rule.pos + 1)}
                  >
                    <IconChevronDown size={15} />
                  </IconButton>
                </>
              )}
              <IconButton
                label={rule.enable ? t('firewall.disableRule') : t('firewall.enableRule')}
                variant={rule.enable ? 'ghost' : 'primary'}
                disabled={busy}
                onClick={() => void toggleRule(rule, group)}
              >
                {rule.enable ? <IconClose size={15} /> : <IconCheck size={15} />}
              </IconButton>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditingGroup(group);
                  setEditingRule(rule);
                  setEditorOpen(true);
                }}
              >
                {t('common.edit')}
              </Button>
              <IconButton
                label={t('firewall.deleteRule')}
                variant="danger"
                onClick={() =>
                  setDeleteTarget(
                    group
                      ? { kind: 'group-rule', name: group, pos: rule.pos }
                      : { kind: 'rule', name: scopeLabel, pos: rule.pos },
                  )
                }
              >
                <IconTrash size={15} />
              </IconButton>
            </>
          ) : (
            <span className="fs-xs text-muted">{t('firewall.readonly')}</span>
          )}
        </span>
      ),
    },
  ];

  const ipsetEntryColumns: Array<Column<{ cidr: string; comment: string; nomatch: boolean }>> = [
    { key: 'cidr', header: t('firewall.colAddress'), mono: true, render: (e) => e.cidr },
    {
      key: 'nomatch',
      header: t('firewall.colNomatch'),
      width: 80,
      render: (e) =>
        e.nomatch ? (
          <Badge variant="warning" size="sm">
            {t('common.yes')}
          </Badge>
        ) : (
          <span className="text-muted fs-xs">{t('common.no')}</span>
        ),
    },
    { key: 'comment', header: t('firewall.colComment'), render: (e) => e.comment || '—' },
    {
      key: 'ops',
      header: '',
      width: 64,
      align: 'right',
      render: (e) => (
        <span className="row-actions">
          {canManage ? (
            <IconButton
              label={t('firewall.deleteEntry', { cidr: e.cidr })}
              variant="danger"
              onClick={() => setDeleteTarget({ kind: 'entry', name: e.cidr })}
            >
              <IconTrash size={15} />
            </IconButton>
          ) : null}
        </span>
      ),
    },
  ];

  const groupColumns: Array<Column<FirewallGroup>> = [
    {
      key: 'group',
      header: t('firewall.colGroup'),
      render: (g) => (
        <button
          type="button"
          className={`link-text mono ${activeGroup === g.group ? 'is-active' : ''}`}
          title={t('firewall.groupRulesHint')}
          onClick={() => setActiveGroup(g.group)}
        >
          {g.group}
        </button>
      ),
    },
    { key: 'comment', header: t('firewall.colComment'), render: (g) => g.comment || '—' },
    {
      key: 'ops',
      header: '',
      width: 64,
      align: 'right',
      render: (g) => (
        <span className="row-actions">
          {canCluster ? (
            <IconButton
              label={t('firewall.deleteGroup', { name: g.group })}
              variant="danger"
              onClick={() => setDeleteTarget({ kind: 'group', name: g.group })}
            >
              <IconTrash size={15} />
            </IconButton>
          ) : null}
        </span>
      ),
    },
  ];

  /* ------------------------------------------------------------- 渲染 */

  return (
    <PageShell
      title={t('firewall.title')}
      subtitle={t('firewall.subtitle')}
      actions={
        <div className="form-row">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void rulesQuery.refetch();
              void optionsQuery.refetch();
            }}
            loading={rulesQuery.isFetching}
          >
            <IconRefresh size={14} /> {t('common.refresh')}
          </Button>
        </div>
      }
    >
      <div className="tabs" role="tablist" aria-label={t('firewall.viewAria')}>
        {(
          [
            { key: 'rules', label: t('firewall.tabRules'), icon: <IconShield size={15} /> },
            { key: 'groups', label: t('firewall.tabGroups'), icon: <IconLayers size={15} /> },
            { key: 'ipsets', label: t('firewall.tabIpsets'), icon: <IconLock size={15} /> },
            { key: 'templates', label: t('firewall.tabTemplates'), icon: <IconPlus size={15} /> },
          ] as Array<{ key: Tab; label: string; icon: React.ReactNode }>
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`tab ${tab === item.key ? 'is-active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            <span className="tab-icon" aria-hidden="true">
              {item.icon}
            </span>
            {item.label}
          </button>
        ))}
      </div>

      <div className="tab-panel">
        {tab === 'rules' ? (
          <>
            <Card collapsible={false}>
              <CardHeader
                title={t('firewall.configTitle')}
                subtitle={t('firewall.configSubtitle')}
                icon={<IconShield size={16} />}
                actions={
                  <SegmentedControl<FirewallScope>
                    value={scope}
                    onChange={(value) => setScope(value)}
                    options={scopes}
                    ariaLabel={t('firewall.scopeAria')}
                  />
                }
              />

              {/*
                这里刻意不用 Field 的「标签在上、控件在下」：一行里有的控件带
                hint、有的不带，格子高度不一致就会错行。改成「左设置名 + 右控件」
                的配置行，同一行的控件必然在同一条水平线上。
              */}
              <div className="fw-config">
                <div className="fw-config-row">
                  <span className="fw-config-key">{t('firewall.scopeObject')}</span>
                  <div className="fw-config-val">
                    {scope === 'node' ? (
                      <div className="fw-target">
                        <Select
                          value={node}
                          onChange={(e) => setNode(e.target.value)}
                          options={nodes.map((n) => ({
                            label: `${n.node}（${n.status}）`,
                            value: n.node,
                          }))}
                          placeholder={t('firewall.selectNodePlaceholder')}
                          aria-label={t('firewall.selectNodeAria')}
                        />
                      </div>
                    ) : null}

                    {scope === 'vm' ? (
                      <>
                        <div className="fw-target">
                          <Select
                            value={vmid === null ? '' : String(vmid)}
                            onChange={(e) => {
                              const next = Number(e.target.value);
                              const vm = vms.find((item) => item.vmid === next);
                              setVmid(next);
                              if (vm) setNode(vm.node);
                            }}
                            options={vms.map((vm) => ({
                              label: `${vm.name}（${vm.node}/${vm.vmid}）`,
                              value: String(vm.vmid),
                            }))}
                            placeholder={t('firewall.selectVmPlaceholder')}
                            aria-label={t('firewall.selectVmAria')}
                          />
                        </div>
                        <span className="fw-config-note">{t('firewall.ownerOnlyNote')}</span>
                      </>
                    ) : null}

                    {scope === 'cluster' ? (
                      <span className="fw-config-note">{t('firewall.clusterNote')}</span>
                    ) : null}
                  </div>
                </div>

                {scope === 'cluster' && !canCluster ? (
                  <Notice tone="info">{t('firewall.clusterReadonly')}</Notice>
                ) : null}

                {optionsQuery.isError ? (
                  <Notice tone="warning" title={t('firewall.optionsError')}>
                    {errorMessage(optionsQuery.error)}
                  </Notice>
                ) : (
                  <>
                    <div className="fw-config-row">
                      <span className="fw-config-key">{t('firewall.enableLabel')}</span>
                      <div className="fw-config-val">
                        <Switch
                          checked={Boolean(options.enable)}
                          disabled={!writable || busy}
                          onChange={(v) => void saveOptions({ enable: v })}
                          ariaLabel={t('firewall.enableAria')}
                        />
                        <span className="fw-config-note">
                          {options.enable
                            ? t('firewall.enabledNote')
                            : t('firewall.disabledNote')}
                        </span>
                      </div>
                    </div>

                    <div className="fw-config-row">
                      <span className="fw-config-key">{t('firewall.policyLabel')}</span>
                      <div className="fw-config-val">
                        <span className="fw-config-note">{t('firewall.policyIn')}</span>
                        <Select
                          value={options.policy_in ?? 'DROP'}
                          disabled={!writable || busy}
                          onChange={(e) => void saveOptions({ policy_in: e.target.value })}
                          options={ACTIONS.map((a) => ({ label: a, value: a }))}
                          aria-label={t('firewall.policyInAria')}
                        />
                        <span className="fw-config-note">{t('firewall.policyOut')}</span>
                        <Select
                          value={options.policy_out ?? 'ACCEPT'}
                          disabled={!writable || busy}
                          onChange={(e) => void saveOptions({ policy_out: e.target.value })}
                          options={ACTIONS.map((a) => ({ label: a, value: a }))}
                          aria-label={t('firewall.policyOutAria')}
                        />
                        <span className="fw-config-note">{t('firewall.policyHint')}</span>
                      </div>
                    </div>

                    {scope === 'vm' ? (
                      <div className="fw-config-row">
                        <span className="fw-config-key">{t('firewall.addrFilter')}</span>
                        <div className="fw-config-val">
                          <Switch
                            checked={Boolean(options.ipfilter)}
                            disabled={!writable || busy}
                            onChange={(v) => void saveOptions({ ipfilter: v })}
                            ariaLabel={t('firewall.ipfilterAria')}
                          />
                          <span className="fw-config-note">{t('firewall.ipfilter')}</span>
                          <Switch
                            checked={Boolean(options.macfilter)}
                            disabled={!writable || busy}
                            onChange={(v) => void saveOptions({ macfilter: v })}
                            ariaLabel={t('firewall.macfilterAria')}
                          />
                          <span className="fw-config-note">{t('firewall.macfilter')}</span>
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </Card>

            <Card collapsible={false}>
              <CardHeader
                title={t('firewall.rulesTitle', { n: rules.length })}
                subtitle={
                  rulesQuery.isLoading
                    ? scopeLabel
                    : t('firewall.rulesSubtitleActive', {
                        scope: scopeLabel,
                        enabled: enabledCount,
                        total: rules.length,
                      })
                }
                icon={<IconShield size={16} />}
                actions={
                  writable ? (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        setEditingGroup('');
                        setEditingRule(null);
                        setEditorOpen(true);
                      }}
                    >
                      <IconPlus size={14} /> {t('firewall.addRule')}
                    </Button>
                  ) : null
                }
              />

              {rulesQuery.isError ? (
                <Notice tone="warning" title={t('firewall.rulesLoadFailed')}>
                  {errorMessage(rulesQuery.error)}
                </Notice>
              ) : (
                <Table
                  caption={t('firewall.rulesCaption')}
                  rows={rules}
                  columns={ruleColumns('')}
                  rowKey={(rule) => String(rule.pos)}
                  loading={rulesQuery.isLoading}
                  emptyTitle={t('firewall.rulesEmptyTitle')}
                  emptyDescription={t('firewall.rulesEmptyDesc')}
                />
              )}
            </Card>
          </>
        ) : null}

        {tab === 'groups' ? (
          <>
            <Card collapsible={false}>
              <CardHeader
                title={t('firewall.groupsTitle')}
                subtitle={t('firewall.groupsSubtitle')}
                icon={<IconLayers size={16} />}
              />
              <Table
                caption={t('firewall.groupsCaption')}
                rows={groups}
                columns={groupColumns}
                rowKey={(g) => g.group}
                loading={groupsQuery.isLoading}
                emptyTitle={t('firewall.groupsEmpty')}
              />
              {canCluster ? (
                <div className="create-bar">
                  <div className="field-row">
                    <Field
                      label={t('firewall.newGroup')}
                      required
                      hint={t('firewall.nameHint')}
                    >
                      <Input
                        value={groupDraft.name}
                        onChange={(e) => setGroupDraft({ ...groupDraft, name: e.target.value })}
                        placeholder={t('firewall.groupNamePlaceholder')}
                        mono
                      />
                    </Field>
                    <Field label={t('firewall.colComment')}>
                      <Input
                        value={groupDraft.comment}
                        onChange={(e) =>
                          setGroupDraft({ ...groupDraft, comment: e.target.value })
                        }
                        placeholder={t('firewall.groupCommentPlaceholder')}
                      />
                    </Field>
                    <Button
                      variant="primary"
                      loading={busy}
                      onClick={() => void createGroup()}
                    >
                      <IconPlus size={14} /> {t('common.create')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </Card>

            <Card collapsible={false}>
              <CardHeader
                title={
                  activeGroup
                    ? t('firewall.groupRulesTitle', { name: activeGroup })
                    : t('firewall.groupRulesNoSel')
                }
                subtitle={
                  activeGroup
                    ? t('firewall.groupRulesSubtitle')
                    : t('firewall.groupRulesSubtitleNoSel')
                }
                icon={<IconShield size={16} />}
                actions={
                  canManage && activeGroup ? (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        setEditingGroup(activeGroup);
                        setEditingRule(null);
                        setEditorOpen(true);
                      }}
                    >
                      <IconPlus size={14} /> {t('firewall.addRule')}
                    </Button>
                  ) : null
                }
              />
              {activeGroup ? (
                <Table
                  caption={t('firewall.groupRulesCaption')}
                  rows={groupRules}
                  columns={ruleColumns(activeGroup)}
                  rowKey={(rule) => String(rule.pos)}
                  loading={groupRulesQuery.isLoading}
                  emptyTitle={t('firewall.groupRulesEmpty')}
                />
              ) : (
                <div className="fw-placeholder">{t('firewall.groupPickHint')}</div>
              )}
            </Card>
          </>
        ) : null}

        {tab === 'ipsets' ? (
          <>
            <Card collapsible={false}>
              <CardHeader
                title={t('firewall.ipsetsTitle')}
                subtitle={t('firewall.ipsetsSubtitle')}
                icon={<IconLock size={16} />}
              />
              <Table
                caption={t('firewall.ipsetsCaption')}
                rows={ipsets}
                columns={[
                  {
                    key: 'name',
                    header: t('common.name'),
                    render: (item: FirewallIpset) => (
                      <button
                        type="button"
                        className={`link-text mono ${
                          activeIpset === item.name ? 'is-active' : ''
                        }`}
                        title={t('firewall.ipsetViewHint')}
                        onClick={() => setActiveIpset(item.name)}
                      >
                        {item.name}
                      </button>
                    ),
                  },
                  {
                    key: 'count',
                    header: t('firewall.colEntries'),
                    width: 80,
                    align: 'center',
                    render: (item: FirewallIpset) => (
                      <Badge variant="neutral" size="sm">
                        {item.entries.length}
                      </Badge>
                    ),
                  },
                  {
                    key: 'comment',
                    header: t('firewall.colComment'),
                    render: (item: FirewallIpset) => item.comment || '—',
                  },
                  {
                    key: 'ops',
                    header: '',
                    width: 64,
                    align: 'right',
                    render: (item: FirewallIpset) => (
                      <span className="row-actions">
                        {canCluster ? (
                          <IconButton
                            label={t('firewall.deleteIpset', { name: item.name })}
                            variant="danger"
                            onClick={() =>
                              setDeleteTarget({ kind: 'ipset', name: item.name })
                            }
                          >
                            <IconTrash size={15} />
                          </IconButton>
                        ) : null}
                      </span>
                    ),
                  },
                ]}
                rowKey={(item) => item.name}
                loading={ipsetsQuery.isLoading}
                emptyTitle={t('firewall.ipsetsEmpty')}
              />

              {canCluster ? (
                <div className="create-bar">
                  <div className="field-row">
                    <Field
                      label={t('firewall.newIpset')}
                      required
                      hint={t('firewall.nameHint')}
                    >
                      <Input
                        value={ipsetDraft.name}
                        onChange={(e) => setIpsetDraft({ ...ipsetDraft, name: e.target.value })}
                        placeholder={t('firewall.ipsetNamePlaceholder')}
                        mono
                      />
                    </Field>
                    <Field label={t('firewall.colComment')}>
                      <Input
                        value={ipsetDraft.comment}
                        onChange={(e) =>
                          setIpsetDraft({ ...ipsetDraft, comment: e.target.value })
                        }
                        placeholder={t('firewall.ipsetCommentPlaceholder')}
                      />
                    </Field>
                    <Button
                      variant="primary"
                      loading={busy}
                      onClick={() => void createIpset()}
                    >
                      <IconPlus size={14} /> {t('common.create')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </Card>

            {currentIpset ? (
              <Card collapsible={false}>
                <CardHeader
                  title={t('firewall.ipsetEntriesTitle', { name: currentIpset.name })}
                  subtitle={t('firewall.ipsetEntriesSubtitle')}
                  icon={<IconLock size={16} />}
                />
                <Table
                  caption={t('firewall.ipsetEntriesCaption')}
                  rows={currentIpset.entries}
                  columns={ipsetEntryColumns}
                  rowKey={(entry) => entry.cidr}
                  emptyTitle={t('firewall.ipsetEntriesEmpty')}
                />
                {canManage ? (
                  <div className="create-bar">
                    <div className="field-row">
                      <Field label={t('firewall.colAddress')} required>
                        <Input
                          value={entryDraft.cidr}
                          onChange={(e) =>
                            setEntryDraft({ ...entryDraft, cidr: e.target.value })
                          }
                          placeholder="10.8.0.0/16"
                          mono
                        />
                      </Field>
                      <Field label={t('firewall.colComment')}>
                        <Input
                          value={entryDraft.comment}
                          onChange={(e) =>
                            setEntryDraft({ ...entryDraft, comment: e.target.value })
                          }
                          placeholder={t('firewall.entryCommentPlaceholder')}
                        />
                      </Field>
                      <Button
                        variant="primary"
                        loading={busy}
                        onClick={() => void addEntry()}
                      >
                        <IconPlus size={14} /> {t('firewall.add')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </Card>
            ) : null}
          </>
        ) : null}

        {tab === 'templates' ? (
          <FirewallTemplates
            canManage={canManage}
            currentRules={rules}
            currentLabel={scopeLabel}
          />
        ) : null}
      </div>

      <FirewallRuleEditor
        open={editorOpen}
        initial={editingRule}
        inGroup={Boolean(editingGroup)}
        refs={refsQuery.data}
        busy={busy}
        onClose={() => {
          setEditorOpen(false);
          setEditingRule(null);
          setEditingGroup('');
        }}
        onSubmit={(rule) => void submitRule(rule)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={t('firewall.confirmDeleteTitle')}
        message={
          deleteTarget?.kind === 'rule' || deleteTarget?.kind === 'group-rule'
            ? t('firewall.confirmDeleteRule', { pos: deleteTarget?.pos ?? '' })
            : t('firewall.confirmDeleteNamed', { name: deleteTarget?.name ?? '' })
        }
        danger
        loading={busy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void removeRule()}
      />
    </PageShell>
  );
}
