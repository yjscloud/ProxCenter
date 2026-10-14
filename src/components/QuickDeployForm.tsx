/* ==========================================================================
   ProxCenter — 快速部署表单

   原来这是一个独立页面（/deploy，侧边栏「快速部署」）。但「部署」和「创建」
   本来就是同一件事的两种做法：一页下单适合标准机器，六步向导适合要调 NUMA /
   PCI 直通 / 多网卡多磁盘的机器。做成两个入口后，用户得先想清楚「我该进哪个
   页面」—— 而这个问题本身就不该存在。

   现在它内嵌在「创建虚拟机」与「创建容器」的同一个弹窗里，顶部一个
   「快速部署 / 自定义部署」开关切换，入口只有一个。

   顺序按运维的实际填写习惯排：**先起名，再选规格与位置，最后选镜像与网络**。
   规格由管理员在「设置 → 资源规格」里定义，用户不必自己算核数与内存。

   两个刻意的固定做法：

   * **克隆方式**：初值取「设置 → 创建默认值」里的面板默认（未配置即链接克隆），
     「系统镜像」卡里那个开关紧挨着模板下拉、同一行摆放 —— 它决定的正是「这个
     模板怎么变成一台机器」，与模板本就是一回事。存储下拉框只在「磁盘真要落到
     某个存储上」时出现：链接克隆不写任何存储（磁盘留在模板所在存储），
     摆一个必填的下拉框只会让人以为必须选。
   * **静态 IP**：绝大多数机器要固定地址，所以默认静态，并从「网络 → IP 地址池」
     里自动挑一个空闲地址（可改）。池子为空时退回 DHCP，而不是让用户卡在
     一个选不出东西的下拉框前。

   刻意**不做**新的后端下单接口：规格在这里被翻译成现有的 POST /api/vms 与
   POST /api/lxc 入参，配额判定、归属记录、创建时间、审计这些都已经在那条
   链路上跑通了，另起一条只会让两边的行为慢慢分叉。

   客户机类型（虚拟机 / 容器）由外层向导决定，本组件不再自选 —— 用户点的就是
   「创建虚拟机」或「创建容器」。
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  configApi,
  connectionsApi,
  ipPoolsApi,
  lxcApi,
  nodesApi,
  quotaApi,
  templatesApi,
  vmsApi,
} from '../api/endpoints';
import { errorMessage } from '../api/client';
import { invalidateQuota } from '../hooks/quotaCache';
import { getGlobalScope } from '../api/scope';
import { checkGuestSpec, remainingSummary, type QuotaViolation } from '../utils/quotaSpec';
import { Card, CardHeader } from './ui/Card';
import { Button, IconButton } from './ui/Button';
import {
  Field,
  Input,
  SegmentedControl,
  Select,
  Switch,
} from './ui/Input';
import { Notice } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import { NodePicker } from './NodePicker';
import { isPathDisabled, SSH_SECURITY_NAV_PATH } from './Sidebar';
import { IconCloud, IconPlus, IconTrash } from './Icons';
import { useToast } from '../hooks/useToast';
import { useUiPrefs } from '../hooks/useUiPrefs';
import { useAuth } from '../hooks/useAuth';
import { useNodeStorages } from '../hooks/useNodeStorages';
import { useT, type MessageKey } from '../i18n';
import { formatBytes } from '../utils/format';
import { fitsPools } from '../utils/ippool';
import type { VmCreateRequest } from '../api/types';

/** 客户机类型：与向导的 kind 对齐（qemu = 虚拟机，lxc = 容器） */
export type QuickDeployKind = 'qemu' | 'lxc';

type IpMode = 'dhcp' | 'static';

/** GB → MB（规格里存 MB，界面上说 GB） */
const gb = (mb: number) => Math.round(mb / 1024);

/**
 * 越界维度 → 界面词条。
 *
 * 单台封顶（``max_*``）与对应的总量维度并成一项：用户能做的动作都是「把这一项
 * 调小」，分开列只会让提示变长。额度被顶掉时必须说清是**哪一项** —— 只说
 * 「超出额度」的话，用户还得自己拿规格去对剩余读数。
 */
const QUOTA_FIELD_LABEL: Record<QuotaViolation, MessageKey> = {
  count: 'quota.fieldLabel.count',
  cores: 'quota.fieldLabel.cores',
  max_cores: 'quota.fieldLabel.cores',
  memory_mb: 'quota.fieldLabel.memory',
  max_memory_mb: 'quota.fieldLabel.memory',
  disk_gb: 'quota.fieldLabel.disk',
  max_disk_gb: 'quota.fieldLabel.disk',
};

/**
 * 快速部署的一张网卡。
 *
 * 主网卡（列表第一张）额外走「IP 池自动挑地址」那套，附加网卡手填即可 ——
 * 快速部署要的是「少填几个空就下单」，不是把自定义向导整个搬过来。
 */
interface QuickNic {
  id: string;
  bridge: string;
  /** VLAN 标签（PVE 的 tag）；'' = 不划 VLAN */
  vlan: string;
  /** 速率上限（MB/s）；'' = 不限速 */
  rate: string;
  ipMode: IpMode;
  ip: string;
  gateway: string;
  /** 选中的 IP 池（只有主网卡用） */
  poolId: string;
}

let nicSeq = 0;

function blankNic(ipMode: IpMode = 'static'): QuickNic {
  nicSeq += 1;
  return {
    id: `nic-${nicSeq}`,
    bridge: '',
    vlan: '',
    rate: '',
    ipMode,
    ip: '',
    gateway: '',
    poolId: '',
  };
}

/** VLAN 标签：留空 = 不划；1~4094 的整数（PVE 的 tag 取值域） */
function parseVlan(value: string): number | undefined {
  const tag = Number(value.trim());
  return Number.isInteger(tag) && tag >= 1 && tag <= 4094 ? tag : undefined;
}

