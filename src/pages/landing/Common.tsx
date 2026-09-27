/* ==========================================================================
   产品官网 — 区块级公共组件
   ========================================================================== */

import type { ReactNode } from 'react';

/**
 * 区块标题：编号 + 英文眉题 + 主标题 + 说明。
 *
 * 统一在一处，是为了让每个区块的标题节奏完全一致 —— 各区块自己写一遍的话，
 * 迟早会出现某个区块少了眉题、或说明文字宽度不统一，整页看起来就会「散」。
 *
 * `index` 是这一块的编号（01 / 02 …）。它不是装饰：整页较长，编号让用户对
 * 「读到哪了、还有几块」有预期，也让顶栏导航的高亮有了可对应的序号。
 */
export function SectionHead({
  index,
  eyebrow,
  title,
  desc,
  align = 'left',
}: {
  index: string;
  eyebrow: string;
  title: string;
  desc?: string;
  align?: 'left' | 'center';
}) {
  return (
    <div
      className={`lp-section-head lp-reveal${align === 'center' ? ' is-center' : ''}`}
    >
      <div className="lp-head-index">
        <span className="lp-head-index-num">{index}</span>
        <span className="lp-eyebrow">{eyebrow}</span>
        <span className="lp-head-index-rule" aria-hidden="true" />
      </div>
      <h2 className="lp-h2">{title}</h2>
      {desc ? <p className="lp-p">{desc}</p> : null}
    </div>
  );
}

/** 带小圆点的状态胶囊，用于「在线 / 异常」这类短状态 */
export function StatusPill({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'bad' | 'info';
  children: ReactNode;
}) {
  return (
    <span className={`lp-status is-${tone}`}>
      <span className="lp-status-dot" />
      {children}
    </span>
  );
}
