/* ==========================================================================
   ProxCenter — 创建虚拟机向导（4 步 + 确认）

   同一个弹窗里还有「快速部署」模式（QuickDeployForm）：选规格 → 选位置 → 起名
   即可下发，适合标准机器；NUMA / PCI 直通 / 多网卡多磁盘这些仍走本向导。
   两者用一个开关切换 —— 入口只有一个（列表页的「创建虚拟机」）。
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  clusterApi,
  configApi,
  connectionsApi,
  ipPoolsApi,
  nodesApi,
  storagesApi,
  templatesApi,
  vmsApi,
} from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Modal } from './ui/Modal';
import { Button, IconButton } from './ui/Button';
import {
  Checkbox,
  Field,
  Input,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
} from './ui/Input';
import { Notice } from './ui/EmptyState';
import { Badge } from './ui/Badge';
import { NodePicker } from './NodePicker';
import { QuickDeployForm } from './QuickDeployForm';
import {
  IconPlus,
  IconTrash,
  IconCheck,
  IconAlert,
  IconTemplate,
  IconDisk,
} from './Icons';
import { useToast } from '../hooks/useToast';
import {
  BIOS_OPTIONS,
  CPU_TYPE_OPTIONS,
  DISK_FORMAT_OPTIONS,
  DISK_INTERFACE_OPTIONS,
  EFI_TYPE_OPTIONS,
  MACHINE_OPTIONS,
  NET_MODEL_OPTIONS,
  NUMA_POLICY_OPTIONS,
  OSTYPE_OPTIONS,
  SCSIHW_OPTIONS,
  TPM_VERSION_OPTIONS,
  initAgentName,
  isWindowsOstype,
  ostypeLabel,
} from '../utils/status';
import { formatBytes } from '../utils/format';
import type {
  CloudInitConfig,
  NumaNodeSpec,
  TemplateItem,
  VmCreateDisk,
  VmCreateNetwork,
  VmCreateRequest,
} from '../api/types';

/* ---------------------------------------------------------------------------
   步骤定义
   --------------------------------------------------------------------------- */

const STEPS = [
  '基本信息',
  '创建方式',
  '系统配置',
  '磁盘与网络',
  'Cloud-Init',
  '确认创建',
] as const;

/* 第 5 步（初始化）在 STEPS 里的下标。它的标题要随客户机系统变，步骤条与确认页
   共用这个下标，避免各处硬编码 4。 */
const CI_STEP = 4;

type StepIndex = 0 | 1 | 2 | 3 | 4 | 5;

/** 两种下单方式：快速（选规格）与自定义（逐步填写） */
type CreateMode = 'quick' | 'custom';

/* ---------------------------------------------------------------------------
   表单状态
   --------------------------------------------------------------------------- */

interface DiskRow {
  key: string;
  storage: string;
  size: number;
  interface: string;
  format: string;
}

interface NetRow {
  key: string;
  bridge: string;
  model: string;
  vlan_tag: string;
  firewall: boolean;
  macaddr: string;
  /** cloud-init 下发的 IP：dhcp 或 192.168.1.10/24 */
  ip: string;
  /** 静态 IP 对应的网关 */
  gateway: string;
}

/** 一个 NUMA 节点的绑定（对应一张 numaN 配置项） */
interface NumaRow {
  key: string;
  /** 本节点分到的逻辑 CPU，cpuset 写法，如 "0-3" */
  cpus: string;
  /** 内存 MB，留空由后端均分总内存 */
  memory: string;
  /** 绑定的宿主机 NUMA 节点，如 "0"；留空=只做客户机内部拓扑 */
  hostnodes: string;
  /** 内存策略，仅在填了宿主节点时生效 */
  policy: string;
}

interface IpRow {
  key: string;
  ip: string;
  gateway: string;
}

interface FormState {
  /* 基本信息（第 1 步） */
  name: string;
  vmid: string;
  node: string;
  tags: string;
  description: string;

  /* 系统配置（第 3 步） */
  ostype: string;
  bios: string;
  machine: string;
  scsihw: string;
  cpuType: string;
  cores: number;
  sockets: number;
  memory: number;
  /**
   * 内存气球的最低保留量（MB），**字符串**：'' = 不下发这个键（PVE 按整份内存
   * 算，宿主机收不回空闲内存）；0 = 显式关掉气球驱动；其它值 = 保留这么多。
   * 需要区分「没填」与「填 0」，所以不用 number。
   */
  balloon: string;
  startOnBoot: boolean;
  bootOrder: string;

  /* 高级硬件（第 3 步）：NUMA 绑定 + EFI 变量盘 / 虚拟 TPM（Windows 11 必需） */
  numaEnabled: boolean;
  /** 整机 CPU 亲和性 cpuset，留空=不限制 */
  numaAffinity: string;
  numaNodes: NumaRow[];
  efiEnabled: boolean;
  efiStorage: string;
  efiType: string;
  efiPreEnrolled: boolean;
  tpmEnabled: boolean;
  tpmStorage: string;
  tpmVersion: string;

  /* 创建方式（第 2 步）/ 磁盘与网络（第 4 步） */
  mode: 'new' | 'clone';
  cloneFrom: string;
  cloneFull: boolean;
  cloneStorage: string;
  /** 克隆完成后是否自动开机 */
  cloneStart: boolean;
  disks: DiskRow[];
  networks: NetRow[];
  iso: string;

  /* Cloud-Init（第 5 步） */
  ciEnabled: boolean;
  ciUser: string;
  ciPassword: string;
  ciSshKeys: string;
  ciDns: string;
  ciIps: IpRow[];
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

const initialState: FormState = {
  name: '',
  vmid: '',
  node: '',
  tags: '',
  description: '',

  ostype: 'l26',
  bios: 'seabios',
  machine: 'pc',
  scsihw: 'virtio-scsi-single',
  cpuType: 'host',
  cores: 2,
  sockets: 1,
  memory: 2048,
  balloon: '',
  startOnBoot: false,
  /* 启动顺序留空 = 让后端按第一块磁盘的总线自动设置（boot=order=<磁盘>）。
     刻意不写死 scsi0：磁盘总线是用户可改的，一旦从 scsi 换成 sata（Windows
     就必须换），引导顺序还指着不存在的 scsi0，表现就是「装系统时看不到盘」。 */
  bootOrder: '',

  numaEnabled: false,
  numaAffinity: '',
  numaNodes: [],
  efiEnabled: false,
  efiStorage: '',
  /** 4m 才支持预置安全启动密钥，Win11 用它 */
  efiType: '4m',
  efiPreEnrolled: true,
  tpmEnabled: false,
  tpmStorage: '',
  tpmVersion: 'v2.0',

  mode: 'clone',
  cloneFrom: '',
  /** 默认链接克隆 */
  cloneFull: false,
  cloneStorage: '',
  /** 默认克隆后自动开机 */
  cloneStart: true,
  disks: [
    { key: uid(), storage: '', size: 20, interface: 'scsi0', format: 'qcow2' },
  ],
  networks: [
    { key: uid(), bridge: 'vmbr0', model: 'virtio', vlan_tag: '', firewall: true, macaddr: '', ip: 'dhcp', gateway: '' },
  ],
  iso: '',

  ciEnabled: false,
  ciUser: 'ubuntu',
  ciPassword: '',
  ciSshKeys: '',
  ciDns: '',
  ciIps: [{ key: uid(), ip: 'dhcp', gateway: '' }],
};

/**
 * 把 Windows 认不出的那两处 virtio 硬件换成「客户机自带驱动」的型号。
 *
 * Windows 安装介质只带通用驱动，两个 virtio 设备它都不认识：
 *
 * * **磁盘**：virtio-scsi / virtio-blk 没有驱动 → 装到「你想将 Windows 安装
 *   在哪里？」那一步一个分区都列不出来。换成 SATA（Windows 自带 AHCI 驱动）。
 * * **网卡**：virtio-net 没有驱动 → 系统装完是「没有网络适配器」，还得回头补
 *   驱动。换成 Intel E1000（Windows 自带 e1000 驱动，装完即用）。
 *
 * 两处都只动 virtio 系，用户自己选的 SATA / IDE / E1000 / vmxnet3 一概不动 ——
 * 换过去会损失一点性能，这是「先能用」的取舍，不是要把高级用户的选择抹掉。
 *
 * 启动顺序里的设备名必须跟着磁盘一起改：`boot=order=scsi0` 配上只有 sata0 的
 * 机器会变成「没有可引导设备」，比看不到盘更难排查。
 */
function applyWindowsCompat(next: FormState): void {
  const renamed = new Map<string, string>();
  next.disks = next.disks.map((disk) => {
    if (!/^(scsi|virtio)\d+$/.test(disk.interface)) return disk;
    // 保留原有编号（scsi1 → sata1）而不是按下标重排：编号是磁盘的身份，
    // 照搬能保证「换完之后键名依旧互不相同」，也不会撞上别人已经占着的 sata0。
    const target = `sata${disk.interface.replace(/\D/g, '')}`;
    renamed.set(disk.interface, target);
    return { ...disk, interface: target };
  });
  if (renamed.size > 0 && next.bootOrder.trim()) {
    next.bootOrder = next.bootOrder
      .split(';')
      .map((part) => renamed.get(part.trim()) ?? part.trim())
      .join(';');
  }
  next.networks = next.networks.map((net) =>
    net.model === 'virtio' ? { ...net, model: 'e1000' } : net,
  );
}

/* ---------------------------------------------------------------------------
   校验
   --------------------------------------------------------------------------- */

type Errors = Partial<Record<string, string>>;

/** PVE 的 cpuset 写法：逗号分隔的「单核或区间」，如 0 / 0-3 / 0-3,8-11 */
const CPUSET_RE = /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;

const isCpuset = (value: string) => CPUSET_RE.test(value.trim());

/* ---------------------------------------------------------------------------
   初始化配置（Cloud-Init / Cloudbase-Init）：实际会不会下发
   ---------------------------------------------------------------------------
   判据只能有一处 —— 提交、校验、确认页各写一遍必然漂移（早先确认页看的是开关、
   提交看的是「开关 ∨ 有静态 IP」，于是出现过「确认页写着未启用、实际下发了」）。
   Windows 只认开关本身：那边跑的是 Cloudbase-Init，要客户机内先装好，
   面板默认替用户打开只会建出一台拿不到 IP 的机器。 */

/** 网卡里是否填了静态 IP */
function hasStaticIpOnNics(form: FormState): boolean {
  return form.networks.some((n) => {
    const ip = (n.ip || '').trim().toLowerCase();
    return ip !== '' && ip !== 'dhcp';
  });
}

/** 这次创建实际会不会下发初始化配置 */
function initActive(form: FormState): boolean {
  if (form.mode !== 'new') return form.ciEnabled;
  return form.ciEnabled || (hasStaticIpOnNics(form) && !isWindowsOstype(form.ostype));
}

function validateStep(
  step: StepIndex,
  form: FormState,
  takenVmids?: Set<number>,
): Errors {
  const e: Errors = {};

  if (step === 0) {
    if (!form.name.trim()) e.name = '请输入虚拟机名称';
    else if (form.name.length > 63) e.name = '名称不能超过 63 个字符';

    if (!form.vmid.trim()) e.vmid = '请输入 VMID';
    else {
      const n = Number(form.vmid);
      if (!Number.isInteger(n) || n < 100 || n > 999999999) {
        e.vmid = 'VMID 需为 100 ~ 999999999 之间的整数';
      } else if (takenVmids?.has(n)) {
        /* VMID 按主机独立分配，照搬另一台主机的号会直接撞车 */
        e.vmid = `VMID ${n} 在目标主机上已被占用，请换一个`;
      }
    }
    if (!form.node) e.node = '请选择节点';
  }

  if (step === 1) {
    if (form.mode === 'clone' && !form.cloneFrom) e.cloneFrom = '请选择克隆源（模板）';
  }

  if (step === 2) {
    if (form.cores < 1 || form.cores > 128) e.cores = '核心数需在 1 ~ 128 之间';
    if (form.sockets < 1 || form.sockets > 4) e.sockets = '插槽数需在 1 ~ 4 之间';
    if (form.memory < 512) e.memory = '内存不能小于 512 MB';
    else if (form.memory > 1_048_576) e.memory = '内存不能超过 1048576 MB';

    /* 内存气球：留空 = 不回收（不下发该键），0 = 关闭气球驱动。填了值就必须
       低于内存上限，否则 PVE 直接拒掉建机请求。 */
    if (form.balloon.trim()) {
      const balloon = Number(form.balloon);
      if (!Number.isFinite(balloon) || balloon < 0) {
        e.balloon = '最低保留内存需为不小于 0 的整数';
      } else if (balloon > 0 && balloon < 128) {
        e.balloon = '最低保留内存不能小于 128 MB';
      } else if (balloon > 0 && form.memory && balloon >= form.memory) {
        e.balloon = '最低保留内存必须小于内存上限';
      }
    }

    /* 高级硬件：cpuset 是唯一会被 PVE 直接拒的输入，格式必须在提交前拦住 */
    if (form.numaAffinity.trim() && !isCpuset(form.numaAffinity)) {
      e.numaAffinity = 'CPU 列表格式如 0-3,8-11（仅数字、逗号与连字符）';
    }
    form.numaNodes.forEach((node, i) => {
      if (!isCpuset(node.cpus)) {
        e[`numa-cpus-${i}`] = '请填写该节点的 CPU 列表，如 0-3';
      }
      if (node.hostnodes.trim() && !isCpuset(node.hostnodes)) {
        e[`numa-hostnodes-${i}`] = '宿主 NUMA 节点格式如 0 或 0-1';
      }
      const mem = Number(node.memory);
      if (node.memory.trim() && (!Number.isFinite(mem) || mem < 16)) {
        e[`numa-memory-${i}`] = '节点内存至少 16 MB，或留空自动均分';
      }
    });

    if (form.efiEnabled && !form.efiStorage) e.efiStorage = '请选择 EFI 盘的存储池';
    if (form.tpmEnabled && !form.tpmStorage) e.tpmStorage = '请选择 TPM 状态盘的存储池';
  }

  if (step === 3 && form.mode === 'new') {
    form.disks.forEach((d, i) => {
      if (!d.storage) e[`disk-storage-${i}`] = '请选择存储池';
      if (d.size < 1) e[`disk-size-${i}`] = '磁盘大小至少 1 GB';
    });
    if (form.disks.length === 0) e.disks = '至少需要一块磁盘';
    form.networks.forEach((n, i) => {
      if (!n.bridge) e[`net-bridge-${i}`] = '请选择网桥';
      const ip = (n.ip || '').trim();
      if (ip && ip.toLowerCase() !== 'dhcp' && !ip.includes('/')) {
        e[`net-ip-${i}`] = '静态地址需带 CIDR 前缀，如 192.168.1.10/24';
      }
    });
  }

  // 用 initActive 而不是开关本身：网卡填了静态 IP 时开关可能是关的，但配置
  // 确实会下发，用户名就必须校验。
  if (step === CI_STEP && initActive(form)) {
    if (!form.ciUser.trim()) {
      e.ciUser = `请输入 ${initAgentName(form.ostype)} 用户名`;
    }
    // 全新创建时 IP 在「磁盘与网络」的网卡里配置，这里只校验克隆模式下的 IP 列表。
    if (form.mode !== 'new') {
      form.ciIps.forEach((row, i) => {
        if (row.ip !== 'dhcp' && !row.ip.includes('/')) {
          e[`ip-${i}`] = '静态地址需带 CIDR 前缀，如 192.168.1.10/24';
        }
      });
    }
  }

  return e;
}

/* ---------------------------------------------------------------------------
   主体
   --------------------------------------------------------------------------- */

export interface VmCreateWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (vmid: number) => void;
}

