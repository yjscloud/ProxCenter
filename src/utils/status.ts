/* ==========================================================================
   ProxCenter — 状态映射工具
   ========================================================================== */

import type { BadgeVariant, TaskStatus, VmStatus } from '../api/types';
import type { MessageKey, TFunc } from '../i18n';

export interface StatusMeta {
  /** 显示文案（由调用点传入的 t 现算，见下方表结构说明） */
  label: string;
  /** 徽章变体 */
  variant: BadgeVariant;
  /** 圆点是否脉冲（运行中）*/
  pulse?: boolean;
}

/**
 * 状态表项：表里存**词条键**而不是文案。
 *
 * 这些函数在页面、卡片、表格里被调用几十次，而模块级常量拿不到当前语言 ——
 * 所以每个 `xxMeta()` 都收一个 `t`，由调用点传入。调用形态只多了最后一个参数，
 * 调用点 `.label` 的用法保持不变。
 */
interface StatusTableEntry {
  /** null = 直接用状态码本身（不翻译） */
  key: MessageKey | null;
  variant: BadgeVariant;
  pulse?: boolean;
}

/** 表里没有的状态（PVE 新加的、后端返回的怪值）原样显示状态码，不编造文案 */
function resolveStatus(
  table: Record<string, StatusTableEntry>,
  status: string | null | undefined,
  t: TFunc,
): StatusMeta {
  const entry = status ? table[status] : undefined;
  if (!entry) return { label: status ?? t('status.unknown'), variant: 'neutral' };
  return {
    label: entry.key ? t(entry.key) : (status ?? ''),
    variant: entry.variant,
    pulse: entry.pulse,
  };
}

/* ---------------------------------------------------------------------------
   VM 状态
   --------------------------------------------------------------------------- */

const VM_STATUS_KEYS: Record<string, StatusTableEntry> = {
  running: { key: 'status.vm.running', variant: 'success', pulse: true },
  stopped: { key: 'status.vm.stopped', variant: 'neutral' },
  paused: { key: 'status.vm.paused', variant: 'warning' },
  suspended: { key: 'status.vm.suspended', variant: 'warning' },
  stopping: { key: 'status.vm.stopping', variant: 'warning', pulse: true },
  starting: { key: 'status.vm.starting', variant: 'info', pulse: true },
  unknown: { key: 'status.unknown', variant: 'neutral' },
};

export function vmStatusMeta(
  status: VmStatus | null | undefined,
  t: TFunc,
): StatusMeta {
  return resolveStatus(VM_STATUS_KEYS, status, t);
}

/** 是否处于过渡态（不可操作）*/
export function isTransient(status?: VmStatus | null): boolean {
  return status === 'stopping' || status === 'starting';
}

/** VM 是否正在运行 */
export function isRunning(status?: VmStatus | null): boolean {
  return status === 'running';
}

/** VM 是否已停止（可启动）*/
export function isStopped(status?: VmStatus | null): boolean {
  return status === 'stopped' || status === 'unknown';
}

/* ---------------------------------------------------------------------------
   节点状态
   --------------------------------------------------------------------------- */

const NODE_STATUS_KEYS: Record<string, StatusTableEntry> = {
  online: { key: 'status.node.online', variant: 'success', pulse: true },
  offline: { key: 'status.node.offline', variant: 'danger' },
  unknown: { key: 'status.unknown', variant: 'neutral' },
};

export function nodeStatusMeta(
  status: string | null | undefined,
  t: TFunc,
): StatusMeta {
  return resolveStatus(NODE_STATUS_KEYS, status, t);
}

/* ---------------------------------------------------------------------------
   任务状态
   --------------------------------------------------------------------------- */

const TASK_STATUS_KEYS: Record<string, StatusTableEntry> = {
  running: { key: 'status.task.running', variant: 'info', pulse: true },
  stopped: { key: 'status.task.stopped', variant: 'neutral' },
  unknown: { key: 'status.unknown', variant: 'neutral' },
};

export function taskStatusMeta(
  status: TaskStatus | null | undefined,
  exitstatus: string | null | undefined,
  t: TFunc,
): StatusMeta {
  // 已结束的任务，用 exitstatus 判断成功/失败
  if (status === 'stopped') {
    if (!exitstatus) return { label: t('status.task.stopped'), variant: 'neutral' };
    return taskExitMeta(exitstatus, t);
  }
  return resolveStatus(TASK_STATUS_KEYS, status, t);
}

