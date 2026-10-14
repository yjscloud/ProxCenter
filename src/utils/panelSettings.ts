/* ==========================================================================
   ProxCenter — 面板本地设置（只存在这台浏览器里）

   三项：数据刷新间隔 / 列表每页条数 / 时区。都只影响**当前浏览器**（换浏览器或
   清掉站点数据就回默认），所以存 localStorage 而不是服务端 —— 也因此它们与
   「服务端配置」那一组卡片是两回事。

   这个模块是这三项的**唯一读取口**，每项各有一个取值函数：

     * panelRefreshMs()  → 各处的轮询间隔（配 hooks/useRefreshInterval 用）
     * panelPageSize()   → 分页列表的初始每页条数（配 hooks/usePaged 用）
     * panelTimeZone()   → 日期时间按哪个时区展示（配 utils/format 用）

   为什么单独一个模块：这三项原先存在 api/endpoints.ts 里，而且**只有设置页自己
   读得到** —— 于是「在设置里改了，别的页面没反应」是常态（分页条写死 20、轮询
   写死 30 秒、日期用本机时区）。读取口集中在这里之后，「谁在用这个设置」一查
   便知，也方便以后再加一项。

   读取一律带兜底：localStorage 被手改过、或是旧版本留下的脏值时按默认走，
   不让某个页面因为一个坏值直接报错。
   ========================================================================== */

import type { PanelSettings } from '../api/types';

const SETTINGS_KEY = 'pve_panel_settings';

/** 兜底值：环境变量没给、或存的值坏掉时用 */
const FALLBACK_REFRESH_MS = 30_000;
const FALLBACK_PAGE_SIZE = 20;

export const defaultSettings: PanelSettings = {
  /* 刷新间隔的兜底从 10 秒改成了 30 秒。
     10 秒这个默认值是在「设置还没接上任何页面」的时候定的，也就是它从来没
     真正生效过；一旦接上（全站几十个查询都按它轮询），10 秒会让每个开着面板
     的人的请求量翻几倍 —— 而面板每个请求都要打后端甚至 PVE。30 秒与本项目
     绝大多数轮询原本的节奏一致，不接设置时的观感与负载与从前相同。 */
  refreshInterval: Number(import.meta.env.VITE_REFRESH_INTERVAL) || FALLBACK_REFRESH_MS,
  pageSize: Number(import.meta.env.VITE_PAGE_SIZE) || FALLBACK_PAGE_SIZE,
  timezone: browserTimeZone(),
};

/** 本机（浏览器）时区。设置里留空、或填了一个无效值时回落到它 */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
}

/**
 * 进程内缓存。
 *
 * 必须有：`formatDateTime` 这类函数一页要调几百次，每次都 `localStorage.getItem`
 * + `JSON.parse` 是白扔的性能。写入与「设置变更」都会更新/作废它，所以读不到旧值；
 * 另一个标签页改了设置则由 `storage` 事件作废（该事件只在**别的**标签页触发，
 * 本页改动走 saveSettings）。
 */
let cached: PanelSettings | null = null;

export function loadSettings(): PanelSettings {
  if (cached) return cached;
  let next: PanelSettings;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    next = raw
      ? { ...defaultSettings, ...(JSON.parse(raw) as Partial<PanelSettings>) }
      : defaultSettings;
  } catch {
    /* 隐私模式 / 脏数据：按默认走，不影响使用 */
    next = defaultSettings;
  }
  cached = next;
  return cached;
}

export function saveSettings(settings: PanelSettings): void {
  cached = { ...settings };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 忽略 */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === SETTINGS_KEY) cached = null;
  });
}

/**
 * 设置变更事件：设置页保存 / 恢复默认之后派发，**已经在页面上的**轮询据此改用
 * 新值（见 hooks/useRefreshInterval）。
 *
 * 分页条数与时区不需要它：那两项是渲染时读一次，换个页面重新挂载就会重读。
 * 轮询不同 —— 顶栏、通知铃铛这些组件在切页时并不卸载，不通知就一直按老节奏跑。
 */
export const SETTINGS_CHANGED_EVENT = 'ProxCenter:settings-changed';

export function notifySettingsChanged(): void {
  /* 缓存一并作废：调用方未必先走过 saveSettings（例如从外部改完再广播） */
  cached = null;
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
}

/**
 * 轮询间隔（毫秒）。设为 0 表示「不自动刷新」，此时返回 `false` ——
 * 直接喂给 react-query 的 `refetchInterval` 即可（0 会被它当成「没设」）。
 */
export function panelRefreshMs(): number | false {
  const ms = Number(loadSettings().refreshInterval);
  return Number.isFinite(ms) && ms > 0 ? ms : false;
}

/** 列表的初始每页条数（分页条上仍可临时改成别的） */
export function panelPageSize(): number {
  const size = Number(loadSettings().pageSize);
  return Number.isFinite(size) && size > 0
    ? Math.trunc(size)
    : FALLBACK_PAGE_SIZE;
}

/**
 * 展示用的时区。
 *
 * 填了无效值时回落到本机时区，而不是抛错 —— 一个拼错的时区（"Asia/Shangai"）
 * 不该让整页时间显示变成一片报错。设置页那里会同步提示「这个时区名无效」。
 */
export function panelTimeZone(): string {
  const tz = String(loadSettings().timezone ?? '').trim();
  if (!tz) return browserTimeZone();
  return isValidTimeZone(tz) ? tz : browserTimeZone();
}

/** 是否是 Intl 认得的时区名（设置页用它做即时校验） */
export function isValidTimeZone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}
