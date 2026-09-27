/* ==========================================================================
   产品官网 — 上手流程 + 部署命令 + 技术栈
   ========================================================================== */

import { DEPLOY_LINES, STACK, STEPS } from './content';
import { SectionHead } from './Common';

export function Start() {
  return (
    <section className="lp-section lp-section-tint" id="start">
      <div className="lp-container">
        <SectionHead
          index="07"
          eyebrow="Getting started"
          title="四步开始用"
          desc="从部署到拥有第一台自动化交付的虚拟机，通常不超过半小时。命令就是下面这三行，复制即可。"
        />

        <div className="lp-start">
          <ol className="lp-flow">
            {STEPS.map((step, index) => (
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
              {DEPLOY_LINES.map((line) => (
                <code
                  className={`lp-code-line${line.startsWith('#') ? ' is-comment' : ''}`}
                  key={line}
                >
                  {line}
                </code>
              ))}
            </pre>

            <div className="lp-stack">
              {STACK.map((group) => (
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
