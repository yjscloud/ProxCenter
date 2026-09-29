/* ==========================================================================
   ProxCenter — guest 统一入口（虚拟机 / 容器）
   ==========================================================================

「虚拟机」列表页会把**虚拟机（qemu）与容器（lxc）混排**展示。两者在 PVE 上
是两套端点，逐个调用点写 `type === 'lxc' ? lxcApi : vmsApi` 迟早会漏掉一处
（漏了的表现是：对容器发 qemu 接口 → 404，或者更糟，同名 VMID 打到了另一台
机器上）。因此把「按类型分派」收在这一处，调用方只管传 guest。

没有收进来的操作：

* **转模板** —— 两边的端点都真实存在（`/vms/.../template` 与 `/lxc/.../template`，
  后者就是 `pct template`，只是和 qemu 那条一样**没列在 PVE 的 API 索引里**，
  早年据此判定「容器不能转模板」是错的，见 pct(1)）；调用方按类型各自调用，
  不在这里统一请求体（本操作没有请求体）；
* **克隆** —— 两边的入参不同（虚拟机有 full / target_storage，容器没有
  链接克隆），各自用各自的请求体，不强行统一；
* **硬件增删** —— 磁盘（scsiN）与挂载点（mpN）语义不同，分开调用。
*/

import {
  lxcApi,
  lxcVncWsUrl,
  vmsApi,
  vncWsUrl,
} from './endpoints';
import { guestTypeOf } from './types';
import type { Snapshot, SnapshotCreateRequest, TaskInfo } from './types';

/** 足以定位一个 guest 的最小信息；`type` 缺失时按虚拟机处理。 */
export interface GuestRef {
  node: string;
  vmid: number;
  type?: string;
}

interface TaskResponseLike {
  task?: string;
}

function isLxc(guest: GuestRef): boolean {
  return guestTypeOf(guest) === 'lxc';
}

/* 列表页也要按类型筛（全部 / 虚拟机 / 容器），直接转出去省一次 import */
export { guestTypeOf };

/* ---------------------------------------------------------------------------
   详情页路由
   --------------------------------------------------------------------------- */

/** 容器走 /lxc/:node/:vmid，虚拟机走 /vms/:node/:vmid */
export function guestPath(guest: GuestRef): string {
  const family = isLxc(guest) ? 'lxc' : 'vms';
  return `/${family}/${encodeURIComponent(guest.node)}/${guest.vmid}`;
}

export function isContainer(guest: GuestRef): boolean {
  return isLxc(guest);
}

/* ---------------------------------------------------------------------------
   电源操作（两边动作集合一致，容器没有 hibernate）
   --------------------------------------------------------------------------- */

export const guestPower = {
  start: (g: GuestRef): Promise<TaskResponseLike> =>
    isLxc(g) ? lxcApi.start(g.node, g.vmid) : vmsApi.start(g.node, g.vmid),
  stop: (g: GuestRef): Promise<TaskResponseLike> =>
    isLxc(g) ? lxcApi.stop(g.node, g.vmid) : vmsApi.stop(g.node, g.vmid),
  shutdown: (g: GuestRef, timeout?: number, forceStop?: boolean) =>
    isLxc(g)
      ? lxcApi.shutdown(g.node, g.vmid, timeout, forceStop)
      : vmsApi.shutdown(g.node, g.vmid, timeout, forceStop),
  reboot: (g: GuestRef): Promise<TaskResponseLike> =>
    isLxc(g) ? lxcApi.reboot(g.node, g.vmid) : vmsApi.reboot(g.node, g.vmid),
  suspend: (g: GuestRef): Promise<TaskResponseLike> =>
    isLxc(g) ? lxcApi.suspend(g.node, g.vmid) : vmsApi.suspend(g.node, g.vmid),
  resume: (g: GuestRef): Promise<TaskResponseLike> =>
    isLxc(g) ? lxcApi.resume(g.node, g.vmid) : vmsApi.resume(g.node, g.vmid),
};

/* ---------------------------------------------------------------------------
   删除 / 迁移 / 快照 / 监控 / 归属
   --------------------------------------------------------------------------- */