/** 填了但不是 1~4094 的整数 —— 留空合法，写错要拦在提交前 */
function vlanInvalid(value: string): boolean {
  return Boolean(value.trim()) && parseVlan(value) === undefined;
}

export interface QuickDeployFormProps {
  /** 弹窗是否打开：关闭时停掉所有取数，打开时把表单重置为干净状态 */
  open: boolean;
  /** 由外层向导决定，本组件不再自选类型 */
  kind: QuickDeployKind;
  /** 创建成功（拿得到 VMID 时带上） */
  onCreated?: (vmid: number) => void;
  /** 取消 / 关闭弹窗 */
  onClose: () => void;
  /** 切到同弹窗里的自定义向导 */
  onSwitchToCustom: () => void;
}

export function QuickDeployForm({
  open,
  kind,
  onCreated,
  onClose,
  onSwitchToCustom,
}: QuickDeployFormProps) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission, isAdmin } = useAuth();
  const isVm = kind === 'qemu';
  /* 建机权限随类型走：虚拟机 vm.create、容器 ct.create */
  const canCreate = hasPermission(isVm ? 'vm.create' : 'ct.create');

  /* ---- 选择项 ---- */
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const [specId, setSpecId] = useState('');
  const [targetConn, setTargetConn] = useState('');
  const [node, setNode] = useState('');
  const [templateRef, setTemplateRef] = useState(''); // "node/vmid"
  const [osTemplate, setOsTemplate] = useState('');
  const [storage, setStorage] = useState('');
  /* 完整克隆：关 = 链接克隆（秒级完成、不额外占空间，但磁盘依赖模板）。
     开启后把模板磁盘整份复制到所选存储 —— 创建慢一些、多占一份空间，换来的是
     这台机器与模板彻底脱钩（模板删改都不影响它）。与自定义部署是同一件事。
     初值不是写死的 false：打开时按面板默认（见下面的预填效果）落一次。 */
  const [fullClone, setFullClone] = useState(false);
  /* 默认静态：机器一般要固定地址；网段与地址由下面的 effect 自动挑 */
  const [nics, setNics] = useState<QuickNic[]>(() => [blankNic()]);
  const [ciUser, setCiUser] = useState('root');
  const [password, setPassword] = useState('');
  /* 接入安全管控：把面板公钥写进 cloud-init，机器起来后自动登记为受管主机。
     与「自定义部署」向导里的那个开关同一套后端能力。 */
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState(false);

  /* 「SSH 安全」入口被面板级开关关掉时，「接入安全管控」整个收起来（见下面的
     渲染）：勾了它机器会被登记成受管主机，而看这些主机的地方（SSH 安全 /
     登录审计 / 端口与进程 / 安全基线）都进不去了 —— 留一个「勾了没处看」的
     开关只会让人困惑。
     取值一并钉住：先勾上、之后入口被关掉时，不会把 true 悄悄提交上去。 */
  const navDisabled = useUiPrefs().nav_disabled;
  const sshNavOff = isPathDisabled(SSH_SECURITY_NAV_PATH, navDisabled);
  const manageOn = manage && !sshNavOff;

  /** 用户自己点过 IP 获取方式：之后不再被「有没有可用网段」的自动判断覆盖 */
  const ipModeTouchedRef = useRef(false);

  /** 已经按面板默认值预选过克隆方式：每次打开只填一次，不覆盖用户的选择 */
  const cloneDefaultRef = useRef(false);

  /** 主网卡：IP 池自动挑地址那套只作用于它 */
  const primaryNic = nics[0];

  const updateNic = (index: number, patch: Partial<QuickNic>) => {
    setNics((prev) => prev.map((n, i) => (i === index ? { ...n, ...patch } : n)));
  };

  const pickIpMode = (index: number, next: IpMode) => {
    if (index === 0) ipModeTouchedRef.current = true;
    updateNic(index, { ipMode: next });
  };

  const addNic = () => setNics((prev) => [...prev, blankNic('dhcp')]);

  const removeNic = (index: number) =>
    setNics((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));

  /* 每次打开都从干净状态开始：弹窗关闭时组件并没有卸载，残留的字段会带到下一台 */
  useEffect(() => {
    if (!open) return;
    setName('');
    setTags('');
    setSpecId('');
    setNode('');
    setTemplateRef('');
    setOsTemplate('');
    setStorage('');
    setNics([blankNic()]);
    setCiUser('root');
    setPassword('');
    setManage(false);
    /* 克隆方式回到面板默认值（下面那个效果会按「设置 → 创建默认值」预选）；
       先落回链接克隆是为了「默认值还没取回来」时不残留上一次的选择 ——
       上一次开了完整克隆就悄悄沿用下去，等于替用户改了磁盘语义 */
    setFullClone(false);
    cloneDefaultRef.current = false;
    ipModeTouchedRef.current = false;
    /* targetConn 不清：保留上次选的主机（多台 PVE 时省一次选择），下面那个
       effect 只在它为空时兜底选当前连接 */
  }, [open]);

  /* ---- 数据 ---- */
  const specsQuery = useQuery({
    queryKey: ['config', 'specs'],
    queryFn: configApi.getSpecs,
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  /* 面板默认克隆方式（服务端设置，见「设置 → 创建默认值」）。这里只当**初值** */
  const vmDefaultsQuery = useQuery({
    queryKey: ['config', 'vm-defaults'],
    queryFn: configApi.getVmDefaults,
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  /* 按面板默认值预选克隆方式。只在每次打开后**第一次**拿到默认值时填一次：
     用户点过那个开关之后再回填，等于把他刚改的选择顶掉。 */
  useEffect(() => {
    if (!open || cloneDefaultRef.current || !vmDefaultsQuery.data) return;
    cloneDefaultRef.current = true;
    setFullClone(Boolean(vmDefaultsQuery.data.full_clone));
  }, [open, vmDefaultsQuery.data]);

  /* 目标主机列表只有管理员拿得到（/connections 需要 settings.manage）；
     普通用户用面板当前连接 —— 单台 PVE 的面板上本来就该是这样 */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  const nodesQuery = useQuery({
    queryKey: ['nodes', targetConn],
    queryFn: () => nodesApi.list(targetConn),
    enabled: open,
    staleTime: 60_000,
  });

  /* 两处需要选存储：容器建 rootfs；虚拟机开了「完整克隆」时磁盘要有落点
     （链接克隆不写任何存储，那条路就不白读一次）。
     候选只列**所选节点上**的存储池（含显式带连接，见 useNodeStorages）。 */
  const storagesQuery = useNodeStorages(
    node,
    targetConn,
    open && (!isVm || fullClone),
  );

  const bridgesQuery = useQuery({
    queryKey: ['nodes', targetConn, node, 'network'],
    queryFn: () => nodesApi.network(node, targetConn),
    enabled: open && Boolean(node),
    staleTime: 60_000,
    retry: false,
  });

  /* 只列虚拟机模板：快速部署固定「从模板克隆」（容器走系统模板） */
  const templatesQuery = useQuery({
    queryKey: ['templates', 'all', targetConn],
    queryFn: () => templatesApi.list(targetConn, 'qemu'),
    enabled: open && isVm,
    staleTime: 30_000,
  });

  const osTemplatesQuery = useQuery({
    queryKey: ['lxc', 'templates', targetConn, node],
    queryFn: () => lxcApi.templates(node, targetConn),
    enabled: open && !isVm && Boolean(node),
    staleTime: 60_000,
    retry: false,
  });

  const poolsQuery = useQuery({
    queryKey: ['ip-pools'],
    queryFn: ipPoolsApi.get,
    enabled: open && primaryNic?.ipMode === 'static',
    staleTime: 30_000,
    retry: false,
  });

  const quotaQuery = useQuery({
    queryKey: [isVm ? 'vms' : 'lxc', 'quota'],
    queryFn: isVm ? vmsApi.quota : lxcApi.quota,
    enabled: open,
  });

  /* ---- 派生 ---- */
  const specs = useMemo(
    () =>
      (specsQuery.data?.specs ?? []).filter(
        (s) => s.kind === (isVm ? 'vm' : 'lxc') || s.kind === 'both',
      ),
    [specsQuery.data, isVm],
  );
  const spec = specs.find((s) => s.id === specId);

  const connectionOptions = useMemo(() => {
    const list = connectionsQuery.data ?? [];
    if (list.length === 0) return [];
    return list.map((c) => ({
      /* 标签里**不放主机地址**：普通用户不需要直接连这台 PVE，而「面板接了哪些
         主机、地址是什么」属于管理信息，不该从一个创建表单里漏出去。连接名在
         创建时默认就是主机地址，够认得出是哪台了。 */
      label: `${c.name || c.host}${
        c.active ? t('quickDeploy.currentConn') : ''
      }`,
      value: c.id,
    }));
  }, [connectionsQuery.data, t]);

  /* 默认落在顶栏「集群作用域」选的那一套，其次是兜底连接。
     不指定连接时后端会把所有 PVE 的节点合并返回 —— 那个列表在创建表单里没法用。
     先看作用域：用户刚把作用域切到 B，进向导却默认在 A，多半不是他想要的。 */
  useEffect(() => {
    if (!open || targetConn) return;
    const list = connectionsQuery.data ?? [];
    const target =
      list.find((c) => c.id === getGlobalScope()) ??
      list.find((c) => c.active) ??
      list[0];
    if (target) setTargetConn(target.id);
  }, [open, targetConn, connectionsQuery.data]);

  /* 换主机：节点、存储、模板都不通用，全部清掉重选 */
  useEffect(() => {
    setNode('');
    setStorage('');
    setTemplateRef('');
    setOsTemplate('');
  }, [targetConn]);

  /* 换节点：节点名不通用，存储与模板也跟着变 */
  useEffect(() => {
    setStorage('');
    setOsTemplate('');
  }, [node]);

  /* 网桥默认取节点上的第一个（通常是 vmbr0），所有还没选网桥的网卡一起填上 */
  useEffect(() => {
    const bridgesOnly = (bridgesQuery.data ?? []).filter((i) => i.type === 'bridge');
    const first = bridgesOnly.find((b) => b.iface?.startsWith('vmbr')) ?? bridgesOnly[0];
    const iface = first?.iface;
    if (!iface) return;
    setNics((prev) =>
      prev.some((n) => !n.bridge)
        ? prev.map((n) => (n.bridge ? n : { ...n, bridge: iface }))
        : prev,
    );
  }, [bridgesQuery.data]);

  /* 存储默认：容器建 rootfs 要 rootdir 存储 */
  useEffect(() => {
    if (isVm || storage) return;
    const first = (storagesQuery.data ?? []).find(
      (s) => s.active && s.content.split(/[,;]/).some((c) => c.trim() === 'rootdir'),
    );
    if (first) setStorage(first.storage);
  }, [storage, storagesQuery.data, isVm]);

  /* 可选网段：网桥与节点都要对得上（集群里同一个 vmbr0 在不同节点上常常是不同
     网段，只看网桥会在错误的节点上把池列出来 —— 判定见 utils/ippool） */
  const usablePools = useMemo(
    () =>
      fitsPools(poolsQuery.data?.pools ?? [], {
        bridge: primaryNic?.bridge,
        /* 池记着自己的 VLAN：网卡已经明确划了另一个 tag 时，这个池的地址就不在
           那个二层网络里了（网卡还没划 tag 时不排除 —— 选中池会把 tag 带过来） */
        vlan: parseVlan(primaryNic?.vlan ?? '') ?? null,
        node,
        /* 连接也要带上：多套 PVE 上同名节点是常态，只有它能区分「哪一台上的
           那个节点」（池的适用 PVE 就是按连接 id 记的） */
        connection: targetConn,
      }),
    [poolsQuery.data, primaryNic?.bridge, primaryNic?.vlan, node, targetConn],
  );

  const poolOptions = useMemo(
    () => [
      { label: t('quickDeploy.selectPool'), value: '' },
      ...usablePools.map((p) => ({
        /* 池标了自己的 VLAN 就一并显示：同一个网桥下可能挂着好几个 VLAN 网段，
           只写「名称 · 子网」的话，两个池看起来像重复的 */
        label: `${t('quickDeploy.poolOption', {
          name: p.name,
          subnet: p.subnet,
          n: p.free_count,
        })}${p.vlan != null ? ` · ${t('ippool.colVlan')} ${p.vlan}` : ''}`,
        value: p.id,
      })),
    ],
    [usablePools, t],
  );

  /* 主网卡没选网段（或所选网段已不适用，例如换了网桥）时自动挑一个：用户不必
     先知道「哪台机器的 IP 池在哪」。挑完由下一个 effect 填具体地址。 */
  useEffect(() => {
    if (!open || !primaryNic || primaryNic.ipMode !== 'static' || !poolsQuery.data) return;
    if (usablePools.some((p) => p.id === primaryNic.poolId)) return;
    const first = usablePools.find((p) => p.free_count > 0) ?? usablePools[0];
    if (!first) return;
    updateNic(0, { poolId: first.id, ip: '' });
  }, [open, primaryNic, usablePools, poolsQuery.data]);

  /* 选好网段但主网卡还没填地址：取该网段的第一个空闲地址，用户仍可改 */
  useEffect(() => {
    if (!primaryNic || primaryNic.ipMode !== 'static' || !primaryNic.poolId) return;
    if (primaryNic.ip.trim()) return;
    const pool = (poolsQuery.data?.pools ?? []).find((p) => p.id === primaryNic.poolId);
    const next = pool?.free?.[0];
    if (!next) return;
    updateNic(0, { ip: next, gateway: pool?.gateway || primaryNic.gateway });
  }, [primaryNic, poolsQuery.data]);

  /* 一个可用网段都没有（没配 IP 池、或池已满）：静态无从选起，退回 DHCP，
     而不是让用户对着空下拉框找原因。用户手动选过静态就不再干预。 */
  useEffect(() => {
    if (!open || ipModeTouchedRef.current || !primaryNic) return;
    if (primaryNic.ipMode !== 'static' || !poolsQuery.data) return;
    if (usablePools.length === 0) updateNic(0, { ipMode: 'dhcp' });
  }, [open, primaryNic, poolsQuery.data, usablePools]);

  const quota = quotaQuery.data;

  /* 按人分配的额度（资源池）：与上面那份全局台数上限是两层。
     快速部署也要按选中的规格判一次，否则它会绕过自定义向导里的那套预检
     （后端仍然会拒，但用户该在提交前就看到原因）。 */
  const myQuotaQuery = useQuery({
    queryKey: ['quota', 'me'],
    queryFn: quotaApi.mine,
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  const myGroup = myQuotaQuery.data?.groups[isVm ? 'vm' : 'ct'];
  const quotaOver = useMemo(
    () =>
      checkGuestSpec(myGroup, {
        count: 1,
        cores: spec?.cores ?? null,
        memory_mb: spec?.memory ?? null,
        disk_gb: spec?.disk ?? null,
      }),
    [myGroup, spec?.cores, spec?.memory, spec?.disk],
  );
  /* 哪一项超了：同维度去重（核数同时踩上「总量」和「单台上限」时只报一次） */
  const quotaOverLabels = useMemo(
    () =>
      Array.from(new Set(quotaOver.map((field) => t(QUOTA_FIELD_LABEL[field])))).join(
        ' / ',
      ),
    [quotaOver, t],
  );
  /* 我名下还剩多少：与两个创建向导共用 remainingSummary，两处口径一致 */
  const mySummary = remainingSummary(
    myGroup,
    {
      count: t('quota.fieldLabel.count'),
      cores: t('quota.fieldLabel.cores'),
      memory: t('quota.fieldLabel.memory'),
      disk: t('quota.fieldLabel.disk'),
    },
    {
      count: isVm ? t('quota.unitGuest') : t('quota.unitItem'),
      cores: t('quota.unitCore'),
    },
  );
  /* 两层额度：全局台数上限（管理员在「设置 → 创建默认值」里配的）与按人分配的
     资源池。要分别报，各报各的数字 —— 混成一条会把「个人额度超了」说成
     「全局额度已用尽」，数字还是全局那份，用户看着只有困惑。 */
  const globalQuotaBlocked = Boolean(quota && !quota.can_create);
  const quotaBlocked = globalQuotaBlocked || quotaOver.length > 0;

  const templateOptions = useMemo(() => {
    const list = (templatesQuery.data ?? []).filter(
      (t) => !targetConn || !t.connection_id || t.connection_id === targetConn,
    );
    return [
      { label: t('quickDeploy.selectTemplate'), value: '' },
      ...list.map((tpl) => ({
        label: `${t('quickDeploy.templateOption', {
          name: tpl.name,
          vmid: tpl.vmid,
          node: tpl.node,
        })}${
          tpl.maxdisk
            ? t('quickDeploy.diskSuffix', {
                size: formatBytes(tpl.maxdisk, 0),
              })
            : ''
        }`,
        value: `${tpl.node}/${tpl.vmid}`,
      })),
    ];
  }, [templatesQuery.data, targetConn, t]);

  const osTemplateOptions = useMemo(
    () => [
      { label: t('quickDeploy.selectOsTemplate'), value: '' },
      ...(osTemplatesQuery.data ?? []).map((tpl) => ({
        label: `${tpl.name}${
          tpl.size ? `（${formatBytes(tpl.size, 0)}）` : ''
        }`,
        value: tpl.volid,
      })),
    ],
    [osTemplatesQuery.data, t],
  );

  const storageOptions = useMemo(() => {
    const want = isVm ? 'images' : 'rootdir';
    return [
      { label: t('quickDeploy.selectStorage'), value: '' },
      ...(storagesQuery.data ?? [])
        .filter(
          (s) => s.active && s.content.split(/[,;]/).some((c) => c.trim() === want),
        )
        .map((s) => ({
          label: t('quickDeploy.storageOption', {
            name: s.storage,
            type: s.type,
            avail: formatBytes(s.avail, 0),
          }),
          value: s.storage,
        })),
    ];
  }, [storagesQuery.data, isVm, t]);

  const bridgeOptions = useMemo(
    () =>
      (bridgesQuery.data ?? [])
        .filter((i) => i.type === 'bridge' && i.iface)
        .map((i) => ({ label: i.iface, value: i.iface })),
    [bridgesQuery.data],
  );

  /* 什么时候要选存储：容器建 rootfs，或**虚拟机开了完整克隆**（磁盘要复制到
     某个存储上）。链接克隆不往任何存储写数据（磁盘留在模板所在存储），
     所以那条路不出现存储下拉 —— 摆一个必填框只会让人以为必须选。 */
  const storageNeeded = !isVm || fullClone;

  const error = useMemo(() => {
    if (!name.trim()) return t('quickDeploy.errName');
    if (!spec) return t('quickDeploy.errSpec');
    if (!node) return t('quickDeploy.errNode');
    if (isVm && !templateRef) return t('quickDeploy.errTemplate');
    if (!isVm && !osTemplate) return t('quickDeploy.errOsTemplate');
    if (storageNeeded && !storage) return t('quickDeploy.errStorage');
    if (nics.some((n) => vlanInvalid(n.vlan))) {
      return t('quickDeploy.errVlan');
    }
    if (nics.some((n) => n.ipMode === 'static' && !n.ip.trim())) {
      return t('quickDeploy.errStaticIp');
    }
    if (quotaBlocked) {
      return quotaOver.length
        ? t('quickDeploy.errQuotaSpec')
        : t('quickDeploy.errQuota', {
            label: quota?.label ?? t('quickDeploy.quotaFallback'),
          });
    }
    return '';
  }, [
    name,
    spec,
    nics,
    node,
    isVm,
    templateRef,
    osTemplate,
    storageNeeded,
    storage,
    quotaBlocked,
    quota,
    t,
  ]);

  const submit = async () => {
    if (!spec || error || !canCreate) return;
    setBusy(true);
    try {
      /* 静态时补 /24（云镜像默认掩码），网关留空就交给 DHCP/RA —— 后端对空
         网关不下发 gw=，与面板其它地方一致 */
      const nicIp = (nic: QuickNic) =>
        nic.ipMode === 'static'
          ? {
              ip: nic.ip.includes('/') ? nic.ip : `${nic.ip}/24`,
              gateway: nic.gateway || '',
            }
          : { ip: 'dhcp', gateway: '' };

      const nicRate = (nic: QuickNic) =>
        nic.rate.trim() ? Number(nic.rate) : undefined;

      if (isVm) {
        const [tplNode, tplVmid] = templateRef.split('/');
        const payload: VmCreateRequest = {
          node,
          /* 0 = 交给后端取下一个可用 VMID（PVE 的 VMID 空间每台主机各自独立） */
          vmid: 0,
          name: name.trim(),
          memory: spec.memory,
          cores: spec.cores,
          sockets: 1,
          disks: [],
          networks: nics.map((nic) => ({
            bridge: nic.bridge,
            model: 'virtio',
            /* 留空 = 不划 VLAN。克隆后由后端把 net0/net1… 整体重写成
               bridge=…,tag=…,rate=…（见 vmconfig.format_network_spec） */
            vlan_tag: parseVlan(nic.vlan) ?? null,
            rate: nicRate(nic),
          })),
          tags: tags || undefined,
          cloudinit: {
            enabled: true,
            user: ciUser || 'root',
            password: password || undefined,
            ip_configs: nics.map(nicIp),
          },
          manage: manageOn,
          clone_from: {
            node: tplNode,
            vmid: Number(tplVmid),
            /* 克隆方式由「系统镜像」卡里的开关决定：
               链接克隆（默认）：磁盘留在模板所在存储，秒级完成、不额外占空间；
               完整克隆：整份复制到所选存储（要带 target_storage），创建慢、
               多占一份空间，换来的是这台机器与模板彻底脱钩。 */
            full: fullClone,
            target_storage: fullClone ? storage : undefined,
            /* 规格里的磁盘是给新机器用的：模板盘更小时由后端扩容系统盘 */
            disk_size: spec.disk > 0 ? spec.disk : undefined,
          },
        };
        const result = await vmsApi.create(payload, targetConn);
        /* 扩容结果如实带出来：「模板盘 20G ≥ 规格 20G」和「已扩到 100G」
           必须让人看到，否则规格是否生效只能靠猜 */
        toast.success(
          t('quickDeploy.created'),
          result.disk_note
            ? `${t('quickDeploy.createdVmHint', { vmid: result.vmid ?? '-' })} · ${result.disk_note}`
            : t('quickDeploy.createdVmHint', { vmid: result.vmid ?? '-' }),
        );
        queryClient.invalidateQueries({ queryKey: ['vms'] });
        /* 多了一台机器 = 名下用量变了。额度读数有**好几份**（我的额度、平台台数、
           用户/角色额度…），只刷 ['quota'] 会漏掉其余几份 —— 统一走 invalidateQuota。 */
        invalidateQuota(queryClient);
        onCreated?.(result.vmid ?? 0);
        onClose();
      } else {
        const result = await lxcApi.create(
          {
            node,
            ostemplate: osTemplate,
            storage,
            name: name.trim(),
            rootfs: spec.disk,
            memory: spec.memory,
            /* 交换分区沿用后端默认量级：容器很少需要单独调它 */
            swap: 512,
            cores: spec.cores,
            unprivileged: true,
            start: true,
            tags: tags || undefined,
            networks: nics.map((nic, index) => ({
              name: `eth${index}`,
              bridge: nic.bridge,
              ip: nic.ipMode === 'static' ? nicIp(nic).ip : 'dhcp',
              gateway:
                nic.ipMode === 'static' ? nic.gateway || undefined : undefined,
              firewall: true,
              /* 容器同样支持 VLAN 标签（后端 LxcNetworkSpec.vlan_tag → tag=） */
              vlan_tag: parseVlan(nic.vlan) ?? null,
              rate: nicRate(nic),
            })),
            setup: {
              password: password || undefined,
            },
          },
          targetConn,
        );
        toast.success(
          t('quickDeploy.created'),
          t('quickDeploy.createdLxcHint', { vmid: result.vmid ?? '-' }),
        );
        queryClient.invalidateQueries({ queryKey: ['lxc'] });
        /* 同虚拟机那条 */
        invalidateQuota(queryClient);
        onCreated?.(result.vmid ?? 0);
        onClose();
      }
    } catch (err) {
      toast.error(t('quickDeploy.createFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /* 磁盘现在两种类型都会按规格生效（VM 走克隆后扩容系统盘），所以摘要里
     直接写实际大小 —— 不再有「虚拟机沿用模板磁盘」这个例外。 */
  const summary = spec
    ? t('quickDeploy.summary', {
        cores: spec.cores,
        mem: gb(spec.memory),
        disk: t('quickDeploy.summaryDisk', { n: spec.disk }),
      })
    : '';

  return (
    <div className="wizard-body">
      <div className="wizard-section">
        {!canCreate ? (
          <Notice tone="warning" title={t('quickDeploy.noPermTitle')}>
            {t('quickDeploy.noPermBody')}
          </Notice>
        ) : null}

        {/* 全局台数上限用尽。管理员要「已用 / 上限」和去哪儿改（就是他配的那一份）；
            普通用户看了这两个数字只会困惑 —— 设置页是管理员的，他也改不了，
            所以只留一句「找管理员」。 */}
        {globalQuotaBlocked ? (
          <Notice
            tone="warning"
            title={t('quickDeploy.quotaBlockedTitle', {
              label: quota?.label ?? '',
            })}
          >
            {isAdmin
              ? t('quickDeploy.quotaBlockedBody', {
                  used: quota?.used,
                  quota: quota?.quota,
                })
              : t('quota.askAdmin')}
          </Notice>
        ) : null}

        {/* 按人分配的额度超了：说清超的是哪一项、名下还剩多少。出口与上面那条
            不同 —— 这不是用户在「设置」里能改的东西，得找管理员调额度。 */}
        {quotaOver.length > 0 ? (
          <Notice
            tone="warning"
            title={t('quickDeploy.quotaSpecTitle', {
              label: quota?.label ?? t('quickDeploy.quotaFallback'),
            })}
          >
            {t('quickDeploy.quotaSpecBody', {
              over: quotaOverLabels,
              summary: mySummary,
            })}
          </Notice>
        ) : null}

        {!specsQuery.isLoading && specs.length === 0 ? (
          <Notice tone="info" title={t('quickDeploy.noSpecTitle')}>
            {t('quickDeploy.noSpecPre')}{' '}
            <button type="button" className="link-button" onClick={onSwitchToCustom}>
              {t('quickDeploy.noSpecCustom')}
            </button>
            {t('quickDeploy.noSpecPost')}
          </Notice>
        ) : null}

        {/* ---- 1. 实例名称 ---- */}
        <Card>
          <CardHeader
            title={t('quickDeploy.sectionName')}
            subtitle={
              isVm
                ? t('quickDeploy.nameSubtitleVm')
                : t('quickDeploy.nameSubtitleLxc')
            }
          />
          <div className="form-grid-2">
            <Input
              label={t('quickDeploy.labelName')}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                isVm
                  ? t('quickDeploy.namePlaceholderVm')
                  : t('quickDeploy.namePlaceholderLxc')
              }
            />
            <Input
              label={t('quickDeploy.labelTags')}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t('quickDeploy.tagsPlaceholder')}
            />
          </div>
        </Card>

        {/* ---- 2. 资源规格 ---- */}
        <Card>
          <CardHeader
            title={t('quickDeploy.sectionSpec')}
            subtitle={t('quickDeploy.specSubtitle')}
          />
          {specsQuery.isLoading ? (
            <Spinner />
          ) : specs.length === 0 ? (
            /* 空态已在上面用 Notice 说明；这里不重复占位 */
            null
          ) : (
            <div className="spec-cards">
              {specs.map((item) => {
                const selected = item.id === specId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`spec-card ${selected ? 'is-selected' : ''}`}
                    aria-pressed={selected}
                    onClick={() => setSpecId(item.id)}
                  >
                    <span className="spec-card-name">{item.name}</span>
                    <span className="spec-card-spec">
                      <b>{item.cores}</b> {t('quickDeploy.specUnitCores')} ·{' '}
                      <b>{gb(item.memory)}</b> {t('quickDeploy.specUnitMem')} ·{' '}
                      <b>{item.disk}</b> {t('quickDeploy.specUnitDisk')}
                    </span>
                    {item.description ? (
                      <span className="spec-card-desc">{item.description}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}

        </Card>

        {/* ---- 3. 部署位置 ---- */}
        <Card>
          <CardHeader
            title={t('quickDeploy.sectionLocation')}
            subtitle={t('quickDeploy.locationSubtitle')}
          />
          {connectionOptions.length > 0 ? (
            <div className="form-grid-2">
              {/* 限宽要包在外层：直接给 Select 传 style 只会缩窄内层输入框，
                  箭头（相对外层容器定位）会飘到框外 */}
              <div className="field-compact">
                <Select
                  label={t('quickDeploy.labelConn')}
                  value={targetConn}
                  onChange={(e) => setTargetConn(e.target.value)}
                  options={connectionOptions}
                  hint={t('quickDeploy.connHint')}
                />
              </div>
            </div>
          ) : null}
          <div className="field-compact">
            <Field
              label={t('quickDeploy.labelNode')}
              required
              error={nodesQuery.isError ? t('quickDeploy.nodeError') : undefined}
              hint={
                nodesQuery.isError ? errorMessage(nodesQuery.error) : undefined
              }
            >
              <NodePicker
                nodes={nodesQuery.data ?? []}
                value={node}
                onChange={setNode}
                loading={nodesQuery.isLoading}
              />
            </Field>
          </div>
        </Card>

        {/* ---- 4. 系统镜像 ---- */}
        <Card>
          <CardHeader
            title={t('quickDeploy.sectionImage')}
            subtitle={
              isVm
                ? t('quickDeploy.imageSubtitleVm')
                : t('quickDeploy.imageSubtitleLxc')
            }
          />
          <div className="form-grid-2">
            {isVm ? (
              <Select
                label={t('quickDeploy.labelTemplate')}
                required
                value={templateRef}
                onChange={(e) => setTemplateRef(e.target.value)}
                options={templateOptions}
                hint={
                  templatesQuery.isError
                    ? errorMessage(templatesQuery.error)
                    : t('quickDeploy.templateHint')
                }
              />
            ) : (
              <Select
                label={t('quickDeploy.labelOsTemplate')}
                required
                value={osTemplate}
                onChange={(e) => setOsTemplate(e.target.value)}
                options={osTemplateOptions}
                hint={
                  osTemplatesQuery.isError
                    ? errorMessage(osTemplatesQuery.error)
                    : t('quickDeploy.osTemplateHint')
                }
              />
            )}

            {/* 克隆方式紧挨着模板下拉（同一行右侧）：它决定的正是「这个模板怎么变成
                一台机器」，与模板是同一件事，不该另起一行占位。
                开关只留「完整克隆」四个字、不挂说明文字 —— 后果交给卡片底部那句
                随开关变化的短提示（见下），这张卡要紧凑。
                只有虚拟机克隆，容器是从 OS 模板建 rootfs，没有这一层。 */}
            {isVm ? (
              <div className="field-toggle">
                <Switch
                  checked={fullClone}
                  onChange={setFullClone}
                  label={t('quickDeploy.fullClone')}
                />
              </div>
            ) : null}

            {/* 容器建 rootfs 要选存储；虚拟机只有开了完整克隆才需要（磁盘要有落点）。
                排在开关之后：虚拟机开完整克隆时它落到第二行、正好在模板下方；
                容器没有开关，存储仍与系统模板并排（与改动前一致）。 */}
            {storageNeeded ? (
              <Select
                label={t('quickDeploy.labelStorage')}
                required
                value={storage}
                onChange={(e) => setStorage(e.target.value)}
                options={storageOptions}
                hint={
                  isVm
                    ? t('quickDeploy.storageHintVm')
                    : t('quickDeploy.storageHint')
                }
              />
            ) : null}
          </div>

          {isVm && spec ? (
            <div className="mt-12 field-message">
              {fullClone
                ? t('quickDeploy.fullCloneNote', { n: spec.disk })
                : t('quickDeploy.linkedCloneNote', { n: spec.disk })}
            </div>
          ) : null}
        </Card>

        {/* ---- 5. 网络 ---- */}
        <Card>
          <CardHeader
            title={t('quickDeploy.sectionNetwork')}
            subtitle={
              isVm
                ? t('quickDeploy.networkSubtitleVm')
                : t('quickDeploy.networkSubtitleLxc')
            }
            actions={
              <Button
                variant="secondary"
                size="sm"
                icon={<IconPlus size={14} />}
                onClick={addNic}
              >
                {t('quickDeploy.addNic')}
              </Button>
            }
          />
          {/* 每张网卡一张卡片：多张时才有边界，否则「移除」按钮会贴在下一张的
              字段上（看起来像属于下面那张）；也标出「1 号网卡 / 2 号网卡」。 */}
          <div className="dyn-list">
            {nics.map((nic, index) => (
              <div className="dyn-item" key={nic.id}>
                <div className="dyn-item-fields">
                  {nics.length > 1 ? (
                    <div className="dyn-item-title">
                      {t('quickDeploy.nicTitle', { index: index + 1 })}
                    </div>
                  ) : null}

                  <div className="qd-nic-row">
                    <Select
                      label={t('quickDeploy.labelBridge')}
                      value={nic.bridge}
                      onChange={(e) => updateNic(index, { bridge: e.target.value })}
                      options={
                        bridgeOptions.length
                          ? bridgeOptions
                          : [{ label: nic.bridge || 'vmbr0', value: nic.bridge || 'vmbr0' }]
                      }
                      hint={
                        index === 0 && bridgesQuery.isError
                          ? errorMessage(bridgesQuery.error)
                          : undefined
                      }
                    />
                    <Input
                      label={t('quickDeploy.labelVlan')}
                      type="number"
                      min={1}
                      max={4094}
                      value={nic.vlan}
                      onChange={(e) => updateNic(index, { vlan: e.target.value })}
                      placeholder={t('quickDeploy.vlanPlaceholder')}
                    />
                    <Input
                      label={t('quickDeploy.labelRate')}
                      type="number"
                      min={0}
                      step={10}
                      value={nic.rate}
                      onChange={(e) => updateNic(index, { rate: e.target.value })}
                      placeholder={t('quickDeploy.ratePlaceholder')}
                    />
                  </div>

                  <div className="dyn-row mt-12 qd-nic-mode">
                    <Field label={t('quickDeploy.labelIpMode')}>
                      <SegmentedControl<IpMode>
                        value={nic.ipMode}
                        onChange={(next) => pickIpMode(index, next)}
                        ariaLabel={t('quickDeploy.labelIpMode')}
                        options={[
                          { label: t('quickDeploy.ipModeStatic'), value: 'static' },
                          { label: 'DHCP', value: 'dhcp' },
                        ]}
                      />
                    </Field>
                  </div>

                  {nic.ipMode === 'static' ? (
                    <div className="dyn-row mt-12">
                      {/* 只有主网卡能自动挑 IP 池：附加网卡手填地址 */}
                      {index === 0 ? (
                        <Select
                          label={t('quickDeploy.labelPool')}
                          value={nic.poolId}
                          onChange={(e) => {
                            /* 池记着它属于哪个二层网络（网桥 + VLAN）：选中后把这两项
                               一起带到网卡上，省得用户再对一遍 —— 对不上的池本来也
                               选不到（判定见 usablePools）。池没写 VLAN 时保留网卡
                               当前的值，不擅自清掉。 */
                            const picked = usablePools.find(
                              (p) => p.id === e.target.value,
                            );
                            updateNic(index, {
                              poolId: e.target.value,
                              ip: '',
                              ...(picked
                                ? {
                                    bridge: picked.bridge || nic.bridge,
                                    vlan:
                                      picked.vlan != null
                                        ? String(picked.vlan)
                                        : nic.vlan,
                                  }
                                : {}),
                            });
                          }}
                          options={poolOptions}
                          hint={
                            poolsQuery.isError
                              ? errorMessage(poolsQuery.error)
                              : t('quickDeploy.poolHint')
                          }
                        />
                      ) : null}
                      <Input
                        label={t('quickDeploy.labelIp')}
                        required
                        value={nic.ip}
                        onChange={(e) => updateNic(index, { ip: e.target.value })}
                        placeholder={t('quickDeploy.ipPlaceholder')}
                      />
                      <Input
                        label={t('quickDeploy.labelGateway')}
                        value={nic.gateway}
                        onChange={(e) => updateNic(index, { gateway: e.target.value })}
                        placeholder={t('quickDeploy.gatewayPlaceholder')}
                      />
                    </div>
                  ) : null}
                </div>

                {nics.length > 1 ? (
                  <div className="dyn-item-remove">
                    <IconButton
                      label={t('quickDeploy.removeNic')}
                      title={t('quickDeploy.removeNic')}
                      variant="danger"
                      onClick={() => removeNic(index)}
                    >
                      <IconTrash size={15} />
                    </IconButton>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {/* 接入安全管控：**只有虚拟机有这条能力**（与「自定义部署」向导里同一个
              开关）。快速部署走链接克隆，公钥由后端注入 cloud-init，机器起来后自动
              登记为受管主机。容器没有 cloud-init，后端 /api/lxc 也不接受这个字段。
              与网卡列表用一条分隔线隔开 —— 它不属于「某一张网卡」，而是整台机器的
              选项，挨着最后一张卡会让人以为在说那张卡。
              「SSH 安全」入口被面板级开关关掉时（sshNavOff）整项不出现：机器登记成
              受管主机之后要在那个入口下面才能看到与管理。 */}
          {isVm && !sshNavOff ? (
            <div className="qd-divider">
              <Switch
                label={t('vmCreate.ciManage')}
                checked={manageOn}
                onChange={setManage}
                /* DHCP 与静态都能接入，差别只在登记时机（静态立刻登记，DHCP 等机器
                   自报地址）—— 文案里说清这件事，别让人以为 DHCP 用不了 */
                hint={
                  primaryNic?.ipMode === 'static'
                    ? t('vmCreate.ciManageHint')
                    : t('vmCreate.ciManageDhcpHint')
                }
              />
            </div>
          ) : null}
        </Card>

        {/* ---- 6. 登录信息 ---- */}
        <Card>
          <CardHeader
            title={t('quickDeploy.sectionLogin')}
            subtitle={
              isVm
                ? t('quickDeploy.loginSubtitleVm')
                : t('quickDeploy.loginSubtitleLxc')
            }
          />
          <div className="form-grid-2">
            {isVm ? (
              <Input
                label={t('quickDeploy.labelUser')}
                value={ciUser}
                onChange={(e) => setCiUser(e.target.value)}
                placeholder="root"
              />
            ) : null}
            <Input
              label={
                isVm
                  ? t('quickDeploy.labelPassword')
                  : t('quickDeploy.labelRootPassword')
              }
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('quickDeploy.passwordPlaceholder')}
            />
          </div>
        </Card>

        {/* ---- 提交 ---- */}
        <div>
          {/* 用中性提示而不是红色报错：这是「还差什么」的引导，不是用户填错了 */}
          {error ? <div className="field-message">{error}</div> : null}
          <div className="mt-12 flex items-center gap-12 flex-wrap">
            <Button
              variant="primary"
              icon={<IconCloud size={15} />}
              loading={busy}
              disabled={Boolean(error) || !canCreate}
              onClick={() => void submit()}
            >
              {isVm ? t('quickDeploy.createVm') : t('quickDeploy.createLxc')}
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            {quota ? (
              <span className="fs-sm text-muted">
                {quota.limited
                  ? t('quickDeploy.quotaLimited', {
                      label: quota.label,
                      used: quota.used,
                      quota: quota.quota,
                      remaining: quota.remaining,
                    })
                  : t('quickDeploy.quotaUnlimited', { label: quota.label })}
                {summary ? t('quickDeploy.willCreate', { summary }) : ''}
              </span>
            ) : (
              <span className="flex items-center gap-6 fs-sm text-muted">
                <Spinner size={12} /> {t('quickDeploy.loadingQuota')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
