/* ==========================================================================
   IP 地址池管理（网络页）

   不依赖 DHCP / SDN：池只是一段「子网 + 可分配范围」，面板扫描各虚拟机
   的静态配置得出已占用地址，创建 / 克隆虚拟机时把空闲地址作为下拉选项。
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { connectionsApi, ipPoolsApi, nodesApi, usersApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Card, CardHeader } from './ui/Card';
import { Button, IconButton } from './ui/Button';
import { Checkbox, Input } from './ui/Input';
import { Modal } from './ui/Modal';
import { Notice } from './ui/EmptyState';
import { Badge } from './ui/Badge';
import {
  IconPlus,
  IconTrash,
  IconSave,
  IconNetwork,
  IconSearch,
  IconChevronDown,
} from './Icons';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n';
import { poolScopeLabel } from '../utils/ippool';
import type { IpPool } from '../api/types';

function newPool(): IpPool {
  return {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    name: '',
    bridge: 'vmbr0',
    subnet: '',
    gateway: '',
    start: '',
    end: '',
    dns: '',
    /* 新池默认不限节点、不限 PVE、不限 VLAN：多数场景下这个网段到处都通，
       限定了反而要用户先去查集群拓扑 */
    nodes: [],
    connections: [],
    vlan: null,
    /* 新池默认是「公共池」：只有管理员看得到、也只有管理员能用。要分给某个用户，
       得显式选一个归属 */
    owner: '',
  };
}

/* ---------------------------------------------------------------------------
   适用范围：PVE → 节点 的两级树
   ---------------------------------------------------------------------------
   节点必须挂在它所属的 PVE 下面 —— 一份平铺的节点名单在多套 PVE 上根本分不开
   同名节点，勾了也不知道勾的是哪台机器上的那一个。

   勾选状态与 ``utils/ippool.poolFits`` 的判定**完全一致**：连接与节点两个维度
   都是「空 = 不限」，任一维度不允许就排除。于是树里看到的，就是下发时会发生的事。

   写回时做两件事：
   1. 任何一次点击都先把当前范围物化成显式清单（materialize），在清单上增删 ——
      否则在「不限」的前提下「取消勾选某一个」无从表达（那等于「除了它之外的
      所有节点」，得先把清单列出来）。
   2. 全勾回去又写回空数组（= 不限）。这既保住「以后新增的节点自动纳入」这个
      语义，也避免老数据里「空 = 该 PVE 的全部节点」的写法因为打开一次弹窗就被
      悄悄改成一份快照。
   --------------------------------------------------------------------------- */
interface ScopeGroup {
  /** 连接 id（'' = 后端未标注连接） */
  id: string;
  /** 连接显示名 */
  label: string;
  /** 该连接下的节点名（已排序） */
  nodes: string[];
}

interface ScopeTreeProps {
  groups: ScopeGroup[];
  /** 当前允许的 PVE 连接 id；空 = 不限 */
  connections: string[];
  /** 当前允许的节点名；空 = 不限 */
  nodes: string[];
  onChange: (next: { connections: string[]; nodes: string[] }) => void;
}

/** 超过这么多节点才给过滤框：三五个时它比直接勾还慢 */
const SCOPE_FILTER_THRESHOLD = 8;