export const guestsApi = {
  /** 删除。运行中的 guest 会被后端以 409 拦下（除非显式 force） */
  remove: (g: GuestRef, purge = true): Promise<TaskResponseLike> =>
    isLxc(g)
      ? lxcApi.delete(g.node, g.vmid, purge)
      : vmsApi.delete(g.node, g.vmid, purge),

  migrate: (g: GuestRef, targetNode: string, online = false) =>
    isLxc(g)
      ? lxcApi.migrate(g.node, g.vmid, { target_node: targetNode, online })
      : vmsApi.migrate(g.node, g.vmid, { target_node: targetNode, online }),

  snapshots: (g: GuestRef): Promise<Snapshot[]> =>
    isLxc(g) ? lxcApi.snapshots(g.node, g.vmid) : vmsApi.snapshots(g.node, g.vmid),

  createSnapshot: (g: GuestRef, body: SnapshotCreateRequest) =>
    isLxc(g)
      ? lxcApi.createSnapshot(g.node, g.vmid, body)
      : vmsApi.createSnapshot(g.node, g.vmid, body),

  rollbackSnapshot: (g: GuestRef, name: string) =>
    isLxc(g)
      ? lxcApi.rollbackSnapshot(g.node, g.vmid, name)
      : vmsApi.rollbackSnapshot(g.node, g.vmid, name),

  deleteSnapshot: (g: GuestRef, name: string): Promise<TaskResponseLike> =>
    isLxc(g)
      ? lxcApi.deleteSnapshot(g.node, g.vmid, name)
      : vmsApi.deleteSnapshot(g.node, g.vmid, name),

  rrddata: (g: GuestRef, timeframe: 'hour' | 'day' | 'week' | 'month' | 'year' = 'hour') =>
    isLxc(g)
      ? lxcApi.rrddata(g.node, g.vmid, timeframe)
      : vmsApi.rrddata(g.node, g.vmid, timeframe),

  pending: (g: GuestRef) =>
    isLxc(g) ? lxcApi.pending(g.node, g.vmid) : vmsApi.pending(g.node, g.vmid),

  /* 归属指派（管理员）：后端对两种 guest 用同一张归属表 */
  getOwner: (g: GuestRef, connectionId?: string) =>
    isLxc(g)
      ? lxcApi.getOwner(g.node, g.vmid, connectionId)
      : vmsApi.getOwner(g.node, g.vmid, connectionId),

  assignOwner: (g: GuestRef, username: string | null, connectionId?: string) =>
    isLxc(g)
      ? lxcApi.assignOwner(g.node, g.vmid, username, connectionId)
      : vmsApi.assignOwner(g.node, g.vmid, username, connectionId),

  /**
   * 改名。
   *
   * 两边的字段名不同：虚拟机的显示名是 ``name``；容器没有独立的 name ——
   * 它在 PVE 里的「名字」就是主机名 ``hostname``（面板列表展示的也是它）。
   * 只提交这一个字段：PVE 的 config 接口是增量语义，改哪项传哪项。
   */
  rename: (g: GuestRef, name: string): Promise<TaskResponseLike> =>
    isLxc(g)
      ? lxcApi.updateConfig(g.node, g.vmid, { hostname: name })
      : vmsApi.updateConfig(g.node, g.vmid, { name }),

  /**
   * 该类 guest 的下发额度读数。虚拟机与容器各有一份额度，
   * 所以按类型取即可，不需要具体的 guest 对象。
   */
  quota: (kind: 'vm' | 'lxc') => (kind === 'lxc' ? lxcApi.quota() : vmsApi.quota()),

  /* 控制台（只有 VNC） */
  vncProxy: (g: GuestRef) =>
    isLxc(g) ? lxcApi.vncProxy(g.node, g.vmid) : vmsApi.vncProxy(g.node, g.vmid),

  vncWsUrl: (g: GuestRef, port: number, ticket: string): string =>
    isLxc(g)
      ? lxcVncWsUrl(g.node, g.vmid, port, ticket)
      : vncWsUrl(g.node, g.vmid, port, ticket),
};

/* TaskInfo 仅用于类型导出，避免调用方再从 types 里单独引一次 */
export type { TaskInfo };
