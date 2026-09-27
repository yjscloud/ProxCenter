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
import type {
  FirewallGroup,
  FirewallIpset,
  FirewallOptions,
  FirewallRule,
  FirewallRuleInput,
  FirewallScope,
} from '../api/types';

type Tab = 'rules' | 'groups' | 'ipsets' | 'templates';

const SCOPES: Array<{ label: string; value: FirewallScope }> = [
  { label: '虚拟机', value: 'vm' },
  { label: '节点', value: 'node' },
  { label: '集群', value: 'cluster' },
];

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
  if (rule.macro) return `宏 ${rule.macro}`;
  const proto = rule.proto || 'any';
  const port = rule.dport || 'any';
  return `${proto}/${port}`;
}

export function Firewall() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

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
    if (scope === 'cluster') return '集群规则';
    if (scope === 'node') return `${node || '节点'} 节点规则`;
    const vm = vms.find((item) => item.vmid === vmid);
    return vm ? `${vm.name}（${vm.vmid}）规则` : `虚拟机 ${vmid ?? ''} 规则`;
  }, [scope, node, vmid, vms]);

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
      toast.success(editingRule ? '规则已更新' : '规则已添加');
      setEditorOpen(false);
      setEditingRule(null);
      setEditingGroup('');
    } catch (err) {
      toast.error('保存失败', errorMessage(err));
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
      toast.success(payload.enable ? '规则已启用' : '规则已停用');
    } catch (err) {
      toast.error('操作失败', errorMessage(err));
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
      toast.error('调整顺序失败', errorMessage(err));
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
      toast.success('已删除');
      setDeleteTarget(null);
    } catch (err) {
      toast.error('删除失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const saveOptions = async (patch: FirewallOptions) => {
    setBusy(true);
    try {
      await firewallApi.saveOptions(...scopeParams, patch);
      await qc.invalidateQueries({ queryKey: ['firewall', 'options'] });
      toast.success('防火墙设置已保存');
    } catch (err) {
      toast.error('保存失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const createGroup = async () => {
    if (!groupDraft.name.trim()) {
      toast.warning('请填写安全组名称');
      return;
    }
    setBusy(true);
    try {
      await firewallApi.createGroup(groupDraft.name.trim(), groupDraft.comment.trim());
      setGroupDraft({ name: '', comment: '' });
      await groupsQuery.refetch();
      await refsQuery.refetch();
      toast.success('安全组已创建');
    } catch (err) {
      toast.error('创建失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const createIpset = async () => {
    if (!ipsetDraft.name.trim()) {
      toast.warning('请填写集合名称');
      return;
    }
    setBusy(true);
    try {
      await firewallApi.createIpset(ipsetDraft.name.trim(), ipsetDraft.comment.trim());
      setIpsetDraft({ name: '', comment: '' });
      await ipsetsQuery.refetch();
      await refsQuery.refetch();
      toast.success('IP 集合已创建');
    } catch (err) {
      toast.error('创建失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addEntry = async () => {
    if (!currentIpset || !entryDraft.cidr.trim()) {
      toast.warning('请填写 IP 或网段');
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
      toast.error('添加失败', errorMessage(err));
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
      header: '状态',
      width: 74,
      render: (rule) =>
        rule.enable ? (
          <Badge variant="success" size="sm">
            生效
          </Badge>
        ) : (
          <Badge variant="neutral" size="sm">
            停用
          </Badge>
        ),
    },
    {
      key: 'dir',
      header: '方向',
      width: 84,
      render: (rule) => (
        <span className="fs-sm">
          {rule.type === 'group' ? '安全组' : rule.type === 'out' ? '出站' : '入站'}
        </span>
      ),
    },
    {
      key: 'action',
      header: '动作',
      width: 90,
      render: (rule) => (
        <Badge variant={actionTone(rule.action)} size="sm">
          {rule.action}
        </Badge>
      ),
    },
    {
      key: 'match',
      header: '匹配',
      render: (rule) => (
        <span className="fs-sm mono">
          {rule.type === 'group' ? `+${rule.group}` : targetText(rule)}
        </span>
      ),
    },
    {
      key: 'source',
      header: '来源 → 目标',
      render: (rule) => (
        <span className="fs-xs text-muted mono">
          {rule.source || 'any'} → {rule.dest || 'any'}
        </span>
      ),
    },
    {
      key: 'log',
      header: '日志',
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
      header: '备注',
      render: (rule) => (
        <span className="fs-sm">{rule.comment || <span className="text-muted">—</span>}</span>
      ),
    },
    {
      key: 'ops',
      header: '操作',
      width: 224,
      align: 'right',
      render: (rule) => (
        <span className="row-actions">
          {canManage ? (
            <>
              {group ? null : (
                <>
                  <IconButton
                    label="上移（优先级更高）"
                    disabled={busy || rule.pos === 0}
                    onClick={() => void moveRule(rule, rule.pos - 1)}
                  >
                    <IconChevronUp size={15} />
                  </IconButton>
                  <IconButton
                    label="下移"
                    disabled={busy}
                    onClick={() => void moveRule(rule, rule.pos + 1)}
                  >
                    <IconChevronDown size={15} />
                  </IconButton>
                </>
              )}
              <IconButton
                label={rule.enable ? '停用该规则' : '启用该规则'}
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
                编辑
              </Button>
              <IconButton
                label="删除该规则"
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
            <span className="fs-xs text-muted">只读</span>
          )}
        </span>
      ),
    },
  ];

  const ipsetEntryColumns: Array<Column<{ cidr: string; comment: string; nomatch: boolean }>> = [
    { key: 'cidr', header: '地址 / 网段', mono: true, render: (e) => e.cidr },
    {
      key: 'nomatch',
      header: '取反',
      width: 80,
      render: (e) =>
        e.nomatch ? (
          <Badge variant="warning" size="sm">
            是
          </Badge>
        ) : (
          <span className="text-muted fs-xs">否</span>
        ),
    },
    { key: 'comment', header: '备注', render: (e) => e.comment || '—' },
    {
      key: 'ops',
      header: '',
      width: 64,
      align: 'right',
      render: (e) => (
        <span className="row-actions">
          {canManage ? (
            <IconButton
              label={`删除 ${e.cidr}`}
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
      header: '安全组',
      render: (g) => (
        <button
          type="button"
          className={`link-text mono ${activeGroup === g.group ? 'is-active' : ''}`}
          title="查看并编辑该安全组的规则"
          onClick={() => setActiveGroup(g.group)}
        >
          {g.group}
        </button>
      ),
    },
    { key: 'comment', header: '备注', render: (g) => g.comment || '—' },
    {
      key: 'ops',
      header: '',
      width: 64,
      align: 'right',
      render: (g) => (
        <span className="row-actions">
          {canCluster ? (
            <IconButton
              label={`删除安全组 ${g.group}`}
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
      title="防火墙"
      subtitle="Proxmox 原生防火墙：集群 / 节点 / 虚拟机规则、安全组、IP 集合与批量下发"
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
            <IconRefresh size={14} /> 刷新
          </Button>
        </div>
      }
    >
      <div className="tabs" role="tablist" aria-label="防火墙视图切换">
        {(
          [
            { key: 'rules', label: '安全策略', icon: <IconShield size={15} /> },
            { key: 'groups', label: '安全组', icon: <IconLayers size={15} /> },
            { key: 'ipsets', label: 'IP 集合', icon: <IconLock size={15} /> },
            { key: 'templates', label: '规则模板', icon: <IconPlus size={15} /> },
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
                title="防护配置"
                subtitle="先选规则作用的对象，再决定开关与默认策略"
                icon={<IconShield size={16} />}
                actions={
                  <SegmentedControl<FirewallScope>
                    value={scope}
                    onChange={(value) => setScope(value)}
                    options={SCOPES}
                    ariaLabel="选择防火墙作用域"
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
                  <span className="fw-config-key">作用对象</span>
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
                          placeholder="请选择节点"
                          aria-label="选择节点"
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
                            placeholder="请选择虚拟机"
                            aria-label="选择虚拟机 / 容器"
                          />
                        </div>
                        <span className="fw-config-note">
                          普通用户只能看到自己名下的机器
                        </span>
                      </>
                    ) : null}

                    {scope === 'cluster' ? (
                      <span className="fw-config-note">
                        集群级：规则对所有宿主机生效
                      </span>
                    ) : null}
                  </div>
                </div>

                {scope === 'cluster' && !canCluster ? (
                  <Notice tone="info">
                    集群级规则影响所有主机，需要 firewall.cluster 权限：你可以查看，但不能修改。
                  </Notice>
                ) : null}

                {optionsQuery.isError ? (
                  <Notice tone="warning" title="读不到防火墙设置">
                    {errorMessage(optionsQuery.error)}
                  </Notice>
                ) : (
                  <>
                    <div className="fw-config-row">
                      <span className="fw-config-key">防火墙</span>
                      <div className="fw-config-val">
                        <Switch
                          checked={Boolean(options.enable)}
                          disabled={!writable || busy}
                          onChange={(v) => void saveOptions({ enable: v })}
                          ariaLabel="启用防火墙"
                        />
                        <span className="fw-config-note">
                          {options.enable
                            ? '已启用，下面的规则正在生效'
                            : '未启用时下面的规则都不会生效'}
                        </span>
                      </div>
                    </div>

                    <div className="fw-config-row">
                      <span className="fw-config-key">默认策略</span>
                      <div className="fw-config-val">
                        <span className="fw-config-note">入站</span>
                        <Select
                          value={options.policy_in ?? 'DROP'}
                          disabled={!writable || busy}
                          onChange={(e) => void saveOptions({ policy_in: e.target.value })}
                          options={ACTIONS.map((a) => ({ label: a, value: a }))}
                          aria-label="入站默认策略"
                        />
                        <span className="fw-config-note">出站</span>
                        <Select
                          value={options.policy_out ?? 'ACCEPT'}
                          disabled={!writable || busy}
                          onChange={(e) => void saveOptions({ policy_out: e.target.value })}
                          options={ACTIONS.map((a) => ({ label: a, value: a }))}
                          aria-label="出站默认策略"
                        />
                        <span className="fw-config-note">没有命中任何规则时的动作</span>
                      </div>
                    </div>

                    {scope === 'vm' ? (
                      <div className="fw-config-row">
                        <span className="fw-config-key">地址过滤</span>
                        <div className="fw-config-val">
                          <Switch
                            checked={Boolean(options.ipfilter)}
                            disabled={!writable || busy}
                            onChange={(v) => void saveOptions({ ipfilter: v })}
                            ariaLabel="按规则过滤虚拟机的源 IP，防地址伪造"
                          />
                          <span className="fw-config-note">IP 过滤</span>
                          <Switch
                            checked={Boolean(options.macfilter)}
                            disabled={!writable || busy}
                            onChange={(v) => void saveOptions({ macfilter: v })}
                            ariaLabel="按规则过滤虚拟机的源 MAC，防地址伪造"
                          />
                          <span className="fw-config-note">MAC 过滤</span>
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </Card>

            <Card collapsible={false}>
              <CardHeader
                title={`规则（${rules.length}）`}
                subtitle={
                  rulesQuery.isLoading
                    ? scopeLabel
                    : `${scopeLabel} · 生效 ${enabledCount} / ${rules.length}`
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
                      <IconPlus size={14} /> 新增规则
                    </Button>
                  ) : null
                }
              />

              {rulesQuery.isError ? (
                <Notice tone="warning" title="规则加载失败">
                  {errorMessage(rulesQuery.error)}
                </Notice>
              ) : (
                <Table
                  caption="防火墙规则"
                  rows={rules}
                  columns={ruleColumns('')}
                  rowKey={(rule) => String(rule.pos)}
                  loading={rulesQuery.isLoading}
                  emptyTitle="还没有规则"
                  emptyDescription="默认策略已经生效，需要放行特定端口时再加规则"
                />
              )}
            </Card>
          </>
        ) : null}

        {tab === 'groups' ? (
          <>
            <Card collapsible={false}>
              <CardHeader
                title="安全组"
                subtitle="集群级规则集合，可被任意虚拟机 / 节点引用"
                icon={<IconLayers size={16} />}
              />
              <Table
                caption="安全组列表"
                rows={groups}
                columns={groupColumns}
                rowKey={(g) => g.group}
                loading={groupsQuery.isLoading}
                emptyTitle="还没有安全组"
              />
              {canCluster ? (
                <div className="create-bar">
                  <div className="field-row">
                    <Field label="新建安全组" required hint="字母开头，最长 18 位">
                      <Input
                        value={groupDraft.name}
                        onChange={(e) => setGroupDraft({ ...groupDraft, name: e.target.value })}
                        placeholder="web"
                        mono
                      />
                    </Field>
                    <Field label="备注">
                      <Input
                        value={groupDraft.comment}
                        onChange={(e) =>
                          setGroupDraft({ ...groupDraft, comment: e.target.value })
                        }
                        placeholder="Web 前段通用规则"
                      />
                    </Field>
                    <Button
                      variant="primary"
                      loading={busy}
                      onClick={() => void createGroup()}
                    >
                      <IconPlus size={14} /> 创建
                    </Button>
                  </div>
                </div>
              ) : null}
            </Card>

            <Card collapsible={false}>
              <CardHeader
                title={activeGroup ? `组内规则：${activeGroup}` : '组内规则'}
                subtitle={activeGroup ? '在别处被引用后即生效' : '先在上面点一个安全组'}
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
                      <IconPlus size={14} /> 新增规则
                    </Button>
                  ) : null
                }
              />
              {activeGroup ? (
                <Table
                  caption="安全组规则"
                  rows={groupRules}
                  columns={ruleColumns(activeGroup)}
                  rowKey={(rule) => String(rule.pos)}
                  loading={groupRulesQuery.isLoading}
                  emptyTitle="这个安全组还没有规则"
                />
              ) : (
                <div className="fw-placeholder">
                  在上面的列表里点一个安全组名，即可查看并编辑它的规则。
                </div>
              )}
            </Card>
          </>
        ) : null}

        {tab === 'ipsets' ? (
          <>
            <Card collapsible={false}>
              <CardHeader
                title="IP 集合"
                subtitle="一组可复用的地址段，规则里用 +集合名 引用"
                icon={<IconLock size={16} />}
              />
              <Table
                caption="IP 集合列表"
                rows={ipsets}
                columns={[
                  {
                    key: 'name',
                    header: '名称',
                    render: (item: FirewallIpset) => (
                      <button
                        type="button"
                        className={`link-text mono ${
                          activeIpset === item.name ? 'is-active' : ''
                        }`}
                        title="查看并编辑该集合的条目"
                        onClick={() => setActiveIpset(item.name)}
                      >
                        {item.name}
                      </button>
                    ),
                  },
                  {
                    key: 'count',
                    header: '条目',
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
                    header: '备注',
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
                            label={`删除 IP 集合 ${item.name}`}
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
                emptyTitle="还没有 IP 集合"
              />

              {canCluster ? (
                <div className="create-bar">
                  <div className="field-row">
                    <Field label="新建集合" required hint="字母开头，最长 18 位">
                      <Input
                        value={ipsetDraft.name}
                        onChange={(e) => setIpsetDraft({ ...ipsetDraft, name: e.target.value })}
                        placeholder="office"
                        mono
                      />
                    </Field>
                    <Field label="备注">
                      <Input
                        value={ipsetDraft.comment}
                        onChange={(e) =>
                          setIpsetDraft({ ...ipsetDraft, comment: e.target.value })
                        }
                        placeholder="办公网段"
                      />
                    </Field>
                    <Button
                      variant="primary"
                      loading={busy}
                      onClick={() => void createIpset()}
                    >
                      <IconPlus size={14} /> 创建
                    </Button>
                  </div>
                </div>
              ) : null}
            </Card>

            {currentIpset ? (
              <Card collapsible={false}>
                <CardHeader
                  title={`集合条目：${currentIpset.name}`}
                  subtitle="支持单个 IP、CIDR 网段，备注可写用途"
                  icon={<IconLock size={16} />}
                />
                <Table
                  caption="IP 集合条目"
                  rows={currentIpset.entries}
                  columns={ipsetEntryColumns}
                  rowKey={(entry) => entry.cidr}
                  emptyTitle="还没有条目"
                />
                {canManage ? (
                  <div className="create-bar">
                    <div className="field-row">
                      <Field label="地址 / 网段" required>
                        <Input
                          value={entryDraft.cidr}
                          onChange={(e) =>
                            setEntryDraft({ ...entryDraft, cidr: e.target.value })
                          }
                          placeholder="10.8.0.0/16"
                          mono
                        />
                      </Field>
                      <Field label="备注">
                        <Input
                          value={entryDraft.comment}
                          onChange={(e) =>
                            setEntryDraft({ ...entryDraft, comment: e.target.value })
                          }
                          placeholder="总部"
                        />
                      </Field>
                      <Button
                        variant="primary"
                        loading={busy}
                        onClick={() => void addEntry()}
                      >
                        <IconPlus size={14} /> 添加
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
        title="确认删除"
        message={
          deleteTarget?.kind === 'rule' || deleteTarget?.kind === 'group-rule'
            ? `确定删除规则 #${deleteTarget?.pos}？`
            : `确定删除「${deleteTarget?.name ?? ''}」？引用了它的规则会失效。`
        }
        danger
        loading={busy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void removeRule()}
      />
    </PageShell>
  );
}
