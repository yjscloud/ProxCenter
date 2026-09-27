/* ==========================================================================
   ProxCenter — 页内区块高亮（吸顶区块导航用）
   ==========================================================================
   长页面（设置、监控告警）顶部是一条吸顶的区块导航，正文按分区往下排。
   这个 hook 只回答一个问题：**现在滚到哪个分区了**。

   做法是「取顶端已经越过吸顶条的最后一个分区」，而不是 IntersectionObserver：
   后者的回调时机与 rootMargin 要反复试参数才准，而前者一次矩形比较就能说清。

   两点容易踩：
     * 滚动容器是 .app-content（id=main-content）而不是 window —— scroll 事件
       不冒泡，必须挂在滚动容器自己身上；
     * 分区是动态渲染的（权限、查询结果都会影响），但**数组每次渲染都是新引用**，
       直接当依赖会让监听反复重挂，所以用 id 拼成的串当依赖。
   ========================================================================== */

import { useEffect, useState } from 'react';

/** 吸顶条下方这个位置以内，就算「已经进了这个分区」 */
const SPY_OFFSET = 140;

export function useSectionSpy(
  sectionIds: string[],
  options: { prefix?: string; initial?: string } = {},
) {
  const { prefix = '', initial = '' } = options;
  const [active, setActive] = useState(() => initial || sectionIds[0] || '');

  const key = sectionIds.join(',');

  useEffect(() => {
    const scroller = document.getElementById('main-content');
    if (!scroller) return;

    const ids = key ? key.split(',') : [];
    let frame = 0;
    const pick = () => {
      frame = 0;
      let current = ids[0] ?? '';
      for (const id of ids) {
        const el = document.getElementById(`${prefix}${id}`);
        if (el && el.getBoundingClientRect().top <= SPY_OFFSET) current = id;
      }
      setActive((prev) => (prev === current ? prev : current));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(pick);
    };

    pick();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key, prefix]);

  return [active, setActive] as const;
}