function ScopeTree({ groups, connections, nodes, onChange }: ScopeTreeProps) {
  const t = useT();
  const [keyword, setKeyword] = useState('');
  /* 收起来的 PVE 分组（默认全部展开：先让节点可见，太长再按需收） */
  const [collapsed, setCollapsed] = useState<string[]>([]);

  const isChecked = (groupId: string, nodeName: string) =>
    (connections.length === 0 || connections.includes(groupId)) &&
    (nodes.length === 0 || nodes.includes(nodeName));

  /* 把「空 = 不限」展开成显式清单 */
  const materialize = () => {
    const connList: string[] = [];
    const nameList: string[] = [];
    for (const group of groups) {
      for (const nodeName of group.nodes) {
        if (!isChecked(group.id, nodeName)) continue;
        if (!connList.includes(group.id)) connList.push(group.id);
        if (!nameList.includes(nodeName)) nameList.push(nodeName);
      }
    }
    return { connList, nameList };
  };

  const commit = (connList: string[], nameList: string[]) => {
    /* 只留下确实还有被勾选节点的组：一个空组留在 connections 里，会让这个池在
       那台 PVE 上仍然算「部分适用」，而实际已经没有任何节点在列 */
    const liveConn = connList.filter((id) =>
      (groups.find((g) => g.id === id)?.nodes ?? []).some((name) =>
        nameList.includes(name),
      ),
    );

    const coversAll =
      groups.length > 0 &&
      groups.every(
        (g) =>
          liveConn.includes(g.id) &&
          g.nodes.every((name) => nameList.includes(name)),
      );
    /* 全勾 与 一个都不勾 都写回空数组 = 不限（与改动前同一语义，文案里已交代） */
    if (coversAll || nameList.length === 0) {
      onChange({ connections: [], nodes: [] });
      return;
    }
    onChange({ connections: liveConn, nodes: nameList });
  };

  const toggleNode = (groupId: string, nodeName: string, checked: boolean) => {
    const { connList, nameList } = materialize();
    if (checked) {
      commit(
        connList.includes(groupId) ? connList : [...connList, groupId],
        nameList.includes(nodeName) ? nameList : [...nameList, nodeName],
      );
      return;
    }
    commit(
      connList,
      nameList.filter((name) => name !== nodeName),
    );
  };

  const toggleGroup = (group: ScopeGroup, checked: boolean) => {
    const { connList, nameList } = materialize();
    if (checked) {
      commit(
        connList.includes(group.id) ? connList : [...connList, group.id],
        [...new Set([...nameList, ...group.nodes])],
      );
      return;
    }
    commit(
      connList,
      nameList.filter((name) => !group.nodes.includes(name)),
    );
  };

  const q = keyword.trim().toLowerCase();
  /* 连接名命中就整组留下（用户要找的可能是「那台 PVE 上的都有哪些节点」），
     否则只留下匹配的节点 */
  const visibleGroups = q
    ? groups
        .map((group) =>
          group.label.toLowerCase().includes(q)
            ? group
            : {
                ...group,
                nodes: group.nodes.filter((name) =>
                  name.toLowerCase().includes(q),
                ),
              },
        )
        .filter((group) => group.nodes.length > 0)
    : groups;

  const selectedCount = groups.reduce(
    (n, group) =>
      n + group.nodes.filter((name) => isChecked(group.id, name)).length,
    0,
  );
  const totalCount = groups.reduce((n, group) => n + group.nodes.length, 0);

  /* 全选 / 清空只作用于**当前筛出来的这些**：几十个节点时不先搜索收敛，
     一键全勾容易连别的 PVE 上的节点一起勾上 */
  const toggleVisible = (checked: boolean) => {
    const { connList, nameList } = materialize();
    const visibleNodes = visibleGroups.flatMap((group) => group.nodes);
    if (checked) {
      commit(
        [...new Set([...connList, ...visibleGroups.map((group) => group.id)])],
        [...new Set([...nameList, ...visibleNodes])],
      );
      return;
    }
    commit(
      connList,
      nameList.filter((name) => !visibleNodes.includes(name)),
    );
  };

  return (
    <section className="scope-box">
      <div className="scope-box-head">
        <div className="scope-box-title">
          {t('ippool.scopeTreeTitle')}
          <Badge variant={selectedCount > 0 ? 'accent' : 'neutral'} size="sm">
            {t('ippool.scopeSelectedNodes', {
              n: selectedCount,
              total: totalCount,
            })}
          </Badge>
        </div>
        <div className="scope-box-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={visibleGroups.length === 0}
            onClick={() => toggleVisible(true)}
          >
            {t('ippool.scopeSelectAll')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={selectedCount === 0}
            onClick={() => toggleVisible(false)}
          >
            {t('ippool.scopeClear')}
          </Button>
        </div>
      </div>

      <div className="scope-box-hint">{t('ippool.scopeTreeHint')}</div>

      {groups.length === 0 ? (
        <div className="fs-sm text-muted">{t('ippool.nodesEmpty')}</div>
      ) : (
        <>
          {totalCount > SCOPE_FILTER_THRESHOLD ? (
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t('ippool.scopeSearch', { n: totalCount })}
              prefix={<IconSearch size={14} />}
              aria-label={t('ippool.scopeSearch', { n: totalCount })}
              block={false}
            />
          ) : null}
          <div className="scope-scroll">
            {visibleGroups.length === 0 ? (
              <div className="fs-sm text-muted">{t('ippool.scopeNoMatch')}</div>
            ) : (
              <div className="scope-tree">
                {visibleGroups.map((group) => {
                  const picked = group.nodes.filter((name) =>
                    isChecked(group.id, name),
                  ).length;
                  const open = !collapsed.includes(group.id);
                  return (
                    <div
                      className="scope-tree-group"
                      key={group.id || 'default'}
                    >
                      <div className="scope-tree-head">
                        <button
                          type="button"
                          className="scope-tree-toggle"
                          aria-expanded={open}
                          aria-label={
                            open
                              ? t('ippool.scopeCollapse', { name: group.label })
                              : t('ippool.scopeExpand', { name: group.label })
                          }
                          onClick={() =>
                            setCollapsed((list) =>
                              list.includes(group.id)
                                ? list.filter((value) => value !== group.id)
                                : [...list, group.id],
                            )
                          }
                        >
                          <IconChevronDown size={14} />
                        </button>
                        <Checkbox
                          checked={
                            group.nodes.length > 0 &&
                            picked === group.nodes.length
                          }
                          indeterminate={
                            picked > 0 && picked < group.nodes.length
                          }
                          label={group.label}
                          onChange={(e) =>
                            toggleGroup(group, e.target.checked)
                          }
                        />
                        <span className="scope-tree-count">
                          {picked}/{group.nodes.length}
                        </span>
                      </div>

                      {open ? (
                        <div className="chk-grid scope-tree-nodes">
                          {group.nodes.map((name) => (
                            <Checkbox
                              key={name}
                              checked={isChecked(group.id, name)}
                              label={name}
                              onChange={(e) =>
                                toggleNode(group.id, name, e.target.checked)
                              }
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function IpPoolPanel() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  /* 地址池保存在后端、写入走 network.manage（仅管理员），界面沿用同一判定 */
  const { hasPermission } = useAuth();
  const canManageNet = hasPermission('network.manage');
  // 直接用数组而不是 null，避免接口暂时不可用时连「添加池」都点不了。
  const [pools, setPools] = useState<IpPool[]>([]);
  const [busy, setBusy] = useState(false);
  /* 正在编辑「适用节点」的池下标（null = 没打开选择弹层） */
  const [nodeEdit, setNodeEdit] = useState<number | null>(null);
  const loadedRef = useRef(false);

  const query = useQuery({
    queryKey: ['ip-pools'],
    queryFn: ipPoolsApi.get,
    staleTime: 30_000,
    retry: false,
  });

  /* 集群里的节点名清单（去重排序），给「适用节点」用 */
  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: () => nodesApi.list(),
    staleTime: 60_000,
    retry: false,
  });
  /* 已保存的 PVE 连接：多套 PVE 上「同名节点」是常态，池要靠它区分是哪一台，
     展示时也把连接 id 换成可读的名称 */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    staleTime: 60_000,
    retry: false,
  });
  const connections = useMemo(
    () => connectionsQuery.data ?? [],
    [connectionsQuery.data],
  );
  /* 归属用户的候选名单：只有改得了池的人（管理员）才拉得动 /users —— 普通用户是
     只读视图，既用不到这份名单，也不该白吃一个 403 */
  const usersQuery = useQuery({
    queryKey: ['users', 'ip-pool-owner'],
    queryFn: () => usersApi.list(),
    enabled: canManageNet,
    staleTime: 300_000,
    retry: false,
  });
  /* admin 不进候选：管理员看的是全部池，「公共池」那一档就是给他自己用的 */
  const ownerOptions = useMemo(
    () =>
      (usersQuery.data ?? [])
        .map((u) => u.username)
        .filter((name) => name && name !== 'admin')
        .sort(),
    [usersQuery.data],
  );
  const connNameOf = useCallback(
    (id: string) => {
      const hit = connections.find((item) => String(item.id) === id);
      return String(hit?.name || hit?.host || id);
    },
    [connections],
  );

  /* 适用范围里的两级树：PVE → 它下面的节点。节点必须**按连接归类** —— 一份全局
     去重的节点名单在多套 PVE 上根本分不开同名节点，勾了也不知道勾的是哪台机器
     上的那一个（而池的判定恰恰是「连接 + 节点名」两个维度）。 */
  const scopeGroups = useMemo(() => {
    const byConn = new Map<string, string[]>();
    for (const item of nodesQuery.data ?? []) {
      const id = String(item.connection_id ?? '');
      const name = String(item.node || '');
      if (!name) continue;
      const list = byConn.get(id) ?? [];
      if (!list.includes(name)) list.push(name);
      byConn.set(id, list);
    }
    return [...byConn.entries()]
      .map(([id, list]) => ({
        id,
        /* 没有连接 id 的节点（后端未标注）归到一个兜底组，标签用 — 占位 */
        label: id ? connNameOf(id) : '—',
        nodes: [...list].sort(),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [nodesQuery.data, connNameOf]);

  useEffect(() => {
    if (!query.data || loadedRef.current) return;
    loadedRef.current = true;
    setPools(
      (query.data.pools ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        bridge: p.bridge,
        subnet: p.subnet,
        gateway: p.gateway,
        start: p.start,
        end: p.end,
        dns: p.dns,
        /* 这两项必须一起映射：漏了它们，保存时会把已经配好的适用范围抹掉
           （保存发的是整份 pools，字段缺了就是空） */
        nodes: p.nodes ?? [],
        connections: p.connections ?? [],
        vlan: p.vlan ?? null,
        /* 同样必须一起映射：保存发的是整份池，漏了 owner 就等于把池改回公共池，
           已经分给客户的地址会被收回去 */
        owner: p.owner ?? '',
      })),
    );
  }, [query.data]);

  const freeOf = (id: string): number =>
    (query.data?.pools ?? []).find((p) => p.id === id)?.free_count ?? 0;

  function patch(index: number, next: Partial<IpPool>) {
    setPools((list) =>
      list ? list.map((p, i) => (i === index ? { ...p, ...next } : p)) : list,
    );
  }

  async function save() {
    setBusy(true);
    try {
      await ipPoolsApi.save(pools);
      await qc.invalidateQueries({ queryKey: ['ip-pools'] });
      toast.success(
        t('ippool.saved'),
        t('ippool.savedDetail', { n: pools.length }),
      );
    } catch (err) {
      toast.error(t('ippool.saveFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card collapsible={false}>
      <CardHeader
        title={t('ippool.title')}
        subtitle={t('ippool.subtitle')}
        icon={<IconNetwork size={16} />}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={<IconPlus size={14} />}
              disabled={!canManageNet}
              onClick={() => setPools([...pools, newPool()])}
            >
              {t('ippool.addPool')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy}
              disabled={!canManageNet}
              onClick={() => void save()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      />

      {!canManageNet ? (
        <Notice tone="info" title={t('ippool.readonlyTitle')}>
          {t('ippool.readonlyBody')}
        </Notice>
      ) : null}

      <Notice tone="info" title={t('ippool.howTitle')}>
        {t('ippool.howPre')}
        <b>{t('ippool.howBold1')}</b>
        {t('ippool.howMid')}
        <b>{t('ippool.howBold2')}</b>
        {t('ippool.howPost')}
      </Notice>

      {query.isError ? (
        <Notice tone="warning" title={t('ippool.apiTitle')}>
          {t('ippool.apiPre')}
          {errorMessage(query.error)}
          {t('ippool.apiMid')}
          <b>{t('ippool.apiBold')}</b>
          {t('ippool.apiMid2')}
          <code>/api/ip-pools</code>
          {t('ippool.apiPost')}
        </Notice>
      ) : null}

      {pools.length > 0 ? (
        <div className="table-container">
          <table className="table table-dense">
            <thead>
              <tr>
                <th>{t('ippool.colName')}</th>
                {/* 归属列只对管理员有意义：普通用户看到的本来就只有自己的池 */}
                {canManageNet ? <th>{t('ippool.colOwner')}</th> : null}
                <th>{t('ippool.colBridge')}</th>
                <th>{t('ippool.colVlan')}</th>
                <th>{t('ippool.colScope')}</th>
                <th>{t('ippool.colSubnet')}</th>
                <th>{t('ippool.colGateway')}</th>
                <th>{t('ippool.colStart')}</th>
                <th>{t('ippool.colEnd')}</th>
                <th>DNS</th>
                <th>{t('ippool.colFree')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pools.map((p, i) => (
                <tr key={p.id}>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.name}
                        placeholder={t('ippool.namePlaceholder')}
                        onChange={(e) => patch(i, { name: e.target.value })}
                      />
                    </div>
                  </td>
                  {canManageNet ? (
                    <td>
                      {/* 把这套地址分给谁：普通用户登录后只列得出归属是自己的池，
                          在创建虚拟机 / 加网卡时也就只能从自己的池里取地址 */}
                      <select
                        className="select"
                        value={p.owner ?? ''}
                        onChange={(e) => patch(i, { owner: e.target.value })}
                      >
                        <option value="">{t('ippool.ownerPublic')}</option>
                        {/* 当前归属的用户可能已被删除（或列表还没拉回来）：把他并进
                            选项里，否则下拉会显示成「公共」，一保存就把池收走了 */}
                        {[p.owner, ...ownerOptions]
                          .filter(
                            (name, idx, arr) => name && arr.indexOf(name) === idx,
                          )
                          .map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                      </select>
                    </td>
                  ) : null}
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.bridge}
                        placeholder="vmbr0"
                        onChange={(e) => patch(i, { bridge: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    {/* VLAN 标签：同一个网桥上可以挂多个网段（tag=100 是
                        192.168.1.0/24、tag=200 是 10.0.0.0/24），只记网桥分不清池
                        属于哪一个。留空 = 不限；填了就必须是 1~4094 的整数，其余
                        输入直接忽略（免得把 PVE 不认的值带到下发里）。 */}
                    <div className="input-wrap">
                      <input
                        className="input"
                        type="number"
                        min={1}
                        max={4094}
                        value={p.vlan ?? ''}
                        placeholder={t('ippool.vlanPlaceholder')}
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          if (!raw) {
                            patch(i, { vlan: null });
                            return;
                          }
                          const tag = Number(raw);
                          if (Number.isInteger(tag) && tag >= 1 && tag <= 4094) {
                            patch(i, { vlan: tag });
                          }
                        }}
                      />
                    </div>
                  </td>
                  <td>
                    {/* 适用范围：哪台 PVE 上的哪些节点 —— 两项都可以不限定
                        （= 到处都能用），点开弹层勾选 */}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canManageNet}
                      onClick={() => setNodeEdit(i)}
                      title={t('ippool.nodesEditTitle')}
                    >
                      {poolScopeLabel(p, {
                        anyPve: t('ippool.scopeAnyPve'),
                        anyNode: t('ippool.scopeAnyNode'),
                        connName: connNameOf,
                      })}
                    </Button>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.subnet}
                        placeholder="192.168.1.0/24"
                        onChange={(e) => patch(i, { subnet: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.gateway}
                        placeholder="192.168.1.1"
                        onChange={(e) => patch(i, { gateway: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.start}
                        placeholder="192.168.1.100"
                        onChange={(e) => patch(i, { start: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.end}
                        placeholder="192.168.1.200"
                        onChange={(e) => patch(i, { end: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.dns}
                        placeholder={t('ippool.dnsPlaceholder')}
                        onChange={(e) => patch(i, { dns: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <Badge variant={freeOf(p.id) > 0 ? 'success' : 'warning'} size="sm">
                      {t('ippool.freeCount', { n: freeOf(p.id) })}
                    </Badge>
                  </td>
                  <td>
                    <IconButton
                      label={t('ippool.deleteAria')}
                      variant="danger"
                      disabled={!canManageNet}
                      onClick={() => setPools(pools.filter((_, k) => k !== i))}
                    >
                      <IconTrash size={15} />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-secondary fs-sm">{t('ippool.empty')}</div>
      )}

      {/* 适用范围：一个池可以给多个节点用（业务网段往往在所有节点上都通），
          所以是多选而不是单选 —— 否则同网段得按节点重复建好几条。

          这里只负责把结果写回池；多列布局、区块内滚动、全选 / 清空与过滤都在
          ScopeChecklist 里，两个区块的交互因此完全一致。 */}
      <Modal
        open={nodeEdit !== null}
        onClose={() => setNodeEdit(null)}
        title={t('ippool.scopeTitle', {
          name:
            nodeEdit !== null
              ? pools[nodeEdit]?.name || pools[nodeEdit]?.subnet || ''
              : '',
        })}
        size="md"
        footer={
          <Button variant="primary" onClick={() => setNodeEdit(null)}>
            {t('common.confirm')}
          </Button>
        }
      >
        <ScopeTree
          groups={scopeGroups}
          connections={nodeEdit !== null ? pools[nodeEdit]?.connections ?? [] : []}
          nodes={nodeEdit !== null ? pools[nodeEdit]?.nodes ?? [] : []}
          onChange={({ connections: conns, nodes: names }) => {
            if (nodeEdit === null) return;
            /* 两个维度必须一起写：树里的勾选是「连接 + 节点」的组合，分两次
               patch 中间会出现一个语义不同的瞬时状态（例如 connections 先写成
               空数组，那一瞬就成了「所有 PVE 都不限」） */
            patch(nodeEdit, { connections: conns, nodes: names });
          }}
        />
      </Modal>
    </Card>
  );
}
