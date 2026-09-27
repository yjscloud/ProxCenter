/* ==========================================================================
   产品官网 — 规模数字条
   ==========================================================================

   四组可核对的事实。数字里的「能力域数」「能力条目数」直接由内容模型算出
   （DOMAINS.length / CAPABILITY_TOTAL），不手写 —— 加了条目忘了改数字这种
   事在官网文案里是最常见的失真来源。

   计数动画在元素进入视口时才开始，且尊重 prefers-reduced-motion。
   ========================================================================== */

import { CAPABILITY_TOTAL, DOMAINS } from './content';
import { useCountUp, useInView } from './hooks';

interface Stat {
  value: number;
  unit: string;
  label: string;
}

const STATS: Stat[] = [
  {
    value: DOMAINS.length,
    unit: '大能力域',
    label: '从总览到系统管理，按运维实际的工作顺序分组',
  },
  {
    value: CAPABILITY_TOTAL,
    unit: '项能力',
    label: '每一条都对应控制台里一个真实页面或入口',
  },
  {
    value: 27,
    unit: '个功能页',
    label: '登录后侧边栏可见的页面，另有详情页与子页',
  },
  {
    value: 1,
    unit: '个对外端口',
    label: '前后端同源托管，无需额外 Nginx 与 WebSocket 代理',
  },
];

export function Metrics() {
  return (
    <section className="lp-metrics">
      <div className="lp-container">
        <div className="lp-metrics-grid">
          {STATS.map((stat, index) => (
            <StatCard key={stat.unit} stat={stat} delay={index * 70} />
          ))}
        </div>
      </div>
    </section>
  );
}

function StatCard({ stat, delay }: { stat: Stat; delay: number }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.4);
  const value = useCountUp(stat.value, inView);

  return (
    <div
      className="lp-metric lp-reveal"
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
    >
      <div className="lp-metric-value">
        <span className="lp-metric-num">{value}</span>
        <span className="lp-metric-unit">{stat.unit}</span>
      </div>
      <div className="lp-metric-label">{stat.label}</div>
    </div>
  );
}
