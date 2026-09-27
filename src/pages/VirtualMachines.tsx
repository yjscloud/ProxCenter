/* ==========================================================================
   ProxCenter — 虚拟机列表页
   ==========================================================================

只列**虚拟机**（qemu）。容器有自己独立的一页（/lxc，见 Containers.tsx）：
两者的列表、创建向导与详情页都是平行的，混在一起会让人分不清点进去的是哪套
页面。列表实现见 GuestList.tsx（两边共用，按 kind 区分）。
*/

import { GuestListPage } from './GuestList';

export function VirtualMachines() {
  return <GuestListPage kind="qemu" />;
}
