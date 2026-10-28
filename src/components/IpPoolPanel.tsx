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
import { Checkbox, Input, RadioGroup } from './ui/Input';
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
import { PagerBar, usePaged } from '../hooks/usePaged';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n';
import {
  POOL_OWNER_ALL,
  poolOwnerIsAll,
  poolOwnerIsPublic,
  poolOwnersOf,
  poolScopeLabel,
} from '../utils/ippool';
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
    /* 新池默认是「公共池」：只有管理员看得到、也只有管理员能用。要分给谁得显式
       勾选（可以勾多个用户，也可以勾「全部用户」） */
    owners: [],
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

/* ---------------------------------------------------------------------------
   归属用户：先选「方式」，再在「指定用户」里勾人
   ---------------------------------------------------------------------------
   一个池可以只给管理员（公共池）、给全部用户，或者只给指定的几个用户 —— 这三种
   情况都落在同一份名单上，但**不能靠名单的形状去猜**：「空名单」既可能被读成
   「谁都别用」，也可能被读成「谁都能用」。所以这里先让用户显式选方式，再在
   「指定用户」那一档里勾人（与「适用范围」同一套骨架：标题行 + 全选 / 清空 +
   搜索 + 勾选栅格 + 已选计数，同一张表格里两列的操作习惯不该有两种）。

   改归属是**破坏性**的：把池从某人名下拿掉，他下次创建虚拟机就再也选不到这个
   网段。所以候选里始终带着当前名单里的名字（哪怕账号已被删除），不会因为打开
   一次弹窗、顺手一存就把一个归属弄丢。
   --------------------------------------------------------------------------- */
interface OwnerPickerProps {
  /** 候选用户名（不含 admin，已排序） */
  users: string[];
  /** 当前归属名单（见 utils/ippool 的约定） */
  value: string[];
  onChange: (next: string[]) => void;
}

/** 归属方式：三种取值与 utils/ippool 的存储约定一一对应 */
type OwnerMode = 'public' | 'all' | 'some';

/** 超过这么多用户才给搜索框：三五个时它比直接勾还慢 */
const OWNER_FILTER_THRESHOLD = 8;

/** 从名单反推归属方式（弹层刚打开时用） */
function deriveOwnerMode(value: string[]): OwnerMode {
  if (poolOwnerIsAll({ owners: value })) return 'all';
  return poolOwnerIsPublic({ owners: value }) ? 'public' : 'some';
}

