/* ==========================================================================
   产品官网 — 上手流程 + 部署命令 + 技术栈
   ========================================================================== */

import { useT } from '../../i18n';
import { useLandingContent } from './hooks';
import { SectionHead } from './Common';

export function Start() {
  const t = useT();
  const { steps, deployLines, stack } = useLandingContent();

  return (
    <section className="lp-section lp-section-tint" id="start">
      <div className="lp-container">
        <SectionHead
          index="07"
          eyebrow="Getting started"
          title={t('landing.start.title')}
          desc={t('landing.start.desc')}
        />

        <div className="lp-start">
          <ol className="lp-flow">
            {steps.map((step, index) => (
              <li
                className="lp-flow-step lp-reveal"
                key={step.title}
                style={{ transitionDelay: `${index * 60}ms` }}
              >
                <span className="lp-flow-num mono">{index + 1}</span>
                <div className="lp-flow-body">
                  <h3 className="lp-h3">{step.title}</h3>
                  <p className="lp-p">{step.desc}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="lp-deploy lp-reveal">
            <div className="lp-deploy-bar">
              <span className="lp-dot" />
              <span className="lp-dot" />
              <span className="lp-dot" />
              <span className="lp-deploy-name">terminal</span>
            </div>

            <pre className="lp-code">
              {deployLines.map((line) => (
                <code
                  className={`lp-code-line${line.startsWith('#') ? ' is-comment' : ''}`}
                  key={line}
                >
                  {line}
                </code>
              ))}
            </pre>

            <div className="lp-stack">
              {stack.map((group) => (
                <div className="lp-stack-col" key={group.title}>
                  <div className="lp-stack-title">
                    <span className="lp-stack-icon">{group.icon}</span>
                    {group.title}
                  </div>
                  <ul className="lp-stack-list">
                    {group.items.map((item) => (
                      <li className="lp-stack-item" key={item}>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
