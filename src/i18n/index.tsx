/* ==========================================================================
   ProxCenter — 轻量 i18n

   为什么不用 react-i18next：面板总共两种语言、没有复数/日期/命名空间需求，
   而引入 i18next 会给首屏再加 40KB+ 体积。这里只有 Provider + 一个 t()，
   行为完全可读、可测；将来真要换 i18next，改动也只落在这个目录里
   （组件只用 `useI18n()` 与 `t(key, vars)` 两个东西）。

   约定：
   - 词条源文件是 `locales/zh-CN.ts`，`MessageKey` 由它的键推导；
   - 英文缺词条时**回退中文原文**，不显示 key、也不显示空白；
   - 语言偏好存在 localStorage，属于浏览器级界面偏好，与账号无关
     （阶段二改成跟随用户偏好时，只需换掉 readStoredLang/writeStoredLang）。
   ========================================================================== */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { zhCN, type MessageKey } from './locales/zh-CN';
import { en } from './locales/en';

export type { MessageKey };

/** 支持的语言。加语言时：补 `locales/<lang>.ts`、登记到 DICTS、加进 LANGS。 */
export type Lang = 'zh-CN' | 'en';

export const LANGS: readonly Lang[] = ['zh-CN', 'en'];

/** 与项目其它界面偏好保持同一命名前缀（pve_*）。 */
const LANG_KEY = 'pve_lang';

/** 插值变量：`t('confirm.typeToConfirm', { text: 'web-01' })` */
/*
 * 插值变量允许 null / undefined：调用点取的常是 `可选数据?.字段`（弹窗还没打开时
 * target 就是 null），要求每处都补 `?? ''` 只会把噪音铺满整个调用面 —— 这里统一
 * 把空值渲染成空串。
 */
export type TVars = Record<string, string | number | null | undefined>;

export type TFunc = (key: MessageKey, vars?: TVars) => string;

export interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TFunc;
}

const I18nContext = createContext<I18nValue | null>(null);

const DICTS: Record<Lang, Partial<Record<MessageKey, string>>> = {
  'zh-CN': zhCN,
  en,
};

export function isLang(value: unknown): value is Lang {
  return value === 'zh-CN' || value === 'en';
}

function readStoredLang(): Lang | null {
  try {
    const raw = localStorage.getItem(LANG_KEY);
    return isLang(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 初始语言：存过就用存的，否则按浏览器语言判断 ——
 * 非中文环境直接给英文界面，中文环境（含判断不出来）保持现状。
 */
export function detectLang(): Lang {
  const stored = readStoredLang();
  if (stored) return stored;
  try {
    const nav = typeof navigator !== 'undefined' ? navigator.language : '';
    if (nav && !nav.toLowerCase().startsWith('zh')) return 'en';
  } catch {
    /* 忽略：拿不到语言就按中文 */
  }
  return 'zh-CN';
}

/**
 * 模块级语言快照：只为**拿不到 hook** 的地方存在（表格列定义回调、工具函数）。
 *
 * 为什么需要它：`utils/status.ts` 那类表驱动文案是在列定义回调里求值的，那儿既不是
 * 组件顶层、回调参数又常叫 `t`（`render: (t) => ...`），硬塞 hook 会连着一堆签名
 * 一起改。折中方案是：
 *   · Provider 每次语言变化都同步这个快照（见下）；
 *   · 需要文案的地方调 `tStatic()`，读到的一定是当前语言；
 *   · 代价：**只有重渲染的组件**才会用上新值 —— 没有订阅 i18n 的页面在切换语言后
 *     要等下一次重渲染（导航、刷新）才更新。页面自身翻译时请改用 `useT()`，
 *     那时连这个限制都不存在。
 */
let activeLang: Lang = detectLang();

/** 模块级取词；语义与 useT() 返回的 t 完全一致 */
export function tStatic(key: MessageKey, vars?: TVars): string {
  return interpolate(DICTS[activeLang][key] ?? zhCN[key], vars);
}

/** 当前语言的快照；给拿不到 hook 的工具函数用（如 utils/format 的本地化） */
export function getLang(): Lang {
  return activeLang;
}

/** `{name}` 占位符替换；找不到对应变量时原样保留，便于一眼看出漏传。 */
function interpolate(text: string, vars?: TVars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    /* 键不存在 = 漏传，原样留着便于一眼看出；值为空 = 正常情况，渲染空串 */
    if (!(name in vars)) return match;
    const value = vars[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  /* 同步模块级快照（tStatic）：在返回 children 之前赋值，所以本轮渲染里子组件
     调 tStatic 读到的就是新语言。幂等，StrictMode 下重复执行无副作用。 */
  activeLang = lang;

  /* 同步 <html lang>：读屏软件与浏览器的翻译/断词都依赖它 */
  useEffect(() => {
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* 忽略：隐私模式下写不了 localStorage 不影响本次会话 */
    }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang;
    }
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState((current) => (current === next ? current : next));
  }, []);

  const t = useCallback<TFunc>(
    (key, vars) => {
      /* 英文表是 Partial：没翻的键回退中文原文，而不是露出 key */
      const text = DICTS[lang][key] ?? zhCN[key];
      return interpolate(text, vars);
    },
    [lang],
  );

  const value = useMemo<I18nValue>(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n 必须在 <I18nProvider> 内使用');
  }
  return ctx;
}

/** 只关心翻译函数的组件用这个，少写一次解构。 */
export function useT(): TFunc {
  return useI18n().t;
}
