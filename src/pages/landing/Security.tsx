/* ==========================================================================
   产品官网 — 安全与合规（深色重音区）
   ==========================================================================

   整页唯一的深色整段。浅色页面从头读到尾会疲劳，用一块深色把「安全性」
   这件事单独拎出来，既形成节奏，也在心理上把它标成「要认真看的部分」。
   深色本身不在这里写样式：.lp-band-dark 会重映射整套 --lp-* 令牌，
   下面这些子元素用的仍是同一套变量。

   内容分两层：
     · 六道防线（机制层）—— 说清面板在哪些环节做了什么；
     · 审计流水（结果层）—— 给一段示意记录，把「留痕」这件事落到具体字段上。
   ========================================================================== */

import { IconInfo } from '../../components/Icons';
import { useT, type MessageKey } from '../../i18n';
import type { AuditRow } from './content';
import { useLandingContent } from './hooks';
import { SectionHead } from './Common';

const RESULT_META: Record<AuditRow['result'], { labelKey: MessageKey; tone: string }> = {
  ok: { labelKey: 'landing.security.resultOk', tone: 'ok' },
  denied: { labelKey: 'landing.security.resultDenied', tone: 'warn' },
  failed: { labelKey: 'landing.security.resultFailed', tone: 'bad' },
};

export function Security() {
  const t = useT();
  const { pillars, auditSample } = useLandingContent();

  return (
    <section className="lp-band-dark" id="security">
      <div className="lp-container">
        <SectionHead
          index="05"
          eyebrow="Security & Compliance"
          title={t('landing.security.title')}
          desc={t('landing.security.desc')}
        />

        <div className="lp-defenses">
          {pillars.map((pillar, index) => (
            <article
              className="lp-defense lp-reveal"
              key={pillar.title}
              style={{ transitionDelay: `${(index % 3) * 60}ms` }}
            >
              <span className="lp-defense-icon">{pillar.icon}</span>
              <h3 className="lp-defense-title">{pillar.title}</h3>
              <p className="lp-defense-desc">{pillar.desc}</p>
            </article>
          ))}
        </div>

        <div className="lp-audit lp-reveal">
          <div className="lp-audit-head">
            <span className="lp-audit-title">{t('landing.security.auditTitle')}</span>
            <span className="lp-audit-hint">
              <IconInfo size={13} />
              {t('landing.security.auditHint')}
            </span>
          </div>

          <div
            className="lp-audit-table"
            role="table"
            aria-label={t('landing.security.auditAria')}
          >
            <div className="lp-audit-tr is-head" role="row">
              <span role="columnheader">{t('landing.security.colTime')}</span>
              <span role="columnheader">{t('landing.security.colUser')}</span>
              <span role="columnheader">{t('landing.security.colAction')}</span>
              <span role="columnheader">{t('landing.security.colTarget')}</span>
              <span role="columnheader">{t('landing.security.colResult')}</span>
            </div>
            {auditSample.map((row) => {
              const meta = RESULT_META[row.result];
              return (
                <div className="lp-audit-tr" role="row" key={`${row.time}-${row.action}`}>
                  <span className="lp-audit-time" role="cell">
                    {row.time}
                  </span>
                  <span className="lp-audit-user" role="cell">
                    {row.user}
                  </span>
                  <span className="lp-audit-action" role="cell">
                    {row.action}
                  </span>
                  <span className="lp-audit-target" role="cell">
                    {row.target}
                  </span>
                  <span className={`lp-audit-result is-${meta.tone}`} role="cell">
                    {t(meta.labelKey)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
