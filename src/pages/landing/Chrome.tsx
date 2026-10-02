/* ==========================================================================
   产品官网 — 顶栏（导航 / 全部能力面板 / 移动端抽屉）
   ==========================================================================

   为什么是「点击」而不是「悬停」展开能力面板：悬停式 mega 菜单在触屏上根本
   打不开，键盘用户也必须先 tab 到按钮再按回车 —— 与其做两套逻辑，不如统一
   用点击 + Escape / 点击外部关闭，三种输入方式的行为完全一致。

   面板与抽屉的开关状态都留在这个组件内部：它们只影响顶栏自身，放进上层只会
   让 Landing 多背两个与自己无关的 state。因此「点了链接收起抽屉」也在这里
   处理，不通过 props 往外传。
   ========================================================================== */

import { useCallback, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandLogo } from '../../components/BrandLogo';
import { IconChevronRight, IconClose, IconMenu } from '../../components/Icons';
import { useClickOutside, useLandingContent } from './hooks';
import { useT } from '../../i18n';
import { LanguageSelect } from '../../components/LanguageSelect';

export interface ChromeProps {
  brandName: string;
  /** 锚点导航 */
  sections: { id: string; label: string }[];
  /** 当前高亮的锚点 */
  activeId: string;
  /** 是否已离开首屏（决定顶栏是否收紧底色并浮出投影） */
  scrolled: boolean;
  consoleHref: string;
  consoleLabel: string;
  /** 从能力面板点某个域：交给上层去设置筛选并滚动到位 */
  onPickDomain: (domainId: string) => void;
}

export function Chrome({
  brandName,
  sections,
  activeId,
  scrolled,
  consoleHref,
  consoleLabel,
  onPickDomain,
}: ChromeProps) {
  const t = useT();
  /* 能力域文案按当前语言解引用（内容型文案走 content.tsx 的双语元组，不进词条表） */
  const { domains: domainList, capabilityTotal } = useLandingContent();
  const [megaOpen, setMegaOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const megaId = useId();
  const drawerId = useId();

  const closeAll = useCallback(() => {
    setMegaOpen(false);
    setDrawerOpen(false);
  }, []);

  // 点面板/抽屉以外的地方、或按 Escape 收起
  const shellRef = useClickOutside<HTMLDivElement>(megaOpen, closeAll);

  const pickDomain = useCallback(
    (domainId: string) => {
      onPickDomain(domainId);
      closeAll();
    },
    [onPickDomain, closeAll],
  );

  return (
    <header className={`lp-nav${scrolled ? ' is-scrolled' : ''}`}>
      <div className="lp-container lp-nav-inner">
        <a className="lp-brand" href="#top" onClick={closeAll}>
          <span className="lp-brand-mark">
            <BrandLogo size={26} />
          </span>
          <span className="lp-brand-name">{brandName}</span>
        </a>

        <nav className="lp-nav-links" aria-label={t('landing.navAria')}>
          <div className="lp-nav-mega-wrap" ref={shellRef}>
            <button
              type="button"
              className={`lp-nav-link lp-nav-link-btn${megaOpen ? ' is-active' : ''}`}
              aria-expanded={megaOpen}
              aria-controls={megaId}
              onClick={() => setMegaOpen((open) => !open)}
            >
              {t('landing.allCapabilities')}
              <span className={`lp-nav-caret${megaOpen ? ' is-open' : ''}`} aria-hidden="true" />
            </button>

            {/* 收起态靠 CSS 的 visibility:hidden 移出 tab 序列 ——
                不用 inert 属性（React 18 的类型里还没有它）。 */}
            <div
              className={`lp-mega${megaOpen ? ' is-open' : ''}`}
              id={megaId}
              role="region"
              aria-label={t('landing.allCapabilities')}
            >
              <div className="lp-mega-head">
                <span className="lp-mega-title">{t('landing.allCapabilities')}</span>
                <span className="lp-mega-count">
                  {t('landing.megaCount', {
                    domains: domainList.length,
                    total: capabilityTotal,
                  })}
                </span>
                <button
                  type="button"
                  className="lp-mega-close"
                  aria-label={t('landing.collapsePanel')}
                  onClick={() => setMegaOpen(false)}
                >
                  <IconClose size={16} />
                </button>
              </div>

              <div className="lp-mega-grid">
                {domainList.map((domain) => (
                  <div className="lp-mega-col" key={domain.id}>
                    <button
                      type="button"
                      className="lp-mega-col-head"
                      onClick={() => pickDomain(domain.id)}
                    >
                      <span className="lp-mega-col-icon">{domain.icon}</span>
                      {/* 名称与英文名上下排：并排时「存储与网络 + STORAGE & NETWORK」
                          在四列布局里放不下，名称会被挤成两行，各列高度参差不齐 */}
                      <span className="lp-mega-col-body">
                        <span className="lp-mega-col-name">{domain.name}</span>
                        <span className="lp-mega-col-en">{domain.en}</span>
                      </span>
                      <IconChevronRight size={13} />
                    </button>
                    <ul className="lp-mega-list">
                      {domain.items.map((item) => (
                        <li key={item.name}>
                          <button type="button" onClick={() => pickDomain(domain.id)}>
                            {item.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {sections.map((section) => (
            <a
              key={section.id}
              className={`lp-nav-link${activeId === section.id ? ' is-active' : ''}`}
              href={`#${section.id}`}
              aria-current={activeId === section.id ? 'true' : undefined}
            >
              {section.label}
            </a>
          ))}
        </nav>

        <div className="lp-nav-actions">
          {/* 语言切换：官网是「找得到才会用」的入口，放在顶栏而不是折叠菜单里。
              用 landing 形态（自绘下拉）—— 面板那套胶囊/原生下拉在官网顶栏里
              又宽又突兀。 */}
          <LanguageSelect variant="landing" />
          <Link className="lp-btn lp-btn-primary lp-btn-sm" to={consoleHref}>
            {consoleLabel}
          </Link>

          {/* 窄屏专用：把上面收起来的导航与能力面板放进抽屉 */}
          <button
            type="button"
            className="lp-nav-toggle"
            aria-label={drawerOpen ? t('landing.closeNav') : t('landing.openNav')}
            aria-expanded={drawerOpen}
            aria-controls={drawerId}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {drawerOpen ? <IconClose size={18} /> : <IconMenu size={18} />}
          </button>
        </div>
      </div>

      {/* ---------------- 移动端抽屉 ---------------- */}
      <div className={`lp-drawer${drawerOpen ? ' is-open' : ''}`} id={drawerId}>
        <div className="lp-container lp-drawer-inner">
          <div className="lp-drawer-group">
            <div className="lp-drawer-label">{t('landing.drawerNav')}</div>
            <div className="lp-drawer-links">
              {sections.map((section) => (
                <a
                  key={section.id}
                  className="lp-drawer-link"
                  href={`#${section.id}`}
                  onClick={closeAll}
                >
                  {section.label}
                </a>
              ))}
            </div>
          </div>

          <div className="lp-drawer-group">
            <div className="lp-drawer-label">{t('landing.drawerDomains')}</div>
            <div className="lp-drawer-chips">
              {domainList.map((domain) => (
                <button
                  key={domain.id}
                  type="button"
                  className="lp-drawer-chip"
                  onClick={() => pickDomain(domain.id)}
                >
                  {domain.icon}
                  {domain.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