/** exitstatus: "OK" 为成功，其余（含 "WARNINGS"）为失败/警告 */
export function taskExitMeta(exitstatus: string, t: TFunc): StatusMeta {
  if (exitstatus === 'OK') {
    return { label: t('status.exit.ok'), variant: 'success' };
  }
  if (exitstatus.startsWith('WARNINGS')) {
    return { label: t('status.exit.warnings'), variant: 'warning' };
  }
  return { label: t('status.exit.failed'), variant: 'danger' };
}

export function isTaskSuccess(task: {
  status?: TaskStatus;
  exitstatus?: string;
}): boolean {
  return task.status === 'stopped' && task.exitstatus === 'OK';
}

export function isTaskRunning(status?: TaskStatus | null): boolean {
  return status === 'running';
}

/* ---------------------------------------------------------------------------
   存储状态
   --------------------------------------------------------------------------- */

export function storageStatusMeta(
  active: boolean | null | undefined,
  t: TFunc,
): StatusMeta {
  if (active === undefined || active === null) {
    return { label: t('status.unknown'), variant: 'neutral' };
  }
  return active
    ? { label: t('status.storage.active'), variant: 'success' }
    : { label: t('status.storage.inactive'), variant: 'danger' };
}

/* ---------------------------------------------------------------------------
   审计结果
   --------------------------------------------------------------------------- */

const AUDIT_RESULT_KEYS: Record<string, StatusTableEntry> = {
  success: { key: 'status.audit.success', variant: 'success' },
  ok: { key: 'status.audit.success', variant: 'success' },
  failure: { key: 'status.audit.failed', variant: 'danger' },
  failed: { key: 'status.audit.failed', variant: 'danger' },
  error: { key: 'status.audit.error', variant: 'danger' },
  denied: { key: 'status.audit.denied', variant: 'warning' },
};

export function auditResultMeta(
  result: string | null | undefined,
  t: TFunc,
): StatusMeta {
  if (!result) return { label: t('status.unknown'), variant: 'neutral' };
  // 后端偶尔返回大写，查表用小写，显示仍用原值
  const entry = AUDIT_RESULT_KEYS[result.toLowerCase()];
  if (!entry) return { label: result, variant: 'neutral' };
  return { label: entry.key ? t(entry.key) : result, variant: entry.variant };
}

/* ---------------------------------------------------------------------------
   面板用户状态
   --------------------------------------------------------------------------- */

export function userEnabledMeta(
  enabled: boolean | null | undefined,
  t: TFunc,
): StatusMeta {
  if (enabled === undefined || enabled === null) {
    return { label: t('status.unknown'), variant: 'neutral' };
  }
  return enabled
    ? { label: t('status.user.enabled'), variant: 'success' }
    : { label: t('status.user.disabled'), variant: 'danger' };
}

/* 账号审批状态：自助注册的账号要先过这一关才能登录 */
const USER_STATUS_KEYS: Record<string, StatusTableEntry> = {
  active: { key: 'status.user.active', variant: 'success' },
  pending: { key: 'status.user.pending', variant: 'warning', pulse: true },
  rejected: { key: 'status.user.rejected', variant: 'danger' },
};

export function userStatusMeta(
  status: string | null | undefined,
  t: TFunc,
): StatusMeta {
  // 老接口不返回 status，按「正常」处理，避免无端冒出一个待审批标记
  return resolveStatus(USER_STATUS_KEYS, status ?? 'active', t);
}

/** 是否属于「还没通过审批」的账号（列表里需要高亮提示） */
export function isPendingApproval(status?: string | null): boolean {
  return status === 'pending';
}

/* ---------------------------------------------------------------------------
   角色
   --------------------------------------------------------------------------- */

const ROLE_KEYS: Record<string, StatusTableEntry> = {
  admin: { key: 'status.role.admin', variant: 'accent' },
  // 与后端 BUILTIN_ROLE_NAMES 保持一致（后端就叫「普通用户」），
  // 否则同一个角色在徽标里叫一个名、在别处叫另一个名。
  operator: { key: 'status.role.operator', variant: 'info' },
  viewer: { key: 'status.role.viewer', variant: 'neutral' },
};

export function roleMeta(role: string | null | undefined, t: TFunc): StatusMeta {
  // 自定义角色名原样显示（它是用户自己起的名字，不该被翻译）
  return resolveStatus(ROLE_KEYS, role, t);
}

/* ---------------------------------------------------------------------------
   网卡类型
   --------------------------------------------------------------------------- */

