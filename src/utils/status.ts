/* ==========================================================================
   ProxCenter — 状态映射工具
   ========================================================================== */

import type { BadgeVariant, TaskStatus, VmStatus } from '../api/types';

export interface StatusMeta {
  /** 显示文案 */
  label: string;
  /** 徽章变体 */
  variant: BadgeVariant;
  /** 圆点是否脉冲（运行中）*/
  pulse?: boolean;
}

/* ---------------------------------------------------------------------------
   VM 状态
   --------------------------------------------------------------------------- */

const VM_STATUS_MAP: Record<string, StatusMeta> = {
  running: { label: '运行中', variant: 'success', pulse: true },
  stopped: { label: '已停止', variant: 'neutral' },
  paused: { label: '已暂停', variant: 'warning' },
  suspended: { label: '已挂起', variant: 'warning' },
  stopping: { label: '正在停止', variant: 'warning', pulse: true },
  starting: { label: '正在启动', variant: 'info', pulse: true },
  unknown: { label: '未知', variant: 'neutral' },
};

export function vmStatusMeta(status?: VmStatus | null): StatusMeta {
  if (!status) return { label: '未知', variant: 'neutral' };
  return VM_STATUS_MAP[status] ?? { label: status, variant: 'neutral' };
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

const NODE_STATUS_MAP: Record<string, StatusMeta> = {
  online: { label: '在线', variant: 'success', pulse: true },
  offline: { label: '离线', variant: 'danger' },
  unknown: { label: '未知', variant: 'neutral' },
};

export function nodeStatusMeta(status?: string | null): StatusMeta {
  if (!status) return { label: '未知', variant: 'neutral' };
  return NODE_STATUS_MAP[status] ?? { label: status, variant: 'neutral' };
}

/* ---------------------------------------------------------------------------
   任务状态
   --------------------------------------------------------------------------- */

const TASK_STATUS_MAP: Record<string, StatusMeta> = {
  running: { label: '执行中', variant: 'info', pulse: true },
  stopped: { label: '已结束', variant: 'neutral' },
  unknown: { label: '未知', variant: 'neutral' },
};

export function taskStatusMeta(
  status?: TaskStatus | null,
  exitstatus?: string | null,
): StatusMeta {
  // 已结束的任务，用 exitstatus 判断成功/失败
  if (status === 'stopped') {
    if (!exitstatus) return { label: '已结束', variant: 'neutral' };
    return taskExitMeta(exitstatus);
  }
  if (!status) return { label: '未知', variant: 'neutral' };
  return TASK_STATUS_MAP[status] ?? { label: status, variant: 'neutral' };
}

/** exitstatus: "OK" 为成功，其余（含 "WARNINGS"）为失败/警告 */
export function taskExitMeta(exitstatus: string): StatusMeta {
  if (exitstatus === 'OK') return { label: '成功', variant: 'success' };
  if (exitstatus.startsWith('WARNINGS')) {
    return { label: '有警告', variant: 'warning' };
  }
  return { label: '失败', variant: 'danger' };
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

export function storageStatusMeta(active?: boolean | null): StatusMeta {
  if (active === undefined || active === null) {
    return { label: '未知', variant: 'neutral' };
  }
  return active
    ? { label: '已激活', variant: 'success' }
    : { label: '未激活', variant: 'danger' };
}

/* ---------------------------------------------------------------------------
   审计结果
   --------------------------------------------------------------------------- */

const AUDIT_RESULT_MAP: Record<string, StatusMeta> = {
  success: { label: '成功', variant: 'success' },
  ok: { label: '成功', variant: 'success' },
  failure: { label: '失败', variant: 'danger' },
  failed: { label: '失败', variant: 'danger' },
  error: { label: '错误', variant: 'danger' },
  denied: { label: '拒绝', variant: 'warning' },
};

export function auditResultMeta(result?: string | null): StatusMeta {
  if (!result) return { label: '未知', variant: 'neutral' };
  return (
    AUDIT_RESULT_MAP[result.toLowerCase()] ?? {
      label: result,
      variant: 'neutral',
    }
  );
}

/* ---------------------------------------------------------------------------
   面板用户状态
   --------------------------------------------------------------------------- */

export function userEnabledMeta(enabled?: boolean | null): StatusMeta {
  if (enabled === undefined || enabled === null) {
    return { label: '未知', variant: 'neutral' };
  }
  return enabled
    ? { label: '已启用', variant: 'success' }
    : { label: '已禁用', variant: 'danger' };
}

/* 账号审批状态：自助注册的账号要先过这一关才能登录 */
const USER_STATUS_MAP: Record<string, StatusMeta> = {
  active: { label: '正常', variant: 'success' },
  pending: { label: '待审批', variant: 'warning', pulse: true },
  rejected: { label: '已拒绝', variant: 'danger' },
};

export function userStatusMeta(status?: string | null): StatusMeta {
  // 老接口不返回 status，按「正常」处理，避免无端冒出一个待审批标记
  if (!status) return USER_STATUS_MAP.active;
  return USER_STATUS_MAP[status] ?? { label: status, variant: 'neutral' };
}

/** 是否属于「还没通过审批」的账号（列表里需要高亮提示） */
export function isPendingApproval(status?: string | null): boolean {
  return status === 'pending';
}

/* ---------------------------------------------------------------------------
   角色
   --------------------------------------------------------------------------- */

const ROLE_MAP: Record<string, StatusMeta> = {
  admin: { label: '管理员', variant: 'accent' },
  // 与后端 BUILTIN_ROLE_NAMES 保持一致（后端就叫「普通用户」），
  // 否则同一个角色在徽标里叫一个名、在别处叫另一个名。
  operator: { label: '普通用户', variant: 'info' },
  viewer: { label: '只读', variant: 'neutral' },
};

export function roleMeta(role?: string | null): StatusMeta {
  if (!role) return { label: '未知', variant: 'neutral' };
  return ROLE_MAP[role] ?? { label: role, variant: 'neutral' };
}

/* ---------------------------------------------------------------------------
   网卡类型
   --------------------------------------------------------------------------- */

const NET_TYPE_LABEL: Record<string, string> = {
  bridge: 'Linux 网桥',
  OVSBridge: 'OVS 网桥',
  bond: '网卡绑定',
  OVSBond: 'OVS 绑定',
  eth: '物理网卡',
  vlan: 'VLAN',
  alias: '别名',
  OVSPort: 'OVS 端口',
  OVSIntPort: 'OVS 内部端口',
  unknown: '未知',
};

export function netTypeLabel(type?: string | null): string {
  if (!type) return '未知';
  return NET_TYPE_LABEL[type] ?? type;
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

const CONTENT_LABEL: Record<string, string> = {
  images: 'VM 磁盘',
  rootdir: '容器磁盘',
  iso: 'ISO 镜像',
  backup: '备份',
  vztmpl: '容器模板',
  snippets: '代码片段',
  vm: 'VM 磁盘',
};

export function contentLabel(content?: string | null): string {
  if (!content) return '—';
  const items = content.split(/[,;]/).map((c) => c.trim()).filter(Boolean);
  return items.map((c) => CONTENT_LABEL[c] ?? c).join(' / ');
}

/* ---------------------------------------------------------------------------
   OS 类型
   --------------------------------------------------------------------------- */

export const OSTYPE_OPTIONS = [
  { label: 'Linux 6.x / 5.x 内核', value: 'l26' },
  { label: 'Linux 2.4 内核（旧）', value: 'l24' },
  { label: 'Windows 11 / Server 2022', value: 'win11' },
  { label: 'Windows 10 / Server 2016-2019', value: 'win10' },
  { label: 'Windows 8 / Server 2012', value: 'win8' },
  { label: 'Windows 7 / Server 2008', value: 'win7' },
  { label: '其他', value: 'other' },
] as const;

const OSTYPE_LABEL: Record<string, string> = {
  l26: 'Linux 6.x',
  l24: 'Linux 2.4',
  win11: 'Windows 11',
  win10: 'Windows 10',
  win8: 'Windows 8',
  win7: 'Windows 7',
  other: '其他',
  w2k8: 'Windows 2008',
  wxp: 'Windows XP',
  solaris: 'Solaris',
};

export function ostypeLabel(ostype?: string | null): string {
  if (!ostype) return '—';
  return OSTYPE_LABEL[ostype] ?? ostype;
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

export const NET_MODEL_OPTIONS = [
  { label: 'VirtIO (半虚拟化，最快)', value: 'virtio' },
  { label: 'Intel E1000', value: 'e1000' },
  { label: 'VMware vmxnet3', value: 'vmxnet3' },
  { label: 'Realtek RTL8139', value: 'rtl8139' },
] as const;

export const BIOS_OPTIONS = [
  { label: 'SeaBIOS (默认)', value: 'seabios' },
  { label: 'OVMF (UEFI)', value: 'ovmf' },
] as const;

export const MACHINE_OPTIONS = [
  { label: 'i440fx (默认)', value: 'pc' },
  { label: 'q35 (PCIe，推荐 Win11)', value: 'q35' },
] as const;

/* 高级硬件：NUMA 绑定与 EFI/TPM（Windows 11 必需）。仅在有 hostnodes 时生效。 */
export const NUMA_POLICY_OPTIONS = [
  { label: 'bind（只在指定宿主节点上分配）', value: 'bind' },
  { label: 'interleave（在宿主节点间轮转）', value: 'interleave' },
  { label: 'preferred（优先指定节点，不足时回落）', value: 'preferred' },
] as const;

export const EFI_TYPE_OPTIONS = [
  { label: '4m（支持预置安全启动密钥，Win11 用）', value: '4m' },
  { label: '2m（旧格式，不支持预置密钥）', value: '2m' },
] as const;

export const TPM_VERSION_OPTIONS = [
  { label: 'v2.0（Windows 11 要求）', value: 'v2.0' },
  { label: 'v1.2（旧系统）', value: 'v1.2' },
] as const;

export const CPU_TYPE_OPTIONS = [
  { label: 'host (透传，性能最佳)', value: 'host' },
  { label: 'kvm64 (兼容性最好)', value: 'kvm64' },
  { label: 'x86-64-v2-AES', value: 'x86-64-v2-AES' },
  { label: 'x86-64-v3', value: 'x86-64-v3' },
  { label: 'Nehalem', value: 'Nehalem' },
  { label: 'Westmere', value: 'Westmere' },
  { label: 'SandyBridge', value: 'SandyBridge' },
  { label: 'Haswell', value: 'Haswell' },
  { label: 'Skylake-Client', value: 'Skylake-Client' },
  { label: 'EPYC', value: 'EPYC' },
] as const;

export const BACKUP_MODE_OPTIONS = [
  { label: 'Snapshot（不中断）', value: 'snapshot' },
  { label: 'Suspend（短暂挂起）', value: 'suspend' },
  { label: 'Stop（停止后备份）', value: 'stop' },
] as const;

export const COMPRESS_OPTIONS = [
  { label: 'ZSTD (推荐)', value: 'zstd' },
  { label: 'LZO', value: 'lzo' },
  { label: 'GZIP', value: 'gzip' },
  { label: '不压缩', value: '0' },
] as const;

export const TIMEFRAME_OPTIONS = [
  { label: '最近 1 小时', value: 'hour' },
  { label: '最近 1 天', value: 'day' },
  { label: '最近 1 周', value: 'week' },
  { label: '最近 1 月', value: 'month' },
] as const;
