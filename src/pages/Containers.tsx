/* ==========================================================================
   ProxCenter — 容器列表页（LXC）
   ==========================================================================

与「虚拟机」页**相互独立**：这里只列容器（GET /lxc），创建按钮走容器自己的
向导（系统模板 + rootfs），详情页也跳到 /lxc/:node/:vmid。虚拟机页那边同理，
只列 qemu。两边共用 GuestList.tsx 的实现，按 kind 区分文案与能力差异。
*/

import { GuestListPage } from './GuestList';

export function Containers() {
  return <GuestListPage kind="lxc" />;
}