const NET_TYPE_KEYS: Record<string, MessageKey> = {
  bridge: 'status.net.bridge',
  OVSBridge: 'status.net.ovsBridge',
  bond: 'status.net.bond',
  OVSBond: 'status.net.ovsBond',
  eth: 'status.net.eth',
  vlan: 'status.net.vlan',
  alias: 'status.net.alias',
  OVSPort: 'status.net.ovsPort',
  OVSIntPort: 'status.net.ovsIntPort',
  unknown: 'status.unknown',
};

export function netTypeLabel(type: string | null | undefined, t: TFunc): string {
  if (!type) return t('status.unknown');
  const key = NET_TYPE_KEYS[type];
  return key ? t(key) : type;
}

/** 桥接类网卡（可作为 VM 网桥使用）*/
export function isBridgeType(type?: string | null): boolean {
  return type === 'bridge' || type === 'OVSBridge';
}

/** 物理网卡（可作为桥接端口）*/
export function isPhysicalType(type?: string | null): boolean {
  return type === 'eth' || type === 'bond' || type === 'OVSPort';
}

/* ---------------------------------------------------------------------------
   内容类型（存储）
   --------------------------------------------------------------------------- */

const CONTENT_KEYS: Record<string, MessageKey> = {
  images: 'status.content.images',
  rootdir: 'status.content.rootdir',
  iso: 'status.content.iso',
  backup: 'status.content.backup',
  vztmpl: 'status.content.vztmpl',
  snippets: 'status.content.snippets',
  vm: 'status.content.images',
};

export function contentLabel(
  content: string | null | undefined,
  t: TFunc,
): string {
  if (!content) return '—';
  const items = content.split(/[,;]/).map((c) => c.trim()).filter(Boolean);
  return items.map((c) => (CONTENT_KEYS[c] ? t(CONTENT_KEYS[c]) : c)).join(' / ');
}

/* ---------------------------------------------------------------------------
   OS 类型
   --------------------------------------------------------------------------- */

/* 下面这些选项组的 label 要随语言变，所以做成接收 t 的工厂函数：
   模块级常量拿不到当前语言，得由调用点把 t 传进来。 */
export function ostypeOptions(t: TFunc) {
  return [
    { label: t('opt.osL26'), value: 'l26' },
    { label: t('opt.osL24'), value: 'l24' },
    { label: t('opt.osWin11'), value: 'win11' },
    { label: t('opt.osWin10'), value: 'win10' },
    { label: t('opt.osWin8'), value: 'win8' },
    { label: t('opt.osWin7'), value: 'win7' },
    { label: t('opt.osOther'), value: 'other' },
  ];
}

const OSTYPE_KEYS: Record<string, MessageKey> = {
  l26: 'status.ostype.l26',
  l24: 'status.ostype.l24',
  win11: 'status.ostype.win11',
  win10: 'status.ostype.win10',
  win8: 'status.ostype.win8',
  win7: 'status.ostype.win7',
  other: 'status.ostype.other',
  w2k8: 'status.ostype.w2k8',
  wxp: 'status.ostype.wxp',
  solaris: 'status.ostype.solaris',
};

export function ostypeLabel(
  ostype: string | null | undefined,
  t: TFunc,
): string {
  if (!ostype) return '—';
  const key = OSTYPE_KEYS[ostype];
  return key ? t(key) : ostype;
}

/** PVE 的 Windows 系 ostype（与后端 vmconfig.VALID_OSTYPES 中的那批对齐） */
const WINDOWS_OSTYPES = new Set([
  'wxp',
  'w2k',
  'w2k3',
  'w2k8',
  'wvista',
  'win7',
  'win8',
  'win10',
  'win11',
]);

/**
 * 是不是 Windows 系客户机。
 *
 * 不只是显示问题：**官方 cloud-init 装不到 Windows 原生系统上**，Windows 上跑
 * 初始化的是 Cloudbase-Init。文案、默认开关、能不能下发静态 IP 都要按它分流，
 * 所以判断只留这一处（别在各页面里写 `ostype.startsWith('win')` —— `wxp`/`w2k8`
 * 这些老系统就漏了）。
 */
export function isWindowsOstype(ostype?: string | null): boolean {
  return WINDOWS_OSTYPES.has(String(ostype ?? '').trim().toLowerCase());
}

