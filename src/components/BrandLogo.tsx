/* ==========================================================================
   ProxCenter — 品牌图标
   优先展示「设置 → 站点信息」中上传的自定义 Logo；未上传时用内置 SVG。
   侧边栏、登录页、落地页共用它，保证三处图标永远一致。
   ========================================================================== */

import { useId } from 'react';
import { useSiteInfo } from '../hooks/useSiteInfo';

/** 内置图标：圆角方块 + 渐变描边的字母 P，与产品名呼应 */
function BuiltinMark({ size }: { size: number }) {
  // 同一页面可能出现多个实例，渐变 id 必须唯一，否则后一个会覆盖前一个
  const gid = `brand-${useId().replace(/:/g, '')}`;
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0052d9" />
          <stop offset="100%" stopColor="#00a4ff" />
        </linearGradient>
      </defs>
      <rect
        x="2"
        y="2"
        width="28"
        height="28"
        rx="8"
        fill={`url(#${gid})`}
        opacity="0.18"
      />
      <path
        d="M10 22V10h5.5a4 4 0 0 1 0 8H13v4z"
        fill="none"
        stroke={`url(#${gid})`}
        strokeWidth="2.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="21.5" cy="20.5" r="2" fill="#0052d9" />
    </svg>
  );
}

export interface BrandLogoProps {
  /** 图标边长（px） */
  size?: number;
  className?: string;
}

export function BrandLogo({ size = 26, className }: BrandLogoProps) {
  const { logo_url } = useSiteInfo();

  if (logo_url) {
    return (
      <img
        src={logo_url}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        className={`brand-logo ${className ?? ''}`}
      />
    );
  }

  return <BuiltinMark size={size} />;
}
