/* ==========================================================================
   pvecenter — 轻量 i18n

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
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { zhCore } from './locales/zh-CN.core';
import type { MessageKey } from './locales/zh-CN';

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

type Dict = Partial<Record<MessageKey, string>>;

/* 词典按「什么时候需要」分两类加载，中英各有一整套：
     · core 随主包：首屏、侧边栏、顶栏、通知、登录注册；
     · app / 各业务域 / landing 随路由懒加载，页面只取自己需要的那一份。
   core 之外的模块由 ensureDict 按当前语言选择中文还是英文表；切换语言时补拉
   新语言的全部补充表。英文表是完整的（check:i18n 强制与中文逐键对齐），任何
   一层缺失时都回退到 core / 中文原文，不会露出 key。 */
let enDict: Dict | null = null;

/* 业务页 / 官网的补充词条按路由懒加载：中文进 zhExtra，英文进 enExtra。
   加载完成前页面 chunk 也不会渲染（lazyPage 会等词典），所以不存在「先渲染
   出一片空白文案」的窗口。 */
let zhExtra: Dict = {};
let enExtra: Dict = {};

/** 词典到位时通知 Provider 重渲染，让已挂载的组件也拿到新词条。 */
let onDictChange: (() => void) | null = null;

export function setDictChangeHandler(fn: (() => void) | null): void {
  onDictChange = fn;
}

/**
 * 页面按需加载的词典分组。core 已在主包，不需要等。
 * app = 后台共享词条；其余按业务域拆分，中英各一份、同组同路由加载。
 */
export type DictGroup =
  | 'core'
  | 'app'
  | 'landing'
  | 'compute'
  | 'node'
  | 'security'
  | 'monitor'
  | 'settings'
  | 'ai';

type ExtraGroup = Exclude<DictGroup, 'core'>;

/** 分组 → 词典模块。中英各一张表；写死 import 才能让打包器拆出独立 chunk。 */
const ZH_LOADERS: Record<ExtraGroup, () => Promise<Dict>> = {
  app: () => import('./locales/zh-CN.app').then((m) => m.zhApp),
  landing: () => import('./locales/zh-CN.landing').then((m) => m.zhLanding),
  compute: () => import('./locales/zh-CN.compute').then((m) => m.zhCompute),
  node: () => import('./locales/zh-CN.node').then((m) => m.zhNode),
  security: () => import('./locales/zh-CN.security').then((m) => m.zhSecurity),
  monitor: () => import('./locales/zh-CN.monitor').then((m) => m.zhMonitor),
  settings: () => import('./locales/zh-CN.settings').then((m) => m.zhSettings),
  ai: () => import('./locales/zh-CN.ai').then((m) => m.zhAi),
};

const EN_LOADERS: Record<ExtraGroup, () => Promise<Dict>> = {
  app: () => import('./locales/en.app').then((m) => m.enApp),
  landing: () => import('./locales/en.landing').then((m) => m.enLanding),
  compute: () => import('./locales/en.compute').then((m) => m.enCompute),
  node: () => import('./locales/en.node').then((m) => m.enNode),
  security: () => import('./locales/en.security').then((m) => m.enSecurity),
  monitor: () => import('./locales/en.monitor').then((m) => m.enMonitor),
  settings: () => import('./locales/en.settings').then((m) => m.enSettings),
  ai: () => import('./locales/en.ai').then((m) => m.enAi),
};

/* 键里带语言：中英各加载一次，切语言后不能复用上一种语言的 pending。 */
const pendingDicts: Record<string, Promise<void>> = {};

/**
 * 取回某个分组的词条（按当前语言决定取中文还是英文）。
 *
 * 由 App.tsx 的 lazyPage 调用：页面模块与词典一起 await，页面渲染时文案已就绪。
 * 加载失败时静默回退（界面仍可操作，只是该组文案可能缺失）——不因为词典请求
 * 失败把整页带崩。
 */
export function ensureDict(group: DictGroup): Promise<void> {
  if (group === 'core') return Promise.resolve();
  const lang = activeLang;
  const cacheKey = `${lang}:${group}`;
  pendingDicts[cacheKey] ??= (lang === 'en' ? EN_LOADERS[group] : ZH_LOADERS[group])()
    .then((dict) => {
      if (lang === 'en') enExtra = { ...enExtra, ...dict };
      else zhExtra = { ...zhExtra, ...dict };
    })
    .catch(() => {
      /* 拉不到就保持现状：仍可回退 core / 中文原文 */
    })
    .then(() => {
      onDictChange?.();
    });
  return pendingDicts[cacheKey];
}

/* zhCore 是 as const 的字面量对象：直接用全量 MessageKey 去索引会因为没有
   对应键而报类型错。先按 Dict 收口，再参与回退。 */
const CORE_DICT: Dict = zhCore;

const DICTS: Record<Lang, Dict> = {
  'zh-CN': CORE_DICT,
  get en() {
    return enDict ?? {};
  },
};

/** 当前语言 → 该语言的补充表 → 中文补充表 → 中文 core。 */
function lookup(key: MessageKey): string | undefined {
  const extra = activeLang === 'en' ? enExtra : zhExtra;
  return DICTS[activeLang][key] ?? extra[key] ?? zhExtra[key] ?? CORE_DICT[key];
}

/** 预拉某语言的 core 词典（英文才需要）。重复调用只会加载一次。 */
export async function preloadLang(lang: Lang): Promise<void> {
  if (lang !== 'en' || enDict) return;
  try {
    const mod = await import('./locales/en.core');
    enDict = mod.enCore;
  } catch {
    /* 拉不到就用中文兜底：界面仍是完整可用的 */
  }
}

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
  return interpolate(lookup(key) ?? key, vars);
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
  /* 词典是异步加载的：加载完成后自增一次，让下面的 t 重新生成、整棵树换文案 */
  const [dictVersion, setDictVersion] = useState(0);

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

  /* 切到英文时把词典拉下来；已经在加载 / 已加载则直接返回 */
  useEffect(() => {
    if (lang !== 'en' || enDict) return;
    let alive = true;
    void preloadLang('en').then(() => {
      if (alive) setDictVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, [lang, dictVersion]);

  /* 懒加载的中文词典到位时也重渲染一次：页面自己会等词典，但顶栏 / 通知这类
     已挂载的组件可能在此之前就渲染过（例如用户先停在某个页面再切过来）。 */
  useEffect(() => {
    setDictChangeHandler(() => setDictVersion((v) => v + 1));
    return () => setDictChangeHandler(null);
  }, []);

  /* 切语言时补拉新语言的懒加载词典：中英现在都是分域加载的，不补齐就会在
     当前页露出键名。一次把全部分组拉齐 —— 切语言时不知道用户接下来会去哪一页，
     而这是低频操作，多下几百 KB 比「某页文案突然变键名」可接受。 */
  const prevLangRef = useRef<Lang>(lang);
  useEffect(() => {
    if (prevLangRef.current === lang) return;
    prevLangRef.current = lang;
    (['app', 'compute', 'node', 'security', 'monitor', 'settings', 'ai', 'landing'] as DictGroup[])
      .forEach((group) => void ensureDict(group));
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState((current) => (current === next ? current : next));
  }, []);

  const t = useCallback<TFunc>(
    (key, vars) => {
      /* 英文表是 Partial：没翻的键回退中文原文，而不是露出 key */
      const text = lookup(key) ?? key;
      return interpolate(text, vars);
    },
    // dictVersion 参与依赖：英文表 / 懒加载词典到位后 t 的引用要变，才能触发重渲染
    [lang, dictVersion],
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
