/* ==========================================================================
   ProxCenter — 关机 / 停止 / 重启 / 挂起前的二次确认文案
   ==========================================================================
   这四件事都会让机器上的服务立刻中断，而列表页与详情页把它们做成了一排图标
   按钮 —— 误点一次就是一次事故。启动 / 恢复没有这个风险，不拦。

   列表页、虚拟机详情、容器详情共用这里的构造，免得三处各写一套之后口径漂移，
   尤其是「停止 = 强制断电」「关机 = 优雅关机」「挂起 = 之后要手动恢复」这几个
   区别：只在该说的地方说。
   ========================================================================== */

import type { TFunc } from '../i18n';

/** 需要二次确认的电源动作（启动 / 恢复不在其中：它们不会让服务停下来） */
export type DestructivePower = 'stop' | 'shutdown' | 'reboot' | 'suspend';

export function isDestructivePower(action: string): action is DestructivePower {
  return (
    action === 'stop' ||
    action === 'shutdown' ||
    action === 'reboot' ||
    action === 'suspend'
  );
}

/** 确认框需要的几项，与 ConfirmOptions 对齐，展开即可传下去 */
export interface PowerConfirmOptions {
  title: string;
  message: string;
  confirmText: string;
  danger: boolean;
}

export interface PowerConfirmTarget {
  name?: string | null;
  vmid?: number | string | null;
}

/** 单台机器：标题点名是哪一台，说明写清这次动作的代价 */
export function powerConfirmOptions(
  t: TFunc,
  action: DestructivePower,
  target: PowerConfirmTarget,
  kind: 'qemu' | 'lxc' = 'qemu',
): PowerConfirmOptions {
  const vars = {
    name: target.name || String(target.vmid ?? ''),
    kind: t(kind === 'lxc' ? 'power.confirmKindLxc' : 'power.confirmKindVm'),
  };

  /* 「停止」是强制断电、「关机」是优雅关机：两者都让服务中断，都用危险样式；
     重启会自己回来，普通样式就够。 */
  if (action === 'stop') {
    return {
      title: t('power.confirmStopTitle', vars),
      message: t('power.confirmStopMessage'),
      confirmText: t('power.stop'),
      danger: true,
    };
  }
  if (action === 'shutdown') {
    return {
      title: t('power.confirmShutdownTitle', vars),
      message: t('power.confirmShutdownMessage'),
      confirmText: t('power.shutdown'),
      danger: true,
    };
  }
  /* 挂起不会丢数据（状态写回磁盘，可以恢复），所以不用红色；但它确实会让这台
     机器上的服务停下来、而且不会自己回来，必须让人知道要手动「恢复」。 */
  if (action === 'suspend') {
    return {
      title: t('power.confirmSuspendTitle', vars),
      message: t('power.confirmSuspendMessage'),
      confirmText: t('power.suspend'),
      danger: false,
    };
  }
  return {
    title: t('power.confirmRebootTitle', vars),
    message: t('power.confirmRebootMessage'),
    confirmText: t('power.reboot'),
    danger: false,
  };
}

/** 批量：标题里写清「对多少台做什么」—— 少写这一句，三台机器就只被当成一台看 */
export function bulkPowerConfirmOptions(
  t: TFunc,
  action: DestructivePower,
  count: number,
  unit: string,
  noun: string,
): PowerConfirmOptions {
  const label = t(
    action === 'stop'
      ? 'power.stop'
      : action === 'shutdown'
        ? 'power.shutdown'
        : 'power.reboot',
  );
  return {
    title: t('power.confirmBulkTitle', { action: label, count, unit, noun }),
    message: t('power.confirmBulkMessage', { action: label }),
    confirmText: label,
    danger: action !== 'reboot',
  };
}
