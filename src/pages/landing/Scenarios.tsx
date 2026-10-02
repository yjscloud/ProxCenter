/* ==========================================================================
   产品官网 — 适用场景
   ==========================================================================

   刻意用**纵向** Tab（左侧列表 + 右侧内容），与控制台实况那一块的横向 Tab
   区分开。连续两块用同一种交互，用户会以为还是上一块内容在换皮。

   窄屏下改成上方横滑的胶囊列表，避免左侧列表把内容挤到只剩半屏。
   ========================================================================== */

import { useCallback, useRef, useState } from 'react';
import { IconCheck } from '../../components/Icons';
import { useT } from '../../i18n';
import { useLandingContent } from './hooks';
import { SectionHead } from './Common';

export function Scenarios() {
  const t = useT();
  const { scenarios } = useLandingContent();
  const [active, setActive] = useState(scenarios[0].id);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const activeIndex = Math.max(
    0,
    scenarios.findIndex((item) => item.id === active),
  );
  const current = scenarios[activeIndex];

  const focusTab = useCallback(
    (index: number) => {
      const next = scenarios[index];
      if (!next) return;
      setActive(next.id);
      tabRefs.current[next.id]?.focus();
    },
    [scenarios],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const last = scenarios.length - 1;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        focusTab(activeIndex === last ? 0 : activeIndex + 1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        focusTab(activeIndex === 0 ? last : activeIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(0);
        break;
      case 'End':
        event.preventDefault();
        focusTab(last);
        break;
      default:
        break;
    }
  };

  return (
    <section className="lp-section" id="scenarios">
      <div className="lp-container">
        <SectionHead
          index="06"
          eyebrow="Scenarios"
          title={t('landing.scenarios.title')}
          desc={t('landing.scenarios.desc')}
        />

        <div className="lp-scenarios lp-reveal">
          <div
            className="lp-scenario-tabs"
            role="tablist"
            aria-orientation="vertical"
            aria-label={t('landing.scenarios.aria')}
            onKeyDown={onKeyDown}
          >
            {scenarios.map((scenario, index) => {
              const selected = scenario.id === current.id;
              return (
                <button
                  key={scenario.id}
                  type="button"
                  role="tab"
                  id={`lp-scenario-tab-${scenario.id}`}
                  aria-selected={selected}
                  aria-controls={`lp-scenario-panel-${scenario.id}`}
                  tabIndex={selected ? 0 : -1}
                  ref={(el) => {
                    tabRefs.current[scenario.id] = el;
                  }}
                  className={`lp-scenario-tab${selected ? ' is-active' : ''}`}
                  onClick={() => setActive(scenario.id)}
                >
                  <span className="lp-scenario-tab-index">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="lp-scenario-tab-icon">{scenario.icon}</span>
                  <span className="lp-scenario-tab-text">
                    <span className="lp-scenario-tab-title">{scenario.title}</span>
                    <span className="lp-scenario-tab-desc">{scenario.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div
            className="lp-scenario-panel"
            key={current.id}
            role="tabpanel"
            id={`lp-scenario-panel-${current.id}`}
            aria-labelledby={`lp-scenario-tab-${current.id}`}
            tabIndex={0}
          >
            <div className="lp-scenario-panel-head">
              <span className="lp-scenario-panel-icon">{current.icon}</span>
              <h3 className="lp-h3">{current.title}</h3>
            </div>
            <p className="lp-p">{current.desc}</p>

            <ul className="lp-scenario-points">
              {current.points.map((point) => (
                <li className="lp-scenario-point" key={point}>
                  <IconCheck size={13} />
                  <span>{point}</span>
                </li>
              ))}
            </ul>

            <div className="lp-tags">
              {current.tags.map((tag) => (
                <span className="lp-tag" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