function OwnerPicker({ users, value, onChange }: OwnerPickerProps) {
  const t = useT();
  const [keyword, setKeyword] = useState('');
  /* 方式存本地状态，而不是每次按名单反推：名单为空时「指定用户」与「公共池」在
     存储里是**同一个值**（空名单），只按存储反推的话，一点「指定用户」就会立刻
     跳回「公共」—— 勾上第一个人时存储才真的变 */
  const [mode, setModeState] = useState<OwnerMode>(() => deriveOwnerMode(value));

  /* 「指定用户」这一档实际勾了谁 */
  const picked = poolOwnersOf({ owners: value });
  /* 账号已被删除的名字也要留在候选里：列不出来就等于「顺手一存把他抹掉」 */
  const names = [...new Set([...picked, ...users])].sort((a, b) =>
    a.localeCompare(b),
  );
  const q = keyword.trim().toLowerCase();
  const visible = q
    ? names.filter((name) => name.toLowerCase().includes(q))
    : names;
  /* 只有「指定用户」这一档能勾人 */
  const assignable = mode === 'some';

  const setMode = (next: OwnerMode) => {
    setModeState(next);
    if (next === 'public') {
      onChange([]);
      return;
    }
    if (next === 'all') {
      onChange([POOL_OWNER_ALL]);
      return;
    }
    /* 切到「指定用户」时把「全部用户」那一项丢掉：留着它等于还是全部用户，勾谁
       都没有意义。之前勾过的人原样保留 */
    onChange(picked);
  };

  const toggleUser = (name: string, checked: boolean) => {
    onChange(
      checked ? [...picked, name] : picked.filter((item) => item !== name),
    );
  };

  /* 全选 / 清空只作用于**搜出来的这些**：几十个账号时不先搜索收敛，一键全选
     容易把不想给的人也勾上 */
  const toggleVisible = (checked: boolean) => {
    if (checked) {
      onChange([...new Set([...picked, ...visible])]);
      return;
    }
    const drop = new Set(visible);
    onChange(picked.filter((name) => !drop.has(name)));
  };

  return (
    <>
      <div className="scope-box">
        <RadioGroup
          name="ippool-owner-mode"
          value={mode}
          onChange={(next) => setMode(next as OwnerMode)}
          vertical
          label={t('ippool.ownerModeLabel')}
          options={[
            {
              value: 'public',
              label: t('ippool.ownerPublic'),
              hint: t('ippool.ownerPublicHint'),
            },
            {
              value: 'all',
              label: t('ippool.ownerAll'),
              hint: t('ippool.ownerAllHint'),
            },
            {
              value: 'some',
              label: t('ippool.ownerSome'),
              hint: t('ippool.ownerSomeHint'),
            },
          ]}
        />
      </div>

      <div className="scope-box">
        <div className="scope-box-head">
          <div className="scope-box-title">
            {t('ippool.ownerListTitle')}
            {/* 徽标跟着当前方式走：只勾了「全部用户」时写「已选 0 个」会被读成
                「一个都没给」，而那恰恰是"谁都能用" */}
            <Badge
              variant={assignable && picked.length === 0 ? 'neutral' : 'accent'}
              size="sm"
            >
              {assignable
                ? t('ippool.ownerSelected', { n: picked.length })
                : mode === 'all'
                  ? t('ippool.ownerAll')
                  : t('ippool.ownerPublic')}
            </Badge>
          </div>
          <div className="scope-box-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={!assignable || visible.length === 0}
              onClick={() => toggleVisible(true)}
            >
              {t('ippool.scopeSelectAll')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!assignable || picked.length === 0}
              onClick={() => toggleVisible(false)}
            >
              {t('ippool.scopeClear')}
            </Button>
          </div>
        </div>

        {names.length === 0 ? (
          <div className="fs-sm text-muted">{t('ippool.ownerNoUsers')}</div>
        ) : (
          <>
            {names.length > OWNER_FILTER_THRESHOLD ? (
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder={t('ippool.ownerSearch', { n: names.length })}
                prefix={<IconSearch size={14} />}
                aria-label={t('ippool.ownerSearch', { n: names.length })}
                block={false}
              />
            ) : null}
            <div className="scope-scroll">
              {visible.length === 0 ? (
                <div className="fs-sm text-muted">{t('ippool.scopeNoMatch')}</div>
              ) : (
                <div className="chk-grid">
                  {visible.map((name) => (
                    <Checkbox
                      key={name}
                      checked={picked.includes(name)}
                      disabled={!assignable}
                      label={name}
                      onChange={(e) => toggleUser(name, e.target.checked)}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

export function IpPoolPanel() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  /* 地址池保存在后端、写入走 network.manage（仅管理员），界面沿用同一判定 */
  const { hasPermission, user } = useAuth();
  const canManageNet = hasPermission('network.manage');
  /* 新增 / 删除「别人也能看到」的池、改归属用户，只有管理员能做：后端按归属合并写
     （见 routers/ip_pools.py 的 _merge_for_scope），普通用户即使被授予
     network.manage 也只能改分给自己的那几行。 */
  const canAssign = canManageNet && user?.role === 'admin';
  // 直接用数组而不是 null，避免接口暂时不可用时连「添加池」都点不了。
  const [pools, setPools] = useState<IpPool[]>([]);
  const [busy, setBusy] = useState(false);
  /* 正在编辑「适用节点」的池 id（null = 没打开选择弹层）。
     存 id 而不是下标：表格分页后下标只在「当前这一页」里成立，拿它回查会改错行 */
  const [nodeEdit, setNodeEdit] = useState<string | null>(null);
  /* 正在编辑「归属用户」的池 id（同样存 id 不存下标，理由同上） */
  const [ownerEdit, setOwnerEdit] = useState<string | null>(null);
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
        /* 同样必须一起映射：保存发的是整份池，漏了 owners 就等于把池改回公共池，
           已经分给客户的地址会被收回去 */
        owners: p.owners ?? [],
      })),
    );
  }, [query.data]);

  const freeOf = (id: string): number =>
    (query.data?.pools ?? []).find((p) => p.id === id)?.free_count ?? 0;

  /* 后端还是升级前的版本：它返回的是单值 owner，不认识 owners。
     这种「前端换了、服务没重启」的错位必须自己认出来 —— 旧模型把 owners 当未知
     字段吞掉、owner 落成空串，**一次保存就把所有池收成公共池**，而界面上毫无提示
     （现象是「指定了归属、保存了，但没生效」，能查很久）。判据用响应的形状而不是
     版本号：新后端出的每个池一定带 owners，旧后端一定带 owner。 */
  const legacyBackend = useMemo(
    () =>
      (query.data?.pools ?? []).some((pool) => {
        const row = pool as unknown as { owners?: string[]; owner?: string };
        return row.owners === undefined && row.owner !== undefined;
      }),
    [query.data],
  );

  /* 定位用 id 而不是下标：表格分页后渲染的只是当前这一页，下标是**页内**的，
     用它去改 state 会改到别的行上（改第 2 页的第一行，动的却是第 1 页的第一条） */
  function patch(id: string, next: Partial<IpPool>) {
    setPools((list) => list.map((p) => (p.id === id ? { ...p, ...next } : p)));
  }

  /* 池没有数量上限，而每行都带一排输入框（一屏放不下几行），所以和别的列表一样
     分页：页码越界由 hook 夹住，每页条数走分页条上的下拉。
     resetKey 给个固定值即可 —— 这一栏没有搜索 / 筛选，换个页码不改变数据的含义 */
  const poolPage = usePaged(pools, 'ip-pools');

  /* 正在编辑适用范围的那条池：弹层要按 id 现查，而不是把池对象存进 state
     （存对象的话，弹层开着时在表格里改别的字段，弹层里那份就是旧值） */
  const editing = nodeEdit
    ? pools.find((p) => p.id === nodeEdit) ?? null
    : null;

  /* 正在编辑归属的那条池（同样按 id 现查） */
  const editingOwner = ownerEdit
    ? pools.find((p) => p.id === ownerEdit) ?? null
    : null;

  /* 归属列的摘要：管理员扫一眼要能看出「这条池谁能用」。多个用户时只给个数，
     完整名单挂在按钮的 title 上 —— 表格里铺不下三五个用户名 */
  function ownerSummary(pool: IpPool): string {
    if (poolOwnerIsAll(pool)) return t('ippool.ownerAll');
    if (poolOwnerIsPublic(pool)) return t('ippool.ownerPublic');
    const names = poolOwnersOf(pool);
    return names.length === 1
      ? names[0]
      : t('ippool.ownerCount', { n: names.length });
  }

  function ownerTooltip(pool: IpPool): string {
    return poolOwnersOf(pool).join('、');
  }

  function addPool() {
    const next = [...pools, newPool()];
    setPools(next);
    /* 新池追加在末尾：不分页时它就在眼前，分页后却可能落在最后一页 —— 不跳过去
       的话，点了「添加池」屏幕上看不到任何变化，像是按钮坏了 */
    poolPage.setPage(Math.max(1, Math.ceil(next.length / poolPage.pageSize)));
  }

  async function save() {
    if (legacyBackend) {
      /* 按钮本身是禁用的，这里再挡一次：回车 / 脚本触发也得挡 */
      toast.error(
        t('ippool.legacyBackendTitle'),
        t('ippool.legacyBackendBody'),
      );
      return;
    }
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
              disabled={!canAssign}
              onClick={addPool}
            >
              {t('ippool.addPool')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy}
              disabled={!canManageNet || legacyBackend}
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

      {canManageNet && !canAssign ? (
        <Notice tone="info" title={t('ippool.limitedTitle')}>
          {t('ippool.limitedBody')}
        </Notice>
      ) : null}

      <Notice tone="info" title={t('ippool.howTitle')}>
        {t('ippool.howPre')}
        <b>{t('ippool.howBold1')}</b>
        {t('ippool.howMid')}
        <b>{t('ippool.howBold2')}</b>
        {t('ippool.howPost')}
      </Notice>

      {legacyBackend ? (
        <Notice tone="warning" title={t('ippool.legacyBackendTitle')}>
          {t('ippool.legacyBackendBody')}
        </Notice>
      ) : null}

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
              {/* 渲染的是当前这一页。行内的改动一律按 p.id 写回整份 pools，
                  所以翻页 / 改每页条数都不会把编辑落到别的行上 */}
              {poolPage.rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.name}
                        placeholder={t('ippool.namePlaceholder')}
                        onChange={(e) => patch(p.id, { name: e.target.value })}
                      />
                    </div>
                  </td>
                  {canManageNet ? (
                    <td>
                      {/* 这套地址分给谁用：普通用户登录后只列得出可用的池（名单里有
                          他，或是「全部用户」），在创建虚拟机 / 加网卡时也就只能从
                          自己那几个池里取地址。
                          一个池常常要分给好几个人（同一段地址给几个客户是常态），
                          原生下拉只能单选，所以改成点开弹层勾选 —— 与「适用范围」
                          同一套交互 */}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canAssign}
                        onClick={() => setOwnerEdit(p.id)}
                        title={ownerTooltip(p) || t('ippool.ownerPickHint')}
                      >
                        {ownerSummary(p)}
                      </Button>
                    </td>
                  ) : null}
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.bridge}
                        placeholder="vmbr0"
                        onChange={(e) => patch(p.id, { bridge: e.target.value })}
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
                            patch(p.id, { vlan: null });
                            return;
                          }
                          const tag = Number(raw);
                          if (Number.isInteger(tag) && tag >= 1 && tag <= 4094) {
                            patch(p.id, { vlan: tag });
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
                      onClick={() => setNodeEdit(p.id)}
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
                        onChange={(e) => patch(p.id, { subnet: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.gateway}
                        placeholder="192.168.1.1"
                        onChange={(e) => patch(p.id, { gateway: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.start}
                        placeholder="192.168.1.100"
                        onChange={(e) => patch(p.id, { start: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.end}
                        placeholder="192.168.1.200"
                        onChange={(e) => patch(p.id, { end: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.dns}
                        placeholder={t('ippool.dnsPlaceholder')}
                        onChange={(e) => patch(p.id, { dns: e.target.value })}
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
                      onClick={() =>
                        setPools(pools.filter((row) => row.id !== p.id))
                      }
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

      {/* 分页条只在真有池时出现：空列表上挂一个「每页 20 条 · 第 0-0 条，共 0 条」
          是纯噪音。保存发的是**整份** pools（不止当前这一页），不因翻页而漏 */}
      {pools.length > 0 ? <PagerBar pager={poolPage} /> : null}

      {/* 适用范围：一个池可以给多个节点用（业务网段往往在所有节点上都通），
          所以是多选而不是单选 —— 否则同网段得按节点重复建好几条。

          这里只负责把结果写回池；多列布局、区块内滚动、全选 / 清空与过滤都在
          ScopeChecklist 里，两个区块的交互因此完全一致。 */}
      <Modal
        open={nodeEdit !== null}
        onClose={() => setNodeEdit(null)}
        title={t('ippool.scopeTitle', {
          name: editing?.name || editing?.subnet || '',
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
          connections={editing?.connections ?? []}
          nodes={editing?.nodes ?? []}
          onChange={({ connections: conns, nodes: names }) => {
            if (nodeEdit === null) return;
            /* 两个维度必须一起写：树里的勾选是「连接 + 节点」的组合，分两次
               patch 中间会出现一个语义不同的瞬时状态（例如 connections 先写成
               空数组，那一瞬就成了「所有 PVE 都不限」） */
            patch(nodeEdit, { connections: conns, nodes: names });
          }}
        />
      </Modal>

      {/* 归属用户：与「适用范围」一样点开弹层选 —— 一个池要分给几个人时，单元格里
          那个原生下拉只能单选，而「指定了哪几个」在表格里又铺不开。
          改动即时写回池（与适用范围一致），底部按钮只是关闭弹层，不是提交 */}
      <Modal
        open={ownerEdit !== null}
        onClose={() => setOwnerEdit(null)}
        title={t('ippool.ownerEditTitle', {
          name: editingOwner?.name || editingOwner?.subnet || '',
        })}
        size="md"
        footer={
          <Button variant="primary" onClick={() => setOwnerEdit(null)}>
            {t('common.confirm')}
          </Button>
        }
      >
        <OwnerPicker
          users={ownerOptions}
          value={editingOwner?.owners ?? []}
          onChange={(next) => {
            if (ownerEdit === null) return;
            patch(ownerEdit, { owners: next });
          }}
        />
      </Modal>
    </Card>
  );
}