/** 客户机初始化工具的正式名字：Windows 是 Cloudbase-Init，其余是 Cloud-Init */
export function initAgentName(ostype?: string | null): string {
  return isWindowsOstype(ostype) ? 'Cloudbase-Init' : 'Cloud-Init';
}

/* ---------------------------------------------------------------------------
   磁盘总线 / 网卡型号常量（向导用）
   --------------------------------------------------------------------------- */

export const DISK_INTERFACE_OPTIONS = [
  { label: 'SCSI (virtio-scsi)', value: 'scsi' },
  { label: 'VirtIO Block', value: 'virtio' },
  { label: 'SATA', value: 'sata' },
  { label: 'IDE', value: 'ide' },
] as const;

export const DISK_FORMAT_OPTIONS = [
  { label: 'raw', value: 'raw' },
  { label: 'qcow2', value: 'qcow2' },
  { label: 'vmdk', value: 'vmdk' },
] as const;

export const SCSIHW_OPTIONS = [
  { label: 'VirtIO SCSI single', value: 'virtio-scsi-single' },
  { label: 'VirtIO SCSI', value: 'virtio-scsi-pci' },
  { label: 'LSI 53C895A', value: 'lsi' },
  { label: 'LSI 53C810', value: 'lsi53c810' },
  { label: 'MegaRAID SAS', value: 'megasas' },
  { label: 'VMware PVSCSI', value: 'pvscsi' },
] as const;

export function netModelOptions(t: TFunc) {
  return [
    { label: t('opt.netVirtio'), value: 'virtio' },
    { label: 'Intel E1000', value: 'e1000' },
    { label: 'VMware vmxnet3', value: 'vmxnet3' },
    { label: 'Realtek RTL8139', value: 'rtl8139' },
  ];
}

export function biosOptions(t: TFunc) {
  return [
    { label: t('opt.biosSeabios'), value: 'seabios' },
    { label: t('opt.biosOvmf'), value: 'ovmf' },
  ];
}

export function machineOptions(t: TFunc) {
  return [
    { label: t('opt.machinePc'), value: 'pc' },
    { label: t('opt.machineQ35'), value: 'q35' },
  ];
}

/* 高级硬件：NUMA 绑定与 EFI/TPM（Windows 11 必需）。仅在有 hostnodes 时生效。 */
export function numaPolicyOptions(t: TFunc) {
  return [
    { label: t('opt.numaBind'), value: 'bind' },
    { label: t('opt.numaInterleave'), value: 'interleave' },
    { label: t('opt.numaPreferred'), value: 'preferred' },
  ];
}

export function efiTypeOptions(t: TFunc) {
  return [
    { label: t('opt.efi4m'), value: '4m' },
    { label: t('opt.efi2m'), value: '2m' },
  ];
}

export function tpmVersionOptions(t: TFunc) {
  return [
    { label: t('opt.tpm2'), value: 'v2.0' },
    { label: t('opt.tpm12'), value: 'v1.2' },
  ];
}

export function cpuTypeOptions(t: TFunc) {
  return [
    { label: t('opt.cpuHost'), value: 'host' },
    { label: t('opt.cpuKvm64'), value: 'kvm64' },
    { label: 'x86-64-v2-AES', value: 'x86-64-v2-AES' },
    { label: 'x86-64-v3', value: 'x86-64-v3' },
    { label: 'Nehalem', value: 'Nehalem' },
    { label: 'Westmere', value: 'Westmere' },
    { label: 'SandyBridge', value: 'SandyBridge' },
    { label: 'Haswell', value: 'Haswell' },
    { label: 'Skylake-Client', value: 'Skylake-Client' },
    { label: 'EPYC', value: 'EPYC' },
  ];
}

export function backupModeOptions(t: TFunc) {
  return [
    { label: t('opt.backupSnapshot'), value: 'snapshot' },
    { label: t('opt.backupSuspend'), value: 'suspend' },
    { label: t('opt.backupStop'), value: 'stop' },
  ];
}

export function compressOptions(t: TFunc) {
  return [
    { label: t('opt.compressZstd'), value: 'zstd' },
    { label: 'LZO', value: 'lzo' },
    { label: 'GZIP', value: 'gzip' },
    { label: t('opt.compressNone'), value: '0' },
  ];
}

export function timeframeOptions(t: TFunc) {
  return [
    { label: t('opt.tfHour'), value: 'hour' },
    { label: t('opt.tfDay'), value: 'day' },
    { label: t('opt.tfWeek'), value: 'week' },
    { label: t('opt.tfMonth'), value: 'month' },
  ];
}
