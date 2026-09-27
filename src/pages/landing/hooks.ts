/* ==========================================================================
   产品官网 — 公共 hooks
   ==========================================================================

   这里只放「与内容无关」的行为逻辑。所有 hook 都必须满足两条：
     1. 浏览器不支持对应 API 时**降级到可见**，而不是让内容永远不出现；
     2. 尊重 prefers-reduced-motion —— 关掉动效偏好时直接给终态。
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';

/* ---------------------------------------------------------------------------
   基础工具
   --------------------------------------------------------------------------- */

/** 系统是否要求减少动态效果。matchMedia 不存在时返回 false（即允许动效）。 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * 滚动到某个锚点区块。
 *
 * 用 getBoundingClientRect + scrollY 自己算位置，而不是 scrollIntoView ——
 * 后者会连带滚动所有可滚动祖先，落地页里嵌套的横向容器会被一起推走。
 * 减掉顶栏高度，避免标题被固定顶栏盖住。
 */
export function scrollToSection(id: string, offset = 76): void {
  const el = document.getElementById(id);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/* ---------------------------------------------------------------------------
   滚动入场
   ---------------------------------------------------------------------------
   页面上的 .lp-reveal 元素进入视口时淡入上移。注意入场结束后必须**摘掉**
   reveal 标记：.lp-reveal 声明的 transform 与 transition 会一直压住组件自身
   的悬停反馈，不摘掉的话卡片悬停就不再上浮。

   必须支持**后挂载**的节点：能力矩阵按关键词筛选时会换掉一整批卡片，新卡片
   同样带着 .lp-reveal。如果只在挂载时扫一次，这些卡片会永远停在 opacity:0 ——
   那是内容直接消失，不是「少了点动画」。所以这里挂一个 MutationObserver
   持续增量扫描。
   --------------------------------------------------------------------------- */

/** 兜底时长：CSS 过渡 0.5s + 最大错峰延迟约 0.24s，再留一点余量 */
const REVEAL_SETTLE_MS = 900;

export function useReveal(): void {
  useEffect(() => {
    const settle = (node: HTMLElement) => {
      node.classList.remove('lp-reveal', 'is-visible');
      node.style.transitionDelay = '';
    };

    const settleAll = () => {
      document.querySelectorAll<HTMLElement>('.lp-reveal').forEach(settle);
    };

    // 不支持 IntersectionObserver：直接给终态，内容必须可见
    if (typeof IntersectionObserver === 'undefined') {
      settleAll();
      const fallback = new MutationObserver(settleAll);
      fallback.observe(document.body, { childList: true, subtree: true });
      return () => fallback.disconnect();
    }

    const timers: number[] = [];
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const node = entry.target as HTMLElement;
          node.classList.add('is-visible');
          observer.unobserve(node);
          // transitionend 在标签页不可见等场景可能不触发，再挂一个定时器兜底
          node.addEventListener('transitionend', () => settle(node), { once: true });
          timers.push(window.setTimeout(() => settle(node), REVEAL_SETTLE_MS));
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.05 },
    );

    /** :not(.is-visible) —— 已经触发过、正在等动画结束的节点不重复观察 */
    const scan = () => {
      document
        .querySelectorAll<HTMLElement>('.lp-reveal:not(.is-visible)')
        .forEach((node) => observer.observe(node));
    };

    scan();

    let frame = 0;
    const mutations = new MutationObserver(() => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        scan();
      });
    });
    mutations.observe(document.body, { childList: true, subtree: true });

    return () => {
      mutations.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);
}

/* ---------------------------------------------------------------------------
   元素是否进入过视口（只触发一次）
   --------------------------------------------------------------------------- */

export function useInView<T extends HTMLElement>(
  threshold = 0.35,
): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          setInView(true);
          observer.unobserve(entry.target);
        });
      },
      { threshold },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold]);

  return [ref, inView];
}

/* ---------------------------------------------------------------------------
   数字滚动：进入视口后从 0 递增到目标值
   --------------------------------------------------------------------------- */

export function useCountUp(target: number, active: boolean, duration = 900): number {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!active) return;
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      // easeOutCubic：起步快、收尾稳，读数字的体感比线性自然
      setValue(Math.round(target * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [target, active, duration]);

  return value;
}

/* ---------------------------------------------------------------------------
   顶栏是否已离开首屏
   ---------------------------------------------------------------------------
   纯静态的 sticky 顶栏与页面内容同色时会分不清层次，滚起来后要收紧底色并
   浮出投影。用 requestAnimationFrame 节流，避免滚动事件里每帧多次 setState。
   --------------------------------------------------------------------------- */

export function useScrolled(threshold = 10): boolean {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setScrolled(window.scrollY > threshold);
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [threshold]);

  return scrolled;
}

/* ---------------------------------------------------------------------------
   滚动高亮：顶栏锚点在滚到对应区块时点亮
   ---------------------------------------------------------------------------
   用「区块顶边是否越过锚点线」判断，而不是 IntersectionObserver 的可见比例 ——
   区块高度差别很大，按比例算会在长区块里出现长时间空档。触底时强制点亮最后
   一项，否则页脚区域会没有高亮。
   --------------------------------------------------------------------------- */

export function useScrollSpy(ids: string[]): string {
  const [activeId, setActiveId] = useState(ids[0] ?? '');

  useEffect(() => {
    let frame = 0;
    const OFFSET = 140;

    const update = () => {
      frame = 0;
      let current = ids[0] ?? '';
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= OFFSET) current = id;
      }
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) current = ids[ids.length - 1] ?? current;
      setActiveId(current);
    };

    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [ids]);

  return activeId;
}

/* ---------------------------------------------------------------------------
   点击外部关闭（下拉面板 / 抽屉用）
   --------------------------------------------------------------------------- */

export function useClickOutside<T extends HTMLElement>(
  active: boolean,
  onOutside: () => void,
): React.RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: MouseEvent) => {
      const node = ref.current;
      if (node && !node.contains(event.target as Node)) onOutside();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOutside();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [active, onOutside]);

  return ref;
}
