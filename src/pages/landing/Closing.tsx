/* ==========================================================================
   产品官网 — 常见问题 / 收尾 CTA / 页脚 / 返回顶部
   ========================================================================== */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandLogo } from '../../components/BrandLogo';
import { IconCheck, IconChevronUp, IconKey } from '../../components/Icons';
import type { FaqItem, SiteInfo } from '../../api/types';
import { DOMAINS } from './content';
import { SectionHead } from './Common';
import { scrollToSection } from './hooks';

/**
 * 常见问题。内容来自服务端（「设置 → 常见问题」），空数组表示管理员关掉了
 * 这一块 —— 此时整块不渲染，顶栏与页脚的入口也一并消失（由 Landing 判断）。
 *
 * 单独导出而不是塞进 Closing：FAQ 在 <main> 内，而 CTA 与页脚在 <main> 外，
 * 拆开才能让 DOM 层次正确。
 */
export function Faq({ faqs }: { faqs: FaqItem[] }) {
  if (faqs.length === 0) return null;

  return (
    <section className="lp-section" id="faq">
      <div className="lp-container">
        <SectionHead
          index="08"
          eyebrow="FAQ"
          title="常见问题"
          desc="部署、权限与几个最容易踩的坑 —— 都是真实环境里被问过的。"
        />
        <div className="lp-faq">
          {faqs.map((item, index) => (
            <details
              className="lp-faq-item lp-reveal"
              key={item.q}
              style={{ transitionDelay: `${index * 60}ms` }}
            >
              <summary className="lp-faq-q">{item.q}</summary>
              <div className="lp-faq-a">{item.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export interface ClosingProps {
  site: SiteInfo;
  consoleHref: string;
  consoleLabel: string;
  docsPath: string;
}

/** 收尾区右侧的三条要点：与首屏的信任条目呼应，但只留最硬的三条 */
const FINALE_POINTS = [
  '集群凭据只在后端使用，前端拿不到明文',
  '危险操作二次确认，全部写操作进审计',
  '前后端同源，一个端口对外即可上线',
];

export function Closing({ site, consoleHref, consoleLabel, docsPath }: ClosingProps) {
  return (
    <>
      <section className="lp-finale-wrap">
        <div className="lp-container">
          <div className="lp-finale lp-reveal">
            <div className="lp-finale-inner">
              <span className="lp-eyebrow">Ready</span>
              <h2 className="lp-h2">现在就用它管起你的集群</h2>
              <p className="lp-p">
                登录后填一条 Proxmox 连接即可开始使用，不需要改 Proxmox 的对外暴露。
              </p>
              <div className="lp-cta-row">
                <Link className="lp-btn lp-btn-light" to={consoleHref}>
                  <IconKey size={15} />
                  {consoleLabel}
                </Link>
                <a className="lp-btn lp-btn-outline" href={docsPath}>
                  查看接口文档
                </a>
              </div>
            </div>

            <ul className="lp-finale-points">
              {FINALE_POINTS.map((point) => (
                <li className="lp-finale-point" key={point}>
                  <IconCheck size={13} />
                  {point}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-container">
          <div className="lp-footer-grid">
            <div className="lp-footer-about">
              <div className="lp-brand lp-footer-brand">
                <span className="lp-brand-mark">
                  <BrandLogo size={26} />
                </span>
                <span className="lp-brand-name">{site.name}</span>
              </div>
              <p className="lp-footer-desc">
                面向 Proxmox VE 的自托管管理面板：计算、存储与网络、数据保护、
                安全、观测与集成、系统管理，一个界面搞定。
              </p>
            </div>

            <div>
              <div className="lp-footer-title">产品能力</div>
              <div className="lp-footer-links">
                {[
                  { id: 'matrix', label: '能力矩阵' },
                  { id: 'console', label: '控制台实况' },
                  { id: 'architecture', label: '架构' },
                  { id: 'highlights', label: '重点能力' },
                  { id: 'security', label: '安全合规' },
                  { id: 'start', label: '上手流程' },
                ].map((entry) => (
                  <button
                    type="button"
                    className="lp-footer-link lp-footer-link-btn"
                    key={entry.id}
                    onClick={() => scrollToSection(entry.id)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="lp-footer-title">能力分组</div>
              <div className="lp-footer-links">
                {DOMAINS.map((domain) => (
                  <span className="lp-footer-link" key={domain.id}>
                    {domain.name}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <div className="lp-footer-title">快速入口</div>
              <div className="lp-footer-links">
                <Link className="lp-footer-link" to={consoleHref}>
                  {consoleLabel}
                </Link>
                <a className="lp-footer-link" href={docsPath}>
                  接口文档
                </a>
                <button
                  type="button"
                  className="lp-footer-link lp-footer-link-btn"
                  onClick={() => scrollToSection('faq')}
                >
                  常见问题
                </button>
              </div>

              <div className="lp-footer-title lp-footer-title-gap">技术栈</div>
              <div className="lp-footer-links">
                <span className="lp-footer-link">FastAPI + MySQL</span>
                <span className="lp-footer-link">React 18 + TypeScript</span>
                <span className="lp-footer-link">Proxmox VE API</span>
              </div>
            </div>
          </div>

          {site.links.length > 0 ? (
            <div className="lp-footer-friendlinks">
              <span className="lp-footer-title">友情链接</span>
              <nav className="lp-friendlink-list" aria-label="友情链接">
                {site.links.map((link) => (
                  <a
                    key={`${link.url}-${link.name}`}
                    className="lp-friendlink"
                    href={link.url}
                    /* 站外链接新开页并切断 referrer；站内路径保持原行为 */
                    {...(link.url.startsWith('/')
                      ? {}
                      : { target: '_blank', rel: 'noopener noreferrer nofollow' })}
                  >
                    {link.name}
                  </a>
                ))}
              </nav>
            </div>
          ) : null}

          <div className="lp-footer-bottom">
            {site.icp ? (
              <a
                className="lp-footer-icp"
                /* 备案号的惯例是链到官方查询系统：备案归公安，其余走工信部 */
                href={
                  site.icp.includes('公网安备')
                    ? 'https://beian.mps.gov.cn/'
                    : 'https://beian.miit.gov.cn/'
                }
                target="_blank"
                rel="noopener noreferrer"
              >
                {site.icp}
              </a>
            ) : null}
            <span>{site.copyright}</span>
          </div>
        </div>
      </footer>

      <BackToTop />
    </>
  );
}

/* ---------------------------------------------------------------------------
   返回顶部：滚过一屏后出现
   --------------------------------------------------------------------------- */

function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 420);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <button
      type="button"
      className={`lp-back-to-top${visible ? ' is-visible' : ''}`}
      onClick={() => scrollToSection('top', 0)}
      title="返回顶部"
      aria-label="返回顶部"
      /* 隐藏时不参与键盘与读屏，避免焦点落到看不见的按钮上 */
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible}
    >
      <IconChevronUp size={18} />
    </button>
  );
}
