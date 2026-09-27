/* ==========================================================================
   ProxCenter — 免登录页统一外壳（登录 / 注册 / 找回密码）

   参考腾讯云登录页的结构：
   顶部品牌条 + 居中白色卡片 + 底部版权页脚，
   背景是浅色网格加两处柔光，不抢卡片的视觉焦点。
   四个认证页共用它，改版只需动这一个文件。
   ========================================================================== */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BrandLogo } from './BrandLogo';
import { useSiteInfo } from '../hooks/useSiteInfo';

export interface AuthShellProps {
  children: ReactNode;
}

export function AuthShell({ children }: AuthShellProps) {
  const site = useSiteInfo();

  /*
    后端「设置 → 站点信息」上传了自定义背景就用它，否则保持 CSS 里的内置插画。
    背景图地址由后端带上 ?v= 时间戳，换图后 URL 变化可绕开浏览器缓存。
  */
  const customBg = site.login_bg_url;

  return (
    <div
      className={`login-page${customBg ? ' login-page--custom-bg' : ''}`}
      style={customBg ? { backgroundImage: `url("${customBg}")` } : undefined}
    >
      {/* ---- 顶部品牌条 ---- */}
      <header className="login-topbar">
        <div className="login-topbar-brand">
          <BrandLogo size={26} />
          <span className="login-topbar-name">{site.name}</span>
        </div>
        <Link to="/" className="login-topbar-link">
          <svg
            viewBox="0 0 16 16"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10 3 5 8l5 5" />
          </svg>
          返回官网
        </Link>
      </header>

      {/* ---- 居中卡片 ---- */}
      <main className="login-main">
        <div className="login-card">{children}</div>
      </main>

      {/* ---- 底部版权 ---- */}
      <footer className="login-footer">
        {site.icp ? (
          <a
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
      </footer>
    </div>
  );
}
