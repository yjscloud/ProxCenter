/* ==========================================================================
   产品官网 — 规模数字条
   ==========================================================================

   四组可核对的事实。数字里的「能力域数」「能力条目数」直接由内容模型算出
   （DOMAINS.length / CAPABILITY_TOTAL），不手写 —— 加了条目忘了改数字这种
   事在官网文案里是最常见的失真来源。

   计数动画在元素进入视口时才开始，且尊重 prefers-reduced-motion。
   ========================================================================== */

import { useT, type MessageKey } from '../../i18n';
import { CAPABILITY_TOTAL } from './content';
import { useCountUp, useInView, useLandingContent } from './hooks';

interface Stat {
  value: number;
  /** 单位与说明都取词条：两处都随语言变化，且英文的单位与数字之间空格规则不同 */
  unitKey: MessageKey;
  labelKey: MessageKey;
}

/** 能力域数由内容模型算出（加了域忘了改数字是官网文案最常见的失真来源） */
function buildStats(domainCount: number): Stat[] {
  return [
    {
      value: domainCount,
      unitKey: 'landing.metrics.domainUnit',
      labelKey: 'landing.metrics.domainLabel',
    },
    {
      value: CAPABILITY_TOTAL,
      unitKey: 'landing.metrics.capabilityUnit',
      labelKey: 'landing.metrics.capabilityLabel',
    },
    {
      value: 27,
      unitKey: 'landing.metrics.pageUnit',
      labelKey: 'landing.metrics.pageLabel',
    },
    {
      value: 1,
      unitKey: 'landing.metrics.portUnit',
      labelKey: 'landing.metrics.portLabel',
    },
  ];
}

export function Metrics() {
  const { domains } = useLandingContent();
  const stats = buildStats(domains.length);

  return (
    <section className="lp-metrics">
      <div className="lp-container">
        <div className="lp-metrics-grid">
          {stats.map((stat, index) => (
            <StatCard key={stat.unitKey} stat={stat} delay={index * 70} />
          ))}
        </div>
      </div>
    </section>
  );
}

function StatCard({ stat, delay }: { stat: Stat; delay: number }) {
  const t = useT();
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
        <span className="lp-metric-unit">{t(stat.unitKey)}</span>
      </div>
      <div className="lp-metric-label">{t(stat.labelKey)}</div>
    </div>
  );
}