export function VmCreateWizard({ open, onClose, onCreated }: VmCreateWizardProps) {
  const toast = useToast();

  const [step, setStep] = useState<StepIndex>(0);
  const [form, setForm] = useState<FormState>(initialState);
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  /* 仅在本轮打开时自动选一次模板，避免用户手动清空后被回填 */
  const autoPickedRef = useRef(false);
  /* 目标 PVE 主机：空串 = 面板当前连接；否则用指定连接创建（多台 PVE 场景） */
  const [targetConn, setTargetConn] = useState('');

  /**
   * 快速部署 / 自定义部署。默认选快速 —— 绝大多数创建都是「标准机器」；
   * 管理员还没定义任何规格时退回自定义（否则一进来就是个空的选择区）。
   * 用户手动切过之后，就不再被自动改回去。
   */
  const [mode, setMode] = useState<CreateMode>('quick');
  const modeTouchedRef = useRef(false);
  /** 用户主动切换：记下来，别再被「有没有规格」的自动判断覆盖 */
  const pickMode = (next: CreateMode) => {
    modeTouchedRef.current = true;
    setMode(next);
  };

  /* 规格表：只为「默认用哪种模式」而读。表单自己也读同一份，react-query 缓存
     共用，不会多一次请求 */
  const specsQuery = useQuery({
    queryKey: ['config', 'specs'],
    queryFn: configApi.getSpecs,
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (!open || modeTouchedRef.current || !specsQuery.data) return;
    const usable = specsQuery.data.specs.filter(
      (s) => s.kind === 'vm' || s.kind === 'both',
    );
    setMode(usable.length > 0 ? 'quick' : 'custom');
  }, [open, specsQuery.data]);

  /* ---- 依赖数据 ---- */
  /* 已保存的 PVE 主机列表，供「目标 PVE 主机」选择 */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  /* 面板配置的默认 DNS（服务端设置），用于预填 DNS 输入框 */
  const vmDefaultsQuery = useQuery({
    queryKey: ['config', 'vm-defaults'],
    queryFn: configApi.getVmDefaults,
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  /* 下发配额：还能建几台。摆在明面上，别等提交后被后端 403 打回来才知道。 */
  const quotaQuery = useQuery({
    queryKey: ['vms', 'quota'],
    queryFn: vmsApi.quota,
    enabled: open,
    staleTime: 0,
    retry: false,
  });

  const nextIdQuery = useQuery({
    queryKey: ['cluster', 'nextid', targetConn],
    queryFn: () => clusterApi.nextId(targetConn),
    enabled: open,
    retry: false,
    staleTime: 0,
  });

  const nodesQuery = useQuery({
    queryKey: ['nodes', targetConn],
    queryFn: () => nodesApi.list(targetConn),
    enabled: open,
    staleTime: 60_000,
  });

  const vmsQuery = useQuery({
    queryKey: ['vms', 'all', targetConn],
    queryFn: () => vmsApi.list(undefined, { connectionId: targetConn }),
    enabled: open,
    staleTime: 30_000,
  });

  /* 克隆源取模板专用接口：模板是共享资源，普通用户也要能用来部署。
     （/api/vms 对普通用户按归属过滤，模板都归属管理员，取不到） */
  const templatesQuery = useQuery({
    queryKey: ['templates', 'all', targetConn],
    /* 只要虚拟机模板：容器模板克隆出来的是容器，混进虚拟机的克隆源里必然失败 */
    queryFn: () => templatesApi.list(targetConn, 'qemu'),
    enabled: open,
    staleTime: 30_000,
  });

  /* 存储：随节点变化 */
  const storagesQuery = useQuery({
    queryKey: ['storages', targetConn, form.node || 'all'],
    queryFn: () => storagesApi.list(form.node || undefined, targetConn),
    enabled: open,
    staleTime: 60_000,
  });

  /* ISO 镜像列表 */
  const isoQuery = useQuery({
    queryKey: ['storages', 'content', 'iso', targetConn, form.node],
    queryFn: async () => {
      const isoStorages = (storagesQuery.data ?? []).filter(
        (s) =>
          s.active &&
          s.content.split(/[,;]/).some((c) => c.trim() === 'iso'),
      );
      const results = await Promise.all(
        isoStorages.map((s) =>
          storagesApi
            .content({ node: form.node, storage: s.storage, content: 'iso' }, targetConn)
            .then((items) => items.map((it) => ({ storage: s.storage, item: it })))
            .catch(() => []),
        ),
      );
      return results.flat();
    },
    enabled: open && Boolean(form.node) && (storagesQuery.data?.length ?? 0) > 0,
  });

  /* ---- 打开/关闭时初始化：始终回到默认值
     （创建方式 = 从模板克隆，克隆方式 = 链接克隆）---- */
  useEffect(() => {
    setStep(0);
    setForm(initialState);
    setErrors({});
    setTargetConn('');
    autoPickedRef.current = false;
    setMode('quick');
    modeTouchedRef.current = false;
  }, [open]);

  /* 预填面板默认 DNS：每次打开只填一次，用户自己写的值不会被覆盖。
     留空也不会导致机器没有 DNS —— 后端在写入时仍会套用这个默认值。 */
  const dnsPrefilledRef = useRef(false);
  useEffect(() => {
    if (!open) {
      dnsPrefilledRef.current = false;
      return;
    }
    if (dnsPrefilledRef.current) return;
    const dns = vmDefaultsQuery.data?.dns;
    if (!dns) return;
    dnsPrefilledRef.current = true;
    setForm((f) => (f.ciDns ? f : { ...f, ciDns: dns }));
  }, [open, vmDefaultsQuery.data]);

  /* 默认选中「当前连接」：让所有取数都带上具体连接，
     否则后端会走「未指定连接 → 合并所有 PVE」的分支，节点列表会混入别的主机 */
  useEffect(() => {
    if (!open || targetConn) return;
    const conns = connectionsQuery.data ?? [];
    const target = conns.find((c) => c.active) ?? conns[0];
    if (target) setTargetConn(target.id);
  }, [open, targetConn, connectionsQuery.data]);

  /* 切换目标 PVE 主机后：VMID / 节点名 / 模板都不通用，清空后由下方效果按新主机重新填充。
     VMID 必须一起清掉：每台 PVE 的 VMID 空间各自独立，A 主机取到的号在 B 主机上
     很可能已被占用（就是「config file already exists」的来源）。 */
  useEffect(() => {
    setForm((f) => ({ ...f, vmid: '', node: '', cloneFrom: '' }));
    autoPickedRef.current = false;
  }, [targetConn]);

  /* 自动填充 VMID 与默认节点 */
  useEffect(() => {
    if (!open) return;
    setForm((f) => {
      const next: FormState = { ...f };
      if (!f.vmid && nextIdQuery.data?.vmid) {
        next.vmid = String(nextIdQuery.data.vmid);
      }
      if (!f.node) {
        const nodes = nodesQuery.data ?? [];
        const online = nodes.find((n) => n.status === 'online');
        if (online) next.node = online.node;
        else if (nodes[0]) next.node = nodes[0].node;
      }
      return next;
    });
  }, [open, nextIdQuery.data, nodesQuery.data]);

  /* 存储可选列表 */
  /* ---- IP 地址池（可选）：提供未被占用的静态地址 ---- */
  const poolsQuery = useQuery({
    queryKey: ['ip-pools'],
    queryFn: ipPoolsApi.get,
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });

  const poolIpOptions = useMemo(() => {
    const list: Array<{ label: string; value: string; gateway: string }> = [];
    (poolsQuery.data?.pools ?? []).forEach((p) => {
      const prefix = (p.subnet || '').split('/')[1] || '24';
      p.free.slice(0, 100).forEach((ip) => {
        list.push({
          label: `${ip}/${prefix}${p.name ? ` · ${p.name}` : ''}`,
          value: `${ip}/${prefix}`,
          gateway: p.gateway,
        });
      });
    });
    return list;
  }, [poolsQuery.data]);

  const storageOptions = useMemo(
    () => [
      { label: '请选择存储池', value: '' },
      ...(storagesQuery.data ?? [])
        .filter(
          (s) =>
            s.active &&
            s.content.split(/[,;]/).some((c) => c.trim() === 'images'),
        )
        .map((s) => ({
          label: `${s.storage} (${s.type}, 可用 ${formatBytes(s.avail)})`,
          value: s.storage,
        })),
    ],
    [storagesQuery.data],
  );

  /* 「目标 PVE 主机」：始终对应一条具体连接。
     取值必须落到 id 上——若留空，后端会认为「未指定连接」而把所有主机的节点
     合并返回，创建向导的节点下拉就会混入别的主机的节点。 */
  const connectionOptions = useMemo(
    () =>
      (connectionsQuery.data ?? []).map((c) => ({
        label: `${c.name || c.host}${c.active ? '（当前连接）' : ''} · ${c.host}:${c.port}`,
        value: c.id,
      })),
    [connectionsQuery.data],
  );

  const targetConnLabel =
    connectionOptions.find((o) => o.value === targetConn)?.label ?? '当前连接';

  /* 可用作网桥的网卡 */
  const bridgesQuery = useQuery({
    queryKey: ['nodes', targetConn, form.node, 'network'],
    queryFn: () => nodesApi.network(form.node, targetConn),
    enabled: open && Boolean(form.node),
    staleTime: 60_000,
  });

  const bridgeOptions = useMemo(() => {
    const ifaces = bridgesQuery.data ?? [];
    const bridges = ifaces.filter(
      (i) => i.type === 'bridge' || i.type === 'OVSBridge',
    );
    const list = bridges.length > 0 ? bridges : ifaces;
    return [
      { label: '请选择网桥', value: '' },
      ...list.map((i) => ({
        label: `${i.iface}${i.active ? '' : '（未激活）'}`,
        value: i.iface,
      })),
    ];
  }, [bridgesQuery.data]);

  /* ---- 克隆源：只给模板 ----
     后端 /api/templates 已经筛过「type = qemu 且 template = 1」，拿到的就是
     可以用来克隆的虚拟机模板，且不受归属过滤（模板是共享资源，普通用户也要能
     用它部署 —— 而 /api/vms 对普通用户按归属过滤，取不到别人名下的模板）。

     这里刻意**不并入自己名下的普通虚拟机**：克隆一台正在跑的机器会连带复制它
     的运行时状态（磁盘里正在写入的数据、网卡 MAC、cloud-init 已经固化过的
     配置），拿去批量开出来的机器要么起不来，要么几台之间 MAC 冲突。模板才是
     PVE 认可的、被「冻结」过的干净基线。没有模板时宁可让克隆源为空并给出提示，
     也不要给出一堆看着能用、实际会出问题的选项。 */
  const cloneSources = useMemo(() => {
    /* 两道过滤：

       * 类型 —— 只能克隆虚拟机模板。后端已按 ``guest_type=qemu`` 收窄，这里再挡
         一次是为了兜住缓存里的旧响应（模板页与本向导共用 ``/templates``，改口径
         时先到的那份数据可能还混着容器模板）；
       * 归属 —— 模板必须来自「即将创建虚拟机的那台 PVE」：不同主机的节点名与
         VMID 不通用，混入别家的模板会导致克隆打到错误的连接上。 */
    return (templatesQuery.data ?? []).filter(
      (t) =>
        (t.guest_type ?? 'qemu') !== 'lxc' &&
        (!targetConn || !t.connection_id || t.connection_id === targetConn),
    );
  }, [templatesQuery.data, targetConn]);

  /* 目标主机上已被占用的 VMID（含模板）。普通用户拿到的列表按归属过滤过，
     只包含自己名下的机器，所以这里只做「发现即拦截」，不声称覆盖全部占用；
     没拦住的仍由后端把 PVE 的报错翻译成可操作提示。 */
  const takenVmids = useMemo(
    () => new Set((vmsQuery.data ?? []).map((v) => Number(v.vmid))),
    [vmsQuery.data],
  );

  const cloneOptions = useMemo(
    () => [
      { label: '请选择克隆源', value: '' },
      ...cloneSources.map((t) => ({
        /* 全部是模板，不再带 [模板] 后缀 —— 只有一种东西时那个后缀就是噪音 */
        label: `${t.name || `模板 ${t.vmid}`} · ${t.vmid} @ ${t.node}`,
        value: `${t.node}:${t.vmid}`,
      })),
    ],
    [cloneSources],
  );

  const selectedCloneSource: TemplateItem | undefined = useMemo(() => {
    if (!form.cloneFrom) return undefined;
    const [node, vmidStr] = form.cloneFrom.split(':');
    const vmid = Number(vmidStr);
    return cloneSources.find((v) => v.node === node && v.vmid === vmid);
  }, [form.cloneFrom, cloneSources]);

  /* 默认选中第一个模板，省去手动选择 */
  useEffect(() => {
    if (!open || autoPickedRef.current) return;
    if (form.mode !== 'clone' || form.cloneFrom) return;
    const first = (templatesQuery.data ?? [])[0];
    if (first) {
      autoPickedRef.current = true;
      setForm((f) => (f.cloneFrom ? f : { ...f, cloneFrom: `${first.node}:${first.vmid}` }));
    }
  }, [open, form.mode, form.cloneFrom, templatesQuery.data]);

  /* ---- 通用更新 ---- */
  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => {
      if (!e[key as string]) return e;
      const next = { ...e };
      delete next[key as string];
      return next;
    });
  }, []);

  /* ---- 客户机初始化工具：Cloud-Init / Cloudbase-Init ----
     Windows 上跑的**不是** cloud-init（官方版装不上 Windows 原生系统，换成
     Cloudbase-Init），所以名字与默认值都得按系统分流。派生值在这里算一次，
     步骤条 / 表单 / 确认页共用，免得某处漏改又冒出「Windows 的 cloud-init」。 */
  const windowsGuest = isWindowsOstype(form.ostype);
  const ciName = initAgentName(form.ostype);

  /* Windows 客户机的磁盘总线固定 SATA、网卡固定 Intel E1000（安装介质里没有
     virtio 驱动）：切换系统与「一键推荐配置」都由 applyWindowsCompat 自动换好，
     第 4 步这两个选择框只读 —— 用户看不到、也改不了那两个会让他装不上/连不上的
     选项，但 Linux 侧仍然完全可选。 */
  /* 启动顺序留空时后端会按「磁盘 → 光驱 → 网卡」自动设置（见
     backend/app/vmconfig.py 的 boot 注释：光驱必须进名单，否则空盘时引导不起来）。 */

  /* 网卡是否填了静态 IP（确认页用它区分「Windows 不会自动下发 IP」） */
  const netHasStaticIp = hasStaticIpOnNics(form);
  /* 实际是否下发初始化配置：与提交、校验共用 initActive，只有一处判据 */
  const ciActive = initActive(form);

  /* 切换操作系统：换了体系（Windows ↔ Linux）就复位初始化开关与默认用户名，
     并把 virtio 的磁盘 / 网卡换成 SATA / E1000（Windows 认不出 virtio 硬件，
     见 applyWindowsCompat）。同体系内换版本（win10 → win11）不动用户已经填过
     的东西；用户名只在「还是对面体系默认值」时才跟着换，用户改过的名字不覆盖。 */
  const changeOstype = (value: string) => {
    setForm((f) => {
      const wasWindows = isWindowsOstype(f.ostype);
      const nowWindows = isWindowsOstype(value);
      const next: FormState = { ...f, ostype: value };
      if (wasWindows === nowWindows) return next;
      next.ciEnabled = false;
      if (nowWindows && f.ciUser.trim() === 'ubuntu') next.ciUser = 'Administrator';
      if (!nowWindows && f.ciUser.trim() === 'Administrator') next.ciUser = 'ubuntu';
      if (nowWindows) applyWindowsCompat(next);
      return next;
    });
  };

  /* ---- 步骤导航 ---- */
  const goNext = () => {
    const e = validateStep(step, form, takenVmids);
    setErrors(e);
    if (Object.keys(e).length > 0) {
      toast.warning('请检查表单', '有必填项或格式错误未通过校验');
      return;
    }
    if (step < 5) setStep((s) => (s + 1) as StepIndex);
  };

  const goPrev = () => {
    if (step > 0) setStep((s) => (s - 1) as StepIndex);
  };

  /* ---- 提交 ---- */
  const submit = async () => {
    /* 全量校验 */
    const allErrors: Errors = {
      ...validateStep(0, form, takenVmids),
      ...validateStep(1, form, takenVmids),
      ...validateStep(2, form, takenVmids),
      ...validateStep(3, form, takenVmids),
      ...validateStep(4, form, takenVmids),
    };
    setErrors(allErrors);
    if (Object.keys(allErrors).length > 0) {
      toast.error('校验未通过', '请返回上一步修正表单错误');
      return;
    }

    // 全新创建：IP 在网卡上配置，折叠进初始化下发；克隆：用初始化步骤里的 IP 列表。
    // ciActive（实际是否下发）在组件体里算好了 —— 确认页显示的就是同一个值。
    const netIpConfigs = form.networks.map((n) => ({
      ip: (n.ip || '').trim() || 'dhcp',
      gateway: (n.gateway || '').trim(),
    }));

    const cloudinit: CloudInitConfig | undefined = ciActive
      ? {
          enabled: true,
          user: form.ciUser || undefined,
          password: form.ciPassword || undefined,
          ssh_keys: form.ciSshKeys || undefined,
          nameserver: form.ciDns || undefined,
          ip_configs:
            form.mode === 'new'
              ? netIpConfigs
              : form.ciIps.map((r) => ({
                  ip: r.ip || 'dhcp',
                  gateway: r.gateway || '',
                })),
        }
      : undefined;

    /* 高级硬件：NUMA 绑定 + EFI 盘 / 虚拟 TPM。
       克隆分支只带 NUMA 与亲和性 —— EFI 盘与 TPM 是存储上真实存在的卷，
       Win11 模板本身就该自带，克隆时随模板一起继承（后端也不会在克隆时重复下发）。 */
    const numaNodes: NumaNodeSpec[] = form.numaNodes
      .filter((n) => n.cpus.trim())
      .map((n) => {
        const spec: NumaNodeSpec = { cpus: n.cpus.trim() };
        const mem = Number(n.memory);
        if (n.memory.trim() && Number.isFinite(mem) && mem > 0) spec.memory = mem;
        if (n.hostnodes.trim()) {
          spec.hostnodes = n.hostnodes.trim();
          // policy 只在绑定了宿主节点时才有意义，没绑定就不下发
          if (n.policy) spec.policy = n.policy;
        }
        return spec;
      });

    const numaOptions = {
      numa: form.numaEnabled || numaNodes.length > 0,
      numa_nodes: numaNodes,
      affinity: form.numaAffinity.trim() || undefined,
    };

    const firmwareOptions = {
      efi_disk: form.efiEnabled
        ? {
            storage: form.efiStorage,
            efitype: form.efiType,
            pre_enrolled_keys: form.efiPreEnrolled,
          }
        : undefined,
      tpm: form.tpmEnabled
        ? { storage: form.tpmStorage, version: form.tpmVersion }
        : undefined,
    };

    let payload: VmCreateRequest;
    /* 内存气球：留空就不下发这个键（沿用 PVE 默认 —— 整份内存不回收） */
    const balloonOption = form.balloon.trim() ? Number(form.balloon) : undefined;

    if (form.mode === 'clone' && selectedCloneSource) {
      payload = {
        node: form.node,
        vmid: Number(form.vmid),
        name: form.name.trim(),
        memory: form.memory,
        cores: form.cores,
        sockets: form.sockets,
        cpu_type: form.cpuType,
        ostype: form.ostype,
        balloon: balloonOption,
        ...numaOptions,
        disks: [],
        networks: [],
        tags: form.tags || undefined,
        description: form.description || undefined,
        start_on_boot: form.startOnBoot,
        cloudinit,
        clone_from: {
          vmid: selectedCloneSource.vmid,
          node: selectedCloneSource.node,
          full: form.cloneFull,
          // 链接克隆不允许指定目标存储（PVE 会报错），仅完整克隆携带。
          target_storage: form.cloneFull ? form.cloneStorage || undefined : undefined,
          start: form.cloneStart,
        },
      };
    } else {
      const disks: VmCreateDisk[] = form.disks.map((d) => ({
        storage: d.storage,
        size: d.size,
        interface: d.interface,
        format: d.format,
      }));

      const networks: VmCreateNetwork[] = form.networks.map((n) => ({
        bridge: n.bridge,
        model: n.model,
        vlan_tag: n.vlan_tag ? Number(n.vlan_tag) : null,
        firewall: n.firewall,
        macaddr: n.macaddr || undefined,
      }));

      payload = {
        node: form.node,
        vmid: Number(form.vmid),
        name: form.name.trim(),
        memory: form.memory,
        cores: form.cores,
        sockets: form.sockets,
        cpu_type: form.cpuType,
        ostype: form.ostype,
        balloon: balloonOption,
        disks,
        networks,
        iso: form.iso || undefined,
        scsi_hw: form.scsihw,
        bios: form.bios,
        machine: form.machine,
        ...numaOptions,
        ...firmwareOptions,
        boot_order: form.bootOrder || undefined,
        start_on_boot: form.startOnBoot,
        cloudinit,
        tags: form.tags || undefined,
        description: form.description || undefined,
      };
    }

    setSubmitting(true);
    try {
      /* targetConn 为空表示用面板当前连接，否则在指定 PVE 主机上创建 */
      const result = await vmsApi.create(payload, targetConn);
      toast.success(
        '创建虚拟机成功',
        `VMID ${result.vmid ?? form.vmid} 已提交创建，可在任务队列查看进度`,
      );
      onCreated?.(result.vmid ?? Number(form.vmid));
      onClose();
    } catch (err) {
      toast.error('创建虚拟机失败', errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  /* ---- 动态列表操作 ---- */
  const addDisk = () =>
    setForm((f) => ({
      ...f,
      disks: [
        ...f.disks,
        {
          key: uid(),
          storage: f.disks[0]?.storage ?? '',
          size: 20,
          // Windows 必须 SATA：新盘也得跟着系统走。否则「选择框已锁成 SATA」
          // 而新加的盘是 scsi —— 用户改不动，装系统时这盘又看不见。
          interface: `${isWindowsOstype(f.ostype) ? 'sata' : 'scsi'}${f.disks.length}`,
          format: 'qcow2',
        },
      ],
    }));

  const removeDisk = (key: string) =>
    setForm((f) => ({ ...f, disks: f.disks.filter((d) => d.key !== key) }));

  const patchDisk = (key: string, patch: Partial<DiskRow>) =>
    setForm((f) => ({
      ...f,
      disks: f.disks.map((d) => (d.key === key ? { ...d, ...patch } : d)),
    }));

  const addNet = () =>
    setForm((f) => ({
      ...f,
      networks: [
        ...f.networks,
        {
          key: uid(),
          bridge: f.networks[0]?.bridge ?? 'vmbr0',
          // 同 addDisk：Windows 必须 E1000，否则新网卡是 virtio，而选择框已锁死
          model: isWindowsOstype(f.ostype) ? 'e1000' : 'virtio',
          vlan_tag: '',
          firewall: true,
          macaddr: '',
          ip: 'dhcp',
          gateway: '',
        },
      ],
    }));

  const removeNet = (key: string) =>
    setForm((f) => ({
      ...f,
      networks: f.networks.filter((n) => n.key !== key),
    }));

  const patchNet = (key: string, patch: Partial<NetRow>) =>
    setForm((f) => {
      const next: FormState = {
        ...f,
        networks: f.networks.map((n) => (n.key === key ? { ...n, ...patch } : n)),
      };
      // 网卡填了静态 IP 就得靠初始化工具下发，自动打开这一开关 —— Windows 除外：
      // 那边跑的是 Cloudbase-Init，要客户机内先装好，不能默认替用户打开。
      if (patch.ip !== undefined) {
        const static_ = patch.ip.trim() !== '' && patch.ip.trim().toLowerCase() !== 'dhcp';
        if (static_ && !isWindowsOstype(next.ostype)) next.ciEnabled = true;
      }
      return next;
    });

  /* ---- NUMA 节点（动态列表，与磁盘/网卡同一套操作）---- */
  const addNumaNode = () =>
    setForm((f) => ({
      ...f,
      numaEnabled: true,
      numaNodes: [
        ...f.numaNodes,
        {
          key: uid(),
          cpus: '',
          memory: '',
          hostnodes: '',
          policy: '',
        },
      ],
    }));

  const removeNumaNode = (key: string) =>
    setForm((f) => ({
      ...f,
      numaNodes: f.numaNodes.filter((n) => n.key !== key),
    }));

  const patchNumaNode = (key: string, patch: Partial<NumaRow>) =>
    setForm((f) => ({
      ...f,
      numaNodes: f.numaNodes.map((n) => (n.key === key ? { ...n, ...patch } : n)),
    }));

  /** 一键把「Windows 11 必需」的那几项一起设好（OVMF + q35 + EFI + TPM + SATA 磁盘）。 */
  const applyWindows11Preset = () => {
    setForm((f) => {
      const fallback = f.disks[0]?.storage ?? '';
      const next: FormState = {
        ...f,
        ostype: 'win11',
        bios: 'ovmf',
        machine: 'q35',
        cpuType: 'host',
        efiEnabled: true,
        efiStorage: f.efiStorage || fallback,
        efiType: '4m',
        efiPreEnrolled: true,
        tpmEnabled: true,
        tpmStorage: f.tpmStorage || fallback,
        tpmVersion: 'v2.0',
        // Windows 走的是 Cloudbase-Init，必须客户机内先装好 —— 默认关掉，
        // 用户装好之后自己到第 5 步打开（顺带把默认用户名换成 Administrator）。
        ciEnabled: false,
        ciUser: f.ciUser.trim() === 'ubuntu' ? 'Administrator' : f.ciUser,
      };
      // 磁盘换 SATA、网卡换 E1000：Windows 安装介质里没有 virtio 驱动
      applyWindowsCompat(next);
      return next;
    });
    setErrors((e) => {
      const next = { ...e };
      delete next.efiStorage;
      delete next.tpmStorage;
      return next;
    });
    toast.success(
      '已应用 Windows 11 推荐配置',
      'BIOS=OVMF、机型=q35、CPU=host，启用 EFI 盘与虚拟 TPM，磁盘改 SATA、网卡改 Intel E1000',
    );
  };

  const addIp = () =>
    setForm((f) => ({
      ...f,
      ciIps: [...f.ciIps, { key: uid(), ip: 'dhcp', gateway: '' }],
    }));

  const removeIp = (key: string) =>
    setForm((f) => ({ ...f, ciIps: f.ciIps.filter((r) => r.key !== key) }));

  const patchIp = (key: string, patch: Partial<IpRow>) =>
    setForm((f) => ({
      ...f,
      ciIps: f.ciIps.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    }));

  /* ---- 磁盘总量估算 ---- */
  const diskTotal = useMemo(
    () => form.disks.reduce((s, d) => s + d.size * 1024 ** 3, 0),
    [form.disks],
  );

  /* ---- 当前步骤错误数量 ---- */
  const currentErrors = Object.keys(errors).length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="创建虚拟机"
      description="按步骤填写配置，创建后将作为后台任务执行"
      size="lg"
      closeOnOverlay={false}
      footer={
        /* 快速模式自带提交按钮（在表单末尾），这里不再重复一套 footer */
        mode === 'quick' ? undefined : (
        <>
          <div className="flex-1">
            {currentErrors > 0 ? (
              <span className="fs-sm text-danger flex items-center gap-6">
                <IconAlert size={14} />
                有 {currentErrors} 处需要修正
              </span>
            ) : null}
          </div>
          <Button
            variant="secondary"
            onClick={step === 0 ? onClose : goPrev}
            disabled={submitting}
          >
            {step === 0 ? '取消' : '上一步'}
          </Button>
          {step < 5 ? (
            <Button variant="primary" onClick={goNext}>
              下一步
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={submit}
              loading={submitting}
              disabled={quotaQuery.data ? !quotaQuery.data.can_create : false}
              title={
                quotaQuery.data && !quotaQuery.data.can_create
                  ? '可下发虚拟机数量已用尽，请联系管理员'
                  : undefined
              }
            >
              创建虚拟机
            </Button>
          )}
        </>
        )
      }
    >
      {/* ---- 快速 / 自定义：入口只有一个（列表页的「创建虚拟机」）---- */}
      <div className="flex items-center gap-12 flex-wrap mb-16">
        <SegmentedControl<CreateMode>
          value={mode}
          onChange={pickMode}
          ariaLabel="创建方式"
          options={[
            { label: '快速部署', value: 'quick' },
            { label: '自定义部署', value: 'custom' },
          ]}
        />
        <span className="fs-sm text-muted">
          {mode === 'quick'
            ? '选规格、选位置、起名即下发；规格由管理员在「设置 → 资源规格」里定义'
            : '逐步填写：系统、硬件、磁盘、网络、初始化'}
        </span>
      </div>

      {mode === 'quick' ? (
        /* 快速模式自带提交按钮（在表单末尾），所以上面的 footer 让位 */
        <QuickDeployForm
          open={open}
          kind="qemu"
          onCreated={onCreated}
          onClose={onClose}
          onSwitchToCustom={() => pickMode('custom')}
        />
      ) : (
        <>
      {/* ---- 步骤条 ---- */}
      <div className="wizard-steps" role="list" aria-label="创建步骤">
        {STEPS.map((label, i) => (
          <div
            key={label}
            role="listitem"
            className={`wizard-step ${i === step ? 'is-active' : ''} ${
              i < step ? 'is-done' : ''
            }`}
          >
            <span className="wizard-step-num" aria-hidden="true">
              {i < step ? <IconCheck size={12} /> : i + 1}
            </span>
            <span className="wizard-step-label">
              {i === CI_STEP ? ciName : label}
            </span>
            {i < STEPS.length - 1 ? (
              <span
                className={`wizard-connector ${i < step ? 'is-done' : ''}`}
                aria-hidden="true"
              />
            ) : null}
          </div>
        ))}
      </div>

      <div className="wizard-body">
        {/* ================= 第 1 步：基本信息 ================= */}
        {step === 0 ? (
          <div className="wizard-section">
            {/* 可下发数量：只在管理员设了配额时出现，没设就是不限 */}
            {quotaQuery.data?.limited ? (
              <Notice
                tone={quotaQuery.data.can_create ? 'info' : 'warning'}
                title={
                  quotaQuery.data.can_create
                    ? `还可下发 ${quotaQuery.data.remaining} 台虚拟机`
                    : '可下发数量已用尽'
                }
              >
                面板总配额 {quotaQuery.data.quota} 台，当前已有{' '}
                {quotaQuery.data.used} 台
                {quotaQuery.data.can_create ? '' : '，已无法再创建'}。
                {quotaQuery.data.count_error ? (
                  <>（部分 PVE 连接读取失败：{quotaQuery.data.count_error}）</>
                ) : null}
              </Notice>
            ) : null}

            <div className="form-grid">
              <Input
                label="虚拟机名称"
                required
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                placeholder="如 web-01"
                error={errors.name}
                autoFocus
              />
              <Input
                label="VMID"
                required
                value={form.vmid}
                onChange={(e) => update('vmid', e.target.value.replace(/\D/g, ''))}
                placeholder="如 100"
                error={errors.vmid}
                hint={
                  nextIdQuery.data
                    ? `「${targetConnLabel}」建议的可用 ID：${nextIdQuery.data.vmid}（VMID 按主机独立，换主机会重新取号）`
                    : '需为 100 ~ 999999999 之间的唯一整数'
                }
              />
              <Select
                label="目标 PVE 主机"
                value={targetConn}
                onChange={(e) => setTargetConn(e.target.value)}
                options={connectionOptions}
                hint="可在已配置的多台 PVE 之间选择，默认使用面板当前连接"
              />
              <Field
                label="节点"
                required
                error={
                  errors.node ??
                  (nodesQuery.isError ? '读取节点失败，请检查该主机的连接' : undefined)
                }
                hint={
                  nodesQuery.isError
                    ? errorMessage(nodesQuery.error)
                    : '虚拟机将在此节点上创建；卡片上是各节点当前的资源占用'
                }
              >
                <NodePicker
                  nodes={nodesQuery.data ?? []}
                  value={form.node}
                  onChange={(node) => update('node', node)}
                  loading={nodesQuery.isLoading}
                />
              </Field>
              <Input
                label="标签"
                value={form.tags}
                onChange={(e) => update('tags', e.target.value)}
                placeholder="如 web;prod（分号分隔）"
              />
            </div>

            <Textarea
              label="描述"
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              placeholder="记录该虚拟机的用途、负责人等信息"
              rows={3}
            />
          </div>
        ) : null}

        {/* ================= 第 2 步：创建方式 ================= */}
        {step === 1 ? (
          <div className="wizard-section">
            <div className="wizard-section-title">创建方式</div>
            <div className="choice-cards" role="radiogroup" aria-label="创建方式">
              <button
                type="button"
                role="radio"
                aria-checked={form.mode === 'clone'}
                className={`choice-card ${form.mode === 'clone' ? 'is-active' : ''}`}
                onClick={() => update('mode', 'clone')}
              >
                <span className="choice-card-icon">
                  <IconTemplate size={20} />
                </span>
                <span className="choice-card-body">
                  <span className="choice-card-title">
                    从模板克隆
                    <Badge variant="accent" size="sm">推荐</Badge>
                  </span>
                  <span className="choice-card-desc">
                    基于已有模板快速克隆，秒级完成，默认链接克隆、几乎不占额外空间。
                  </span>
                </span>
                <span className="choice-card-check" aria-hidden="true">
                  {form.mode === 'clone' ? <IconCheck size={13} /> : null}
                </span>
              </button>

              <button
                type="button"
                role="radio"
                aria-checked={form.mode === 'new'}
                className={`choice-card ${form.mode === 'new' ? 'is-active' : ''}`}
                onClick={() => update('mode', 'new')}
              >
                <span className="choice-card-icon">
                  <IconDisk size={20} />
                </span>
                <span className="choice-card-body">
                  <span className="choice-card-title">全新安装</span>
                  <span className="choice-card-desc">
                    从零分配磁盘并挂载 ISO 安装操作系统，适合全新部署。
                  </span>
                </span>
                <span className="choice-card-check" aria-hidden="true">
                  {form.mode === 'new' ? <IconCheck size={13} /> : null}
                </span>
              </button>
            </div>

            {form.mode === 'clone' ? (
              <div className="choice-panel">
                <div className="choice-panel-head">
                  <span className="choice-panel-title">克隆参数</span>
                  <span className="choice-panel-hint">选择模板并设置克隆方式</span>
                </div>

                <Select
                  label="克隆源（模板）"
                  required
                  value={form.cloneFrom}
                  onChange={(e) => update('cloneFrom', e.target.value)}
                  options={cloneOptions}
                  error={errors.cloneFrom}
                  hint={
                    cloneSources.length === 0
                      ? '该主机上还没有任何模板可作克隆源'
                      : '只列出该主机上的虚拟机模板（普通虚拟机不可克隆）'
                  }
                />

                {vmsQuery.isError || templatesQuery.isError ? (
                  <Notice tone="danger" title="无法读取克隆源列表">
                    {errorMessage(vmsQuery.error ?? templatesQuery.error)}
                  </Notice>
                ) : null}

                {cloneSources.length === 0 && !templatesQuery.isLoading ? (
                  <Notice tone="warning" title="该主机上没有可用的克隆源">
                    目标 PVE「{targetConnLabel}」上还没有任何模板。
                    请先在该主机上创建模板，或把上方「创建方式」切换为「全新安装」。
                  </Notice>
                ) : null}

                {selectedCloneSource ? (
                  <div className="clone-preview">
                    <span className="clone-preview-icon">
                      <IconTemplate size={18} />
                    </span>
                    <div className="clone-preview-body">
                      <div className="clone-preview-name">
                        {selectedCloneSource.name || `VM ${selectedCloneSource.vmid}`}
                        <Badge variant="neutral" size="sm">
                          VMID {selectedCloneSource.vmid}
                        </Badge>
                      </div>
                      <div className="clone-preview-node">节点 {selectedCloneSource.node}</div>
                    </div>
                    <div className="clone-preview-specs">
                      <span className="spec-chip">{selectedCloneSource.maxcpu ?? '?'} vCPU</span>
                      <span className="spec-chip">{formatBytes(selectedCloneSource.maxmem)} 内存</span>
                      <span className="spec-chip">{ostypeLabel(selectedCloneSource.type ?? '')}</span>
                    </div>
                  </div>
                ) : null}

                <Select
                  label="目标存储（可选）"
                  value={form.cloneStorage}
                  onChange={(e) => update('cloneStorage', e.target.value)}
                  options={storageOptions}
                  disabled={!form.cloneFull}
                  hint={
                    form.cloneFull
                      ? '用于存放独立磁盘副本'
                      : '链接克隆复用模板磁盘，无需指定存储'
                  }
                />

                <Field label="克隆方式">
                  <div className="clone-methods">
                    <button
                      type="button"
                      className={`clone-method ${form.cloneFull ? '' : 'is-active'}`}
                      onClick={() => {
                        update('cloneFull', false);
                        update('cloneStorage', '');
                      }}
                    >
                      <span className="clone-method-radio">
                        {form.cloneFull ? null : <IconCheck size={12} />}
                      </span>
                      <span className="clone-method-body">
                        <span className="clone-method-title">
                          链接克隆
                          <span className="clone-method-tag">默认</span>
                        </span>
                        <span className="clone-method-desc">
                          秒级完成、几乎不占额外空间，但依赖源磁盘
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`clone-method ${form.cloneFull ? 'is-active' : ''}`}
                      onClick={() => update('cloneFull', true)}
                    >
                      <span className="clone-method-radio">
                        {form.cloneFull ? <IconCheck size={12} /> : null}
                      </span>
                      <span className="clone-method-body">
                        <span className="clone-method-title">完整克隆</span>
                        <span className="clone-method-desc">
                          复制独立磁盘副本，占用额外空间，与模板完全解耦
                        </span>
                      </span>
                    </button>
                  </div>
                </Field>

                <Switch
                  checked={form.cloneStart}
                  onChange={(v) => update('cloneStart', v)}
                  label="创建后自动开机"
                  hint="克隆完成并应用配置后自动启动这台虚拟机"
                />
              </div>
            ) : (
              <div className="choice-panel">
                <Notice tone="warning" title="全新安装">
                  将从零分配磁盘并挂载 ISO 安装系统，相关配置在第 4 步「磁盘与网络」中设置。
                </Notice>
              </div>
            )}
          </div>
        ) : null}

        {/* ================= 第 3 步：系统配置 ================= */}
        {step === 2 ? (
          <div className="wizard-section">
            <div className="wizard-section-title">操作系统与固件</div>
            <div className="form-grid">
              <Select
                label="客户机操作系统类型"
                value={form.ostype}
                onChange={(e) => changeOstype(e.target.value)}
                options={OSTYPE_OPTIONS.map((o) => ({
                  label: o.label,
                  value: o.value,
                }))}
                hint="影响 Proxmox 的硬件模拟与优化策略；Windows 与 Linux 的初始化工具不同（Cloudbase-Init / Cloud-Init），第 5 步会跟着变"
              />
              <Select
                label="BIOS"
                value={form.bios}
                onChange={(e) => update('bios', e.target.value)}
                options={BIOS_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
                hint="Windows 11 必须使用 OVMF"
              />
              <Select
                label="机型"
                value={form.machine}
                onChange={(e) => update('machine', e.target.value)}
                options={MACHINE_OPTIONS.map((o) => ({
                  label: o.label,
                  value: o.value,
                }))}
              />
              <Select
                label="SCSI 控制器"
                value={form.scsihw}
                onChange={(e) => update('scsihw', e.target.value)}
                options={SCSIHW_OPTIONS.map((o) => ({
                  label: o.label,
                  value: o.value,
                }))}
              />
            </div>

            {/* 固件三件套（OVMF / EFI 变量盘 / q35）要配套，缺一个就起不来。
                后端只在「请求了 EFI 盘或 TPM」时才自动校准，所以这里要主动提醒。 */}
            {form.bios === 'ovmf' && !form.efiEnabled ? (
              <Notice tone="warning" title="选了 OVMF，但还没启用 EFI 变量盘">
                UEFI 固件必须有一块 EFI 变量盘才能真正引导。请在下面的「固件扩展」
                里启用它，或直接点「一键应用 Windows 11 推荐配置」—— 否则这台机器
                建出来是起不来的。
              </Notice>
            ) : null}
            {form.bios === 'ovmf' && form.machine !== 'q35' ? (
              <Notice tone="warning" title="OVMF 需要 q35 机型">
                当前机型是 i440fx，OVMF 在它上面不可用。请把机型改成 q35，
                否则虚拟机会引导失败。
              </Notice>
            ) : null}

            {/* --- 高级硬件：EFI 变量盘与虚拟 TPM（Windows 11 必需）--- */}
            <div className="wizard-section-title mt-8">固件扩展</div>
            <Notice tone="info" title="Windows 11 需要 UEFI + 安全启动 + TPM 2.0">
              EFI 变量盘与虚拟 TPM 会在目标存储上各开一个小卷（1MB / 4MB）。
              启用任意一项时，后端都会把 BIOS 校准成 OVMF、机型校准成 q35 ——
              缺了这一步，机器即使建出来也引导不起来。
            </Notice>

            <div className="flex items-center gap-8 flex-wrap mt-16">
              <Button
                variant="secondary"
                size="sm"
                icon={<IconCheck size={14} />}
                onClick={applyWindows11Preset}
              >
                一键应用 Windows 11 推荐配置
              </Button>
              <span className="fs-sm text-muted">
                同时设置 ostype=win11、BIOS=OVMF、机型=q35、CPU 类型=host
              </span>
            </div>

            <div className="form-grid mt-16">
              <Switch
                checked={form.efiEnabled}
                onChange={(v) => update('efiEnabled', v)}
                label="EFI 变量盘（efidisk0）"
                hint="UEFI 启动必需，Windows 11 的安全启动依赖它"
              />
              {form.efiEnabled ? (
                <>
                  <Select
                    label="EFI 盘存储池"
                    required
                    value={form.efiStorage}
                    onChange={(e) => update('efiStorage', e.target.value)}
                    options={storageOptions}
                    error={errors.efiStorage}
                  />
                  <Select
                    label="EFI 格式"
                    value={form.efiType}
                    onChange={(e) => update('efiType', e.target.value)}
                    options={EFI_TYPE_OPTIONS.map((o) => ({
                      label: o.label,
                      value: o.value,
                    }))}
                    hint="只有 4m 能预置安全启动密钥"
                  />
                  <div className="mt-8">
                    <Checkbox
                      checked={form.efiPreEnrolled}
                      onChange={(e) => update('efiPreEnrolled', e.target.checked)}
                      label="预置安全启动密钥（pre-enrolled-keys）"
                    />
                  </div>
                </>
              ) : null}

              <Switch
                checked={form.tpmEnabled}
                onChange={(v) => update('tpmEnabled', v)}
                label="虚拟 TPM（tpmstate0）"
                hint="Windows 11 强制要求 TPM 2.0"
              />
              {form.tpmEnabled ? (
                <>
                  <Select
                    label="TPM 状态盘存储池"
                    required
                    value={form.tpmStorage}
                    onChange={(e) => update('tpmStorage', e.target.value)}
                    options={storageOptions}
                    error={errors.tpmStorage}
                  />
                  <Select
                    label="TPM 版本"
                    value={form.tpmVersion}
                    onChange={(e) => update('tpmVersion', e.target.value)}
                    options={TPM_VERSION_OPTIONS.map((o) => ({
                      label: o.label,
                      value: o.value,
                    }))}
                  />
                </>
              ) : null}
            </div>

            <div className="wizard-section-title mt-8">处理器与内存</div>
            <div className="form-grid">
              <Select
                label="CPU 类型"
                value={form.cpuType}
                onChange={(e) => update('cpuType', e.target.value)}
                options={CPU_TYPE_OPTIONS.map((o) => ({
                  label: o.label,
                  value: o.value,
                }))}
                hint="host 性能最佳，但跨节点迁移受限"
              />
              <Input
                label="核心数（每插槽）"
                type="number"
                min={1}
                max={128}
                value={form.cores}
                onChange={(e) => update('cores', Number(e.target.value) || 0)}
                error={errors.cores}
                hint={`总 vCPU = ${form.cores * form.sockets}`}
              />
              <Input
                label="插槽数"
                type="number"
                min={1}
                max={4}
                value={form.sockets}
                onChange={(e) => update('sockets', Number(e.target.value) || 0)}
                error={errors.sockets}
              />
              <Input
                label="内存（MB）"
                type="number"
                min={512}
                step={512}
                value={form.memory}
                onChange={(e) => update('memory', Number(e.target.value) || 0)}
                error={errors.memory}
                hint={`约 ${formatBytes(form.memory * 1024 ** 2)}`}
              />
              {/* 气球：PVE 没这个键时按整份内存算，宿主机收不回空闲内存。
                  留空保持原行为，填了才有回收空间。 */}
              <Input
                label="最低保留内存（MB）"
                type="number"
                min={0}
                step={256}
                value={form.balloon}
                onChange={(e) => update('balloon', e.target.value)}
                error={errors.balloon}
                hint="留空 = 不回收（默认）；如 1024 = 至少保留 1G，余量可被宿主机收回"
              />
            </div>

            {/* --- 高级硬件：NUMA 绑定与 CPU 亲和性 --- */}
            <div className="wizard-section-title mt-8">NUMA 绑定与 CPU 亲和性</div>
            <Notice tone="info" title="什么时候需要">
              宿主机有多个 NUMA 节点、且跑的是延迟敏感负载（数据库、缓存）时，把
              vCPU 钉在固定节点上能避免跨节点访存带来的尾延迟抖动。不确定就保持关闭
              —— 关闭时 PVE 按默认调度策略走。
            </Notice>

            <div className="form-grid mt-16">
              <Switch
                checked={form.numaEnabled}
                onChange={(v) => update('numaEnabled', v)}
                label="启用 NUMA"
                hint="给客户机呈现 NUMA 拓扑（numa=1）；单独开启不绑定宿主机节点"
              />
              <Input
                label="CPU 亲和性（可选）"
                value={form.numaAffinity}
                onChange={(e) => update('numaAffinity', e.target.value)}
                placeholder="如 0-7"
                mono
                error={errors.numaAffinity}
                hint="整机允许落在哪些宿主逻辑 CPU 上；与下面的节点绑定相互独立"
              />
            </div>

            <div className="mt-16">
              <div className="flex items-center justify-between">
                <span className="fs-sm fw-500">NUMA 节点绑定（可选）</span>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconPlus size={14} />}
                  onClick={addNumaNode}
                >
                  添加节点
                </Button>
              </div>

              {form.numaNodes.length === 0 ? (
                <div className="fs-sm text-muted mt-8">
                  未添加节点：只开启 NUMA 开关，不做 CPU 绑定。
                </div>
              ) : (
                <div className="dyn-list">
                  {form.numaNodes.map((node, i) => (
                    <div className="dyn-item" key={node.key}>
                      <div className="dyn-item-fields">
                        <div className="form-grid-2">
                          <Input
                            label={`节点 #${i + 1} CPU 列表`}
                            required
                            value={node.cpus}
                            onChange={(e) =>
                              patchNumaNode(node.key, { cpus: e.target.value })
                            }
                            placeholder="如 0-3"
                            mono
                            error={errors[`numa-cpus-${i}`]}
                          />
                          <Input
                            label="内存（MB）"
                            value={node.memory}
                            onChange={(e) =>
                              patchNumaNode(node.key, { memory: e.target.value })
                            }
                            placeholder="留空自动均分"
                            error={errors[`numa-memory-${i}`]}
                          />
                          <Input
                            label="宿主 NUMA 节点"
                            value={node.hostnodes}
                            onChange={(e) =>
                              patchNumaNode(node.key, { hostnodes: e.target.value })
                            }
                            placeholder="如 0 或 0-1"
                            mono
                            error={errors[`numa-hostnodes-${i}`]}
                            hint="留空 = 只做客户机内部拓扑"
                          />
                          <Select
                            label="内存策略"
                            value={node.policy}
                            onChange={(e) =>
                              patchNumaNode(node.key, { policy: e.target.value })
                            }
                            options={[
                              { label: '不指定', value: '' },
                              ...NUMA_POLICY_OPTIONS.map((o) => ({
                                label: o.label,
                                value: o.value,
                              })),
                            ]}
                            disabled={!node.hostnodes.trim()}
                            hint={
                              node.hostnodes.trim()
                                ? undefined
                                : '先填宿主 NUMA 节点'
                            }
                          />
                        </div>
                      </div>
                      <div className="dyn-item-remove">
                        <IconButton
                          label={`移除节点 #${i + 1}`}
                          variant="danger"
                          onClick={() => removeNumaNode(node.key)}
                        >
                          <IconTrash size={15} />
                        </IconButton>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="wizard-section-title mt-8">启动</div>
            <div className="form-grid">
              <Input
                label="启动顺序"
                value={form.bootOrder}
                onChange={(e) => update('bootOrder', e.target.value)}
                placeholder="留空即自动（磁盘 → 光驱 → 网卡）"
                hint="按顺序尝试引导设备，分号分隔。留空最稳：面板按「磁盘 → 光驱 → 网卡」设置，空盘时才能从安装 ISO 启动"
              />
            </div>
            <Switch
              checked={form.startOnBoot}
              onChange={(v) => update('startOnBoot', v)}
              label="随宿主机启动"
              hint="节点启动后自动开机该虚拟机"
            />
          </div>
        ) : null}

        {/* ================= 第 4 步：磁盘与网络 ================= */}
        {step === 3 ? (
          <div className="wizard-section">
            {form.mode === 'clone' ? (
              <Notice tone="info" title="使用模板克隆">
                磁盘与网络来自所选模板；克隆源、目标存储与克隆方式已在第 2 步「创建方式」中设置。
                如需调整网卡 IP，请在第 5 步「Cloud-Init」中配置。
              </Notice>
            ) : (
              <>
                {/* --- 磁盘 --- */}
                <div className="wizard-section-title">
                  磁盘
                  {errors.disks ? (
                    <span className="fs-xs text-danger">{errors.disks}</span>
                  ) : null}
                </div>
                <div className="dyn-list">
                  {form.disks.map((disk, i) => (
                    <div className="dyn-item" key={disk.key}>
                      <div className="dyn-item-fields">
                        <div className="form-grid-2">
                          <Select
                            label={`存储池 #${i + 1}`}
                            required
                            value={disk.storage}
                            onChange={(e) => patchDisk(disk.key, { storage: e.target.value })}
                            options={storageOptions}
                            error={errors[`disk-storage-${i}`]}
                          />
                          <Input
                            label="大小（GB）"
                            required
                            type="number"
                            min={1}
                            value={disk.size}
                            onChange={(e) =>
                              patchDisk(disk.key, { size: Number(e.target.value) || 0 })
                            }
                            error={errors[`disk-size-${i}`]}
                          />
                          <Select
                            label="总线/接口"
                            /* Windows 客户机锁死 SATA：安装程序没有 virtio 驱动，
                               挂在 virtio 上会卡在「选择安装位置」一个分区都看不到。
                               与其让用户踩进去再解释，不如这里不让改（切换系统时
                               已由 applyWindowsCompat 自动换好，所以显示的必然是 SATA）。*/
                            disabled={windowsGuest}
                            hint={
                              windowsGuest
                                ? 'Windows 安装程序不认 virtio 磁盘（要自备 virtio-win 驱动盘才能加载），已固定为 SATA'
                                : undefined
                            }
                            value={disk.interface.replace(/\d+$/, '')}
                            onChange={(e) =>
                              patchDisk(disk.key, {
                                interface: `${e.target.value}${disk.interface.replace(/\D/g, '') || i}`,
                              })
                            }
                            options={DISK_INTERFACE_OPTIONS.map((o) => ({
                              label: o.label,
                              value: o.value,
                            }))}
                          />
                          <Select
                            label="磁盘格式"
                            value={disk.format}
                            onChange={(e) => patchDisk(disk.key, { format: e.target.value })}
                            options={DISK_FORMAT_OPTIONS.map((o) => ({
                              label: o.label,
                              value: o.value,
                            }))}
                          />
                        </div>
                      </div>
                      {form.disks.length > 1 ? (
                        <div className="dyn-item-remove">
                          <IconButton
                            label={`移除磁盘 #${i + 1}`}
                            variant="danger"
                            onClick={() => removeDisk(disk.key)}
                          >
                            <IconTrash size={15} />
                          </IconButton>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconPlus size={14} />}
                  onClick={addDisk}
                >
                  添加磁盘
                </Button>

                {/* --- 网卡 --- */}
                <div className="wizard-section-title mt-8">网络</div>
                <div className="dyn-list">
                  {form.networks.map((net, i) => (
                    <div className="dyn-item" key={net.key}>
                      <div className="dyn-item-fields">
                        <div className="form-grid-2">
                          <Select
                            label={`网桥 #${i + 1}`}
                            required
                            value={net.bridge}
                            onChange={(e) => patchNet(net.key, { bridge: e.target.value })}
                            options={bridgeOptions}
                            error={errors[`net-bridge-${i}`]}
                            hint={
                              bridgesQuery.isError
                                ? '无法读取节点网卡列表，请手动确认网桥名'
                                : undefined
                            }
                          />
                          <Select
                            label="网卡型号"
                            /* Windows 同样锁死 E1000：安装介质里没有 virtio-net
                               驱动，装完系统会是没有网络适配器的状态。切换系统时
                               已由 applyWindowsCompat 换好，所以显示的必然是 E1000。*/
                            disabled={windowsGuest}
                            hint={
                              windowsGuest
                                ? 'Windows 没有 virtio 网卡驱动（装完连不上网），已固定为 Intel E1000（系统自带驱动）'
                                : undefined
                            }
                            value={net.model}
                            onChange={(e) => patchNet(net.key, { model: e.target.value })}
                            options={NET_MODEL_OPTIONS.map((o) => ({
                              label: o.label,
                              value: o.value,
                            }))}
                          />
                          <Input
                            label="VLAN Tag"
                            type="number"
                            min={1}
                            max={4094}
                            value={net.vlan_tag}
                            onChange={(e) => patchNet(net.key, { vlan_tag: e.target.value })}
                            placeholder="留空表示无 VLAN"
                          />
                          <Input
                            label="MAC 地址"
                            value={net.macaddr}
                            onChange={(e) => patchNet(net.key, { macaddr: e.target.value })}
                            placeholder="留空自动生成"
                            mono
                          />
                          <Input
                            label={`IP 地址 #${i + 1}`}
                            value={net.ip}
                            onChange={(e) => patchNet(net.key, { ip: e.target.value })}
                            placeholder="dhcp 或 192.168.1.10/24"
                            error={errors[`net-ip-${i}`]}
                            mono
                            hint={
                              windowsGuest
                                ? 'Windows 不会自动下发：需在第 5 步手动开启 Cloudbase-Init'
                                : '填静态地址将自动启用 Cloud-Init 下发'
                            }
                          />
                          <Input
                            label="网关"
                            value={net.gateway}
                            onChange={(e) => patchNet(net.key, { gateway: e.target.value })}
                            placeholder="如 192.168.1.1"
                            mono
                            disabled={(net.ip || '').trim().toLowerCase() === 'dhcp'}
                            hint="DHCP 时无需填写"
                          />
                          <Select
                            label="从地址池选择（可选）"
                            value=""
                            onChange={(e) => {
                              const opt = poolIpOptions.find(
                                (o) => o.value === e.target.value,
                              );
                              if (!opt) return;
                              patchNet(net.key, { ip: opt.value, gateway: opt.gateway });
                            }}
                            options={[
                              {
                                label: poolIpOptions.length ? '手动输入 / 不选' : '暂无空闲地址',
                                value: '',
                              },
                              ...poolIpOptions.map((o) => ({ label: o.label, value: o.value })),
                            ]}
                            hint={
                              poolIpOptions.length
                                ? '选中后自动填入上方 IP 与网关'
                                : '可到「网络」页配置 IP 地址池'
                            }
                          />
                        </div>
                        <div className="mt-8">
                          <Checkbox
                            checked={net.firewall}
                            onChange={(e) => patchNet(net.key, { firewall: e.target.checked })}
                            label="启用防火墙"
                          />
                        </div>
                      </div>
                      {form.networks.length > 1 ? (
                        <div className="dyn-item-remove">
                          <IconButton
                            label={`移除网卡 #${i + 1}`}
                            variant="danger"
                            onClick={() => removeNet(net.key)}
                          >
                            <IconTrash size={15} />
                          </IconButton>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconPlus size={14} />}
                  onClick={addNet}
                >
                  添加网卡
                </Button>

                <Notice tone="info" title="网络配置指引（如何选择 IP）">
                  虚拟机通过<b>网桥</b>（如 vmbr0）接入网络，<b>网桥本身不分配 IP</b>：
                  <br />· 若该网段已有 DHCP 服务（如路由器），填 <code>dhcp</code> 即可自动获取；
                  <br />· 否则请填写<b>静态 IP</b>（如 <code>192.168.1.10/24</code>）并填网关；也可以从上方
                  「地址池」下拉里挑一个<b>未被使用</b>的地址，会自动填入 IP 与网关；
                  <br />· 静态 IP 通过 {ciName} 下发：
                  {windowsGuest
                    ? 'Windows 客户机需要先装好 Cloudbase-Init（官方 cloud-init 不支持 Windows 原生系统），所以这里填了也不会自动开启第 5 步 —— 装好之后请手动打开。'
                    : '需要虚拟机使用支持 cloud-init 的镜像，填写后会自动启用第 5 步的 Cloud-Init。'}
                </Notice>

                {/* --- ISO --- */}
                <div className="wizard-section-title mt-8">安装介质（可选）</div>
                <Select
                  label="挂载 ISO 镜像"
                  value={form.iso}
                  onChange={(e) => update('iso', e.target.value)}
                  options={[
                    { label: '不挂载 ISO', value: '' },
                    ...(isoQuery.data ?? []).map(({ storage, item }) => ({
                      label: `${item.volid} (${formatBytes(item.size)}, ${storage})`,
                      value: item.volid,
                    })),
                  ]}
                  hint={
                    isoQuery.isLoading
                      ? '正在读取 ISO 列表…'
                      : (isoQuery.data ?? []).length === 0
                        ? '未在该节点找到 ISO 镜像，可稍后到「存储」页上传'
                        : undefined
                  }
                />

                {diskTotal > 0 ? (
                  <Notice tone="info">
                    磁盘总容量约 <strong>{formatBytes(diskTotal)}</strong>
                    （未含快照与元数据开销）。
                  </Notice>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {/* ================= 第 5 步：初始化（Cloud-Init / Cloudbase-Init） ================= */}
        {step === CI_STEP ? (
          <div className="wizard-section">
            <Switch
              checked={form.ciEnabled}
              onChange={(v) => update('ciEnabled', v)}
              label={`启用 ${ciName}`}
              hint={
                windowsGuest
                  ? 'Windows 客户机里跑的是 Cloudbase-Init：需要你先在系统内装好它，面板只预置用户与网络元数据，不会替你安装'
                  : '通过 cloud-init 镜像自动完成初始化（用户、SSH 密钥、网络）'
              }
            />

            {!form.ciEnabled ? (
              <Notice tone="info" title={`未启用 ${ciName}`}>
                {windowsGuest ? (
                  <>
                    Windows 装完后不会自动初始化：账号与网络都要在系统里手动配。
                    Cloudbase-Init <b>需要你在客户机内自行安装</b>（官方 cloud-init
                    不支持 Windows 原生系统），装好之后再回到这里打开开关，才会下发用户与网络配置。
                  </>
                ) : (
                  <>虚拟机创建后将使用镜像内的默认账号。若需要自动配置用户与网络，请在上方开启。</>
                )}
              </Notice>
            ) : (
              <>
                <div className="form-grid-2">
                  <Input
                    label="默认用户名"
                    required
                    value={form.ciUser}
                    onChange={(e) => update('ciUser', e.target.value)}
                    placeholder={windowsGuest ? 'Administrator' : 'ubuntu'}
                    error={errors.ciUser}
                    hint={
                      windowsGuest
                        ? 'Cloudbase-Init 会配置这个账号，Windows 上通常是 Administrator'
                        : undefined
                    }
                  />
                  <Input
                    label="密码"
                    type="password"
                    value={form.ciPassword}
                    onChange={(e) => update('ciPassword', e.target.value)}
                    placeholder="留空则仅使用 SSH 密钥"
                    autoComplete="new-password"
                  />
                </div>

                <Textarea
                  label="SSH 公钥"
                  mono
                  rows={4}
                  value={form.ciSshKeys}
                  onChange={(e) => update('ciSshKeys', e.target.value)}
                  placeholder="ssh-ed25519 AAAAC3Nza... user@host"
                  hint={
                    windowsGuest
                      ? '每行一个公钥；Windows 需客户机内已装 OpenSSH，Cloudbase-Init 才会写入 authorized_keys'
                      : '每行一个公钥，将写入 ~/.ssh/authorized_keys'
                  }
                />

                <Input
                  label="DNS 服务器"
                  value={form.ciDns}
                  onChange={(e) => update('ciDns', e.target.value)}
                  placeholder="如 223.5.5.5 1.1.1.1"
                  hint={
                    vmDefaultsQuery.data?.dns
                      ? `多个用空格分隔。已预填面板默认 DNS（${vmDefaultsQuery.data.dns}），留空则仍按该默认值下发。`
                      : '多个用空格分隔，留空则继承（可在「设置 → 虚拟机创建默认值」里配置默认 DNS）'
                  }
                />

                <div className="wizard-section-title">网络配置</div>
                {form.mode === 'new' ? (
                  <Notice tone="info">
                    全新创建的 IP 地址已在上一步「磁盘与网络」的网卡中配置，此处只需设置登录凭据与 DNS 即可。
                  </Notice>
                ) : (
                  <>
                    <Notice tone="info" title="网络配置指引（如何选择 IP）">
                      虚拟机通过<b>网桥</b>接入网络，<b>网桥本身不分配 IP</b>：网段内已有 DHCP 时填{' '}
                      <code>dhcp</code>；否则请填写<b>静态 IP</b>（如 <code>192.168.1.10/24</code>
                      ）与网关，或从「地址池」下拉里选一个<b>未被使用</b>的地址。
                    </Notice>
                    <div className="dyn-list">
                      {form.ciIps.map((row, i) => (
                    <div className="dyn-item" key={row.key}>
                      <div className="dyn-item-fields">
                        <div className="form-grid-2">
                          <Input
                            label={`IP 地址 #${i + 1}`}
                            value={row.ip}
                            onChange={(e) => patchIp(row.key, { ip: e.target.value })}
                            placeholder="dhcp 或 192.168.1.10/24"
                            error={errors[`ip-${i}`]}
                            mono
                            hint="填 dhcp 表示自动获取"
                          />
                          <Input
                            label="网关"
                            value={row.gateway}
                            onChange={(e) => patchIp(row.key, { gateway: e.target.value })}
                            placeholder="如 192.168.1.1"
                            mono
                            disabled={row.ip === 'dhcp'}
                          />
                          <Select
                            label="从地址池选择（可选）"
                            value=""
                            onChange={(e) => {
                              const opt = poolIpOptions.find(
                                (o) => o.value === e.target.value,
                              );
                              if (!opt) return;
                              patchIp(row.key, { ip: opt.value, gateway: opt.gateway });
                            }}
                            options={[
                              {
                                label: poolIpOptions.length ? '手动输入 / 不选' : '暂无空闲地址',
                                value: '',
                              },
                              ...poolIpOptions.map((o) => ({ label: o.label, value: o.value })),
                            ]}
                            hint={
                              poolIpOptions.length
                                ? '选中后自动填入 IP 与网关'
                                : '可到「网络」页配置 IP 地址池'
                            }
                          />
                        </div>
                      </div>
                      {form.ciIps.length > 1 ? (
                        <div className="dyn-item-remove">
                          <IconButton
                            label={`移除 IP 配置 #${i + 1}`}
                            variant="danger"
                            onClick={() => removeIp(row.key)}
                          >
                            <IconTrash size={15} />
                          </IconButton>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<IconPlus size={14} />}
                      onClick={addIp}
                    >
                      添加 IP 配置
                    </Button>
                  </>
                )}

                <Notice tone="warning" title="前置条件">
                  {windowsGuest ? (
                    <>
                      Cloudbase-Init 需要你在 Windows 客户机内预先安装（官方 cloud-init
                      装不到 Windows 原生系统上），面板只负责预置用户名 / 口令 / 网络元数据，
                      不会替你安装。用 ISO 全新安装、且不打算自动初始化时，保持关闭即可。
                    </>
                  ) : (
                    <>
                      Cloud-Init 需要虚拟机使用支持 cloud-init 的镜像（如 Ubuntu Cloud
                      Image、Debian Generic Cloud），并挂载 Cloud-Init 驱动。若使用普通
                      ISO 安装，可跳过此步骤。
                    </>
                  )}
                </Notice>
              </>
            )}
          </div>
        ) : null}

        {/* ================= 第 6 步：确认 ================= */}
        {step === 5 ? (
          <div className="wizard-section">
            <Notice tone="info" title="请确认以下配置">
              点击「创建虚拟机」后，配置将提交到 Proxmox，创建过程会作为后台任务执行。
            </Notice>

            <div className="summary-list">
              <div className="summary-group">
                <div className="summary-group-title">基本信息</div>
                <SummaryRow label="名称" value={form.name || '—'} />
                <SummaryRow label="VMID" value={form.vmid || '—'} mono />
                <SummaryRow label="目标 PVE" value={targetConnLabel} mono />
                <SummaryRow label="节点" value={form.node || '—'} mono />
                <SummaryRow label="标签" value={form.tags || '—'} />
                <SummaryRow label="描述" value={form.description || '—'} />
              </div>

              <div className="summary-group">
                <div className="summary-group-title">系统配置</div>
                <SummaryRow label="操作系统" value={ostypeLabel(form.ostype)} />
                <SummaryRow label="BIOS" value={form.bios} mono />
                <SummaryRow label="机型" value={form.machine} mono />
                <SummaryRow label="SCSI 控制器" value={form.scsihw} mono />
                <SummaryRow label="CPU" value={`${form.cpuType} · ${form.cores} 核 × ${form.sockets} 插槽`} mono />
                <SummaryRow label="内存" value={`${form.memory} MB (${formatBytes(form.memory * 1024 ** 2)})`} mono />
                <SummaryRow
                  label="启动顺序"
                  value={form.bootOrder || '自动（磁盘 → 光驱 → 网卡）'}
                  mono
                />
                <SummaryRow
                  label="开机自启"
                  value={form.startOnBoot ? '是' : '否'}
                />
              </div>

              <div className="summary-group">
                <div className="summary-group-title">
                  {form.mode === 'clone' ? '克隆来源' : '磁盘与网络'}
                </div>
                {form.mode === 'clone' ? (
                  <>
                    <SummaryRow
                      label="克隆源"
                      value={
                        selectedCloneSource
                          ? `${selectedCloneSource.name || selectedCloneSource.vmid} @ ${selectedCloneSource.node}`
                          : form.cloneFrom || '—'
                      }
                    />
                    <SummaryRow
                      label="克隆方式"
                      value={form.cloneFull ? '完整克隆' : '链接克隆'}
                    />
                    <SummaryRow
                      label="目标存储"
                      value={form.cloneStorage || '继承源'}
                      mono
                    />
                    <SummaryRow
                      label="创建后开机"
                      value={form.cloneStart ? '是' : '否'}
                    />
                  </>
                ) : (
                  <>
                    {form.disks.map((d, i) => (
                      <SummaryRow
                        key={d.key}
                        label={`磁盘 ${i + 1}`}
                        value={`${d.storage || '?'} · ${d.size} GB · ${d.interface} · ${d.format}`}
                        mono
                      />
                    ))}
                    {form.networks.map((n, i) => (
                      <SummaryRow
                        key={n.key}
                        label={`网卡 ${i + 1}`}
                        value={`${n.bridge || '?'} · ${n.model}${
                          n.vlan_tag ? ` · VLAN ${n.vlan_tag}` : ''
                        }${n.firewall ? ' · 防火墙' : ''}${
                          n.ip && n.ip.trim().toLowerCase() !== 'dhcp'
                            ? ` · IP ${n.ip}${n.gateway ? ` (网关 ${n.gateway})` : ''}`
                            : ' · DHCP'
                        }`}
                        mono
                      />
                    ))}
                    <SummaryRow label="ISO" value={form.iso || '未挂载'} mono />
                  </>
                )}
              </div>

              <div className="summary-group">
                {/* 名字随系统变；状态用 ciActive（实际会不会下发）而不是开关本身 ——
                    网卡填了静态 IP 时开关可能是关的，但配置确实下发了。 */}
                <div className="summary-group-title">{ciName}</div>
                {ciActive ? (
                  <>
                    <SummaryRow label="状态" value="已启用" />
                    <SummaryRow label="用户" value={form.ciUser || '—'} mono />
                    <SummaryRow
                      label="密码"
                      value={form.ciPassword ? '已设置' : '未设置'}
                    />
                    <SummaryRow
                      label="SSH 公钥"
                      value={
                        form.ciSshKeys
                          ? `${form.ciSshKeys.split('\n').filter(Boolean).length} 个`
                          : '未设置'
                      }
                    />
                    <SummaryRow
                      label="DNS"
                      value={form.ciDns || vmDefaultsQuery.data?.dns || '继承'}
                      mono
                    />
                    {(form.mode === 'new' ? form.networks : form.ciIps).map((r: any, i) => (
                      <SummaryRow
                        key={r.key}
                        label={`IP ${i + 1}`}
                        value={`${(r.ip || 'dhcp').trim() || 'dhcp'}${
                          r.gateway ? ` / 网关 ${r.gateway}` : ''
                        }`}
                        mono
                      />
                    ))}
                  </>
                ) : (
                  <SummaryRow
                    label="状态"
                    value={
                      windowsGuest && netHasStaticIp
                        ? '未启用（Windows 不会自动下发 IP，需在系统内手动配置）'
                        : '未启用'
                    }
                  />
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* 底部提示 */}
      <div className="mt-16 flex items-center gap-8">
        <Badge variant="neutral" size="sm">
          步骤 {step + 1} / {STEPS.length}
        </Badge>
        <span className="fs-sm text-muted">
          带 <span className="text-danger">*</span> 的字段为必填项
        </span>
      </div>
        </>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   汇总行
   --------------------------------------------------------------------------- */

function SummaryRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="desc-item">
      <span className="desc-label">{label}</span>
      <span className={`desc-value ${mono ? 'mono' : ''}`}>{value}</span>
    </div>
  );
}
