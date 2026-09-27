/* ==========================================================================
   ProxCenter — 产品官网（公开首页 /）
   ==========================================================================

   这一层只做组装：状态、滚动联动、以及各区块之间的传参。区块实现与文案
   分别在 pages/landing/ 下的模块里，改文案不必翻这里。

   信息架构（自上而下，编号即区块标题左上角的序号）：
     ——  顶栏        Chrome        品牌 + 全部能力面板 + 锚点导航 + 控制台入口
     00  Hero        Hero          两栏叙事 + 控制台速览 + 通栏指令条
     ——  规模数字    Metrics       四组可核对的事实，进入视口时计数
     01  能力矩阵    Matrix        39 项能力，能力域侧栏 + 关键词检索
     02  控制台实况  Showcase      四块界面预览，横向 Tab
     03  架构        Architecture  浏览器 → 面板 → 多套 Proxmox 连接
     04  重点能力    Highlights    四件左右交替的深度说明
     05  安全合规    Security      深色重音区：六道防线 + 审计流水
     06  适用场景    Scenarios     四种典型用法，纵向 Tab
     07  上手流程    Start         四步 + 部署命令 + 技术栈
     08  常见问题    Closing/Faq   内容来自服务端
     ——  CTA + 页脚  Closing

   底色节奏（改区块顺序时请一并维护，否则会出现两块同色贴在一起）：
     Hero（页底纹）→ 数字带（浅灰）→ 01 白 → 02 浅灰 → 03 白 → 04 浅灰
     → 05 深色 → 06 白 → 07 浅灰 → 08 白 → 收尾（白 + 深蓝面板）→ 页脚（浅灰）

   口径约定：能力分组与控制台侧边栏 NAV_SECTIONS 逐项对齐，只写平台真有的
   功能（见 README「二、功能」）。
   ========================================================================== */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useSiteInfo } from '../hooks/useSiteInfo';
import { useFaqs } from '../hooks/useFaqs';

import { Architecture } from './landing/Architecture';
import { Chrome } from './landing/Chrome';
import { Closing, Faq } from './landing/Closing';
import { Hero } from './landing/Hero';
import { Highlights } from './landing/Highlights';
import { Matrix } from './landing/Matrix';
import { Metrics } from './landing/Metrics';
import { Scenarios } from './landing/Scenarios';
import { Security } from './landing/Security';
import { Showcase } from './landing/Showcase';
import { Start } from './landing/Start';
import { NAV_LINKS, SITE } from './landing/content';
import { scrollToSection, useReveal, useScrolled, useScrollSpy } from './landing/hooks';

export function Landing() {
  const { user } = useAuth();
  const site = useSiteInfo();
  const faqs = useFaqs();
  const hasFaq = faqs.length > 0;

  /* 两个状态在 Hero 与能力矩阵之间共享：Hero 指令条里输入的关键词要能落到矩阵上 */
  const [query, setQuery] = useState('');
  const [activeDomain, setActiveDomain] = useState('all');

  /* 只在落地页开启平滑滚动，避免影响后台页面。
     窄屏不用平滑：长页在移动端逐帧滚动会发飘。
     这一处必须是内联样式 —— 它写在 documentElement 上，样式表里的
     html { scroll-behavior } 优先级更低，改了也不会生效。 */
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const previousBehavior = root.style.scrollBehavior;
    const previousOverflow = body.style.overflow;
    const previousHeight = body.style.height;

    root.style.scrollBehavior = window.innerWidth <= 640 ? 'auto' : 'smooth';
    // 后台是固定视口布局（body 默认 overflow:hidden），落地页需要恢复滚动
    body.style.overflow = 'auto';
    body.style.height = 'auto';

    return () => {
      root.style.scrollBehavior = previousBehavior;
      body.style.overflow = previousOverflow;
      body.style.height = previousHeight;
    };
  }, []);

  useReveal();

  /* 锚点列表随 FAQ 是否展示变化；用 useMemo 固定引用，否则 useScrollSpy 的
     依赖每次渲染都变，事件监听会被反复解绑重绑。 */
  const sections = useMemo(
    () => [...NAV_LINKS, ...(hasFaq ? [{ id: 'faq', label: '常见问题' }] : [])],
    [hasFaq],
  );
  const sectionIds = useMemo(() => sections.map((section) => section.id), [sections]);

  const activeId = useScrollSpy(sectionIds);
  const scrolled = useScrolled();

  const consoleHref = user ? SITE.consolePathAuthed : SITE.consolePath;
  const consoleLabel = user ? '进入控制台' : '登录控制台';

  /** 提交检索：先收起移动端软键盘，再滚动到能力矩阵 */
  const goToMatrix = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    scrollToSection('matrix');
  }, []);

  /** 从顶栏「全部能力」面板点某个域：先落定筛选，再滚过去 */
  const pickDomain = useCallback(
    (domainId: string) => {
      setActiveDomain(domainId);
      scrollToSection('matrix');
    },
    [],
  );

  return (
    <div className="lp-root">
      <Chrome
        brandName={site.name}
        sections={sections}
        activeId={activeId}
        scrolled={scrolled}
        consoleHref={consoleHref}
        consoleLabel={consoleLabel}
        docsPath={SITE.docsPath}
        onPickDomain={pickDomain}
      />

      <main id="top">
        <Hero
          query={query}
          onQueryChange={setQuery}
          onSubmit={goToMatrix}
          consoleHref={consoleHref}
          consoleLabel={consoleLabel}
        />

        <Metrics />

        <Matrix
          query={query}
          onQueryChange={setQuery}
          activeDomain={activeDomain}
          onDomainChange={setActiveDomain}
        />

        <Showcase />
        <Architecture />
        <Highlights />
        <Security />
        <Scenarios />
        <Start />

        {hasFaq ? <Faq faqs={faqs} /> : null}
      </main>

      <Closing
        site={site}
        consoleHref={consoleHref}
        consoleLabel={consoleLabel}
        docsPath={SITE.docsPath}
      />
    </div>
  );
}
