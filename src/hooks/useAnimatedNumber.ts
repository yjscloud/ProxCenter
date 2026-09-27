/* ==========================================================================
   useAnimatedNumber — 让监控数值平滑滚动到新值
   面板每几秒刷新一次，直接跳变会让人来不及注意到变化；
   这里用 requestAnimationFrame 在旧值与新值之间做缓动插值。
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';

/** 尊重系统的「减少动态效果」设置 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function useAnimatedNumber(target: number, duration = 700): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const from = fromRef.current;
    if (!Number.isFinite(target) || from === target) {
      fromRef.current = target;
      setValue(target);
      return;
    }

    if (prefersReducedMotion()) {
      fromRef.current = target;
      setValue(target);
      return;
    }

    const start = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutCubic：起步快、收尾稳，读数变化更容易被眼睛捕捉
      const eased = 1 - Math.pow(1 - t, 3);
      const next = from + (target - from) * eased;
      fromRef.current = next;
      setValue(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
        setValue(target);
      }
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return value;
}
