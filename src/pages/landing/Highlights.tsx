/* ==========================================================================
   产品官网 — 重点能力（左右交替 + 示意图）
   ==========================================================================

   四块内容用「左文右图 / 右文左图」交替排布，而不是四张一样的卡片 ——
   连续四张同构卡片会让人直接跳过中间两张。交替之后视线会被迫走一遍 Z 字，
   每一块才真正被读到。

   每块配一张与该能力**直接相关**的示意图（流水线就画五步流程、隔离就画
   处置顺序），而不是放一张通用插图：图本身就是内容的一部分。
   ========================================================================== */

import { IconAlert, IconCheck, IconClock, IconShield, IconSparkle } from '../../components/Icons';
import { useT, type MessageKey } from '../../i18n';
import type { VisualKind } from './content';
import { useLandingContent } from './hooks';
import { SectionHead } from './Common';

export function Highlights() {
  const t = useT();
  const { highlights } = useLandingContent();

  return (
    <section className="lp-section lp-section-tint" id="highlights">
      <div className="lp-container">
        <SectionHead
          index="04"
          eyebrow="Highlights"
          title={t('landing.highlights.title')}
          desc={t('landing.highlights.desc')}
        />

        <div className="lp-rows">
          {highlights.map((item, index) => (
            <article
              className={`lp-row lp-reveal${index % 2 === 1 ? ' is-flip' : ''}`}
              key={item.id}
            >
              <div className="lp-row-copy">
                <span className="lp-eyebrow">{item.kicker}</span>
                <h3 className="lp-h3">{item.title}</h3>
                <p className="lp-p">{item.desc}</p>
                <ul className="lp-row-points">
                  {item.points.map((point) => (
                    <li key={point}>
                      <IconCheck size={13} />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
                <div className="lp-tags">
                  {item.tags.map((tag) => (
                    <span className="lp-tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              <div className="lp-row-visual">
                <HighlightVisual kind={item.visual} />
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------
   示意图：四种
   --------------------------------------------------------------------------- */

function HighlightVisual({ kind }: { kind: VisualKind }) {
  switch (kind) {
    case 'ai':
      return <VisualAI />;
    case 'contain':
      return <VisualContain />;
    case 'baseline':
      return <VisualBaseline />;
    case 'auto':
      return <VisualAuto />;
  }
}

/* ---- 1. AI 排查助手：一句提问 → 只读取数 → 只给结论 ---- */

/** 示意里点出的两类只读来源：本地命令一条、平台内置工具一条，都是真实存在的 */
const AI_TOOL_KEYS: MessageKey[] = [
  'landing.highlights.ai.toolCmd',
  'landing.highlights.ai.toolAudit',
];

function VisualAI() {
  const t = useT();
  return (
    <div className="lp-visual">
      <div className="lp-visual-head">
        <span className="lp-visual-title">{t('landing.highlights.ai.title')}</span>
        <span className="lp-visual-chip">
          <IconSparkle size={11} />
          {t('landing.highlights.ai.chip')}
        </span>
      </div>

      <div className="lp-chat">
        <div className="lp-chat-row is-user">
          <span className="lp-chat-avatar">{t('landing.highlights.ai.chatUser')}</span>
          <span className="lp-chat-bubble">{t('landing.highlights.ai.chatQuestion')}</span>
        </div>
        <div className="lp-chat-row is-bot">
          <span className="lp-chat-avatar is-bot">{t('landing.highlights.ai.chatPanel')}</span>
          <span className="lp-chat-bubble">
            {t('landing.highlights.ai.chatAnswer')}
            <span className="lp-chat-actions">
              {AI_TOOL_KEYS.map((key, index) => (
                <span className={`lp-chat-btn${index === 0 ? ' is-primary' : ''}`} key={key}>
                  {t(key)}
                </span>
              ))}
            </span>
          </span>
        </div>
      </div>

      <div className="lp-visual-note">{t('landing.highlights.ai.note')}</div>
    </div>
  );
}

/* ---- 2. 应急隔离：处置顺序是内容本身 ---- */

const CONTAIN_ORDER_KEYS: MessageKey[] = [
  'landing.highlights.contain.orderSnapshot',
  'landing.highlights.contain.orderNIC',
  'landing.highlights.contain.orderPower',
];

function VisualContain() {
  const t = useT();
  return (
    <div className="lp-visual">
      <div className="lp-visual-head">
        <span className="lp-visual-title">{t('landing.highlights.contain.title')}</span>
        <span className="lp-visual-chip is-warn">{t('landing.highlights.contain.chip')}</span>
      </div>

      <div className="lp-order">
        {CONTAIN_ORDER_KEYS.map((key, index) => (
          <div className="lp-order-item" key={key}>
            <span className="lp-order-text">{t(key)}</span>
            {index < 2 ? <span className="lp-order-arrow" aria-hidden="true" /> : null}
          </div>
        ))}
      </div>

      <div className="lp-contrast">
        <div className="lp-contrast-row is-bad">
          <IconAlert size={13} />
          <span className="lp-contrast-text">
            {t('landing.highlights.contain.badPre')}
            <s>{t('landing.highlights.contain.badStrike')}</s>
          </span>
        </div>
        <div className="lp-contrast-row is-good">
          <IconShield size={13} />
          <span className="lp-contrast-text">{t('landing.highlights.contain.good')}</span>
        </div>
      </div>
    </div>
  );
}

/* ---- 3. 安全基线：评分环 + 检查项 ---- */

const BASELINE_CHECKS: { nameKey: MessageKey; levelKey: MessageKey; ok: boolean }[] = [
  {
    nameKey: 'landing.highlights.baseline.checkRoot',
    levelKey: 'landing.highlights.levelHigh',
    ok: false,
  },
  {
    nameKey: 'landing.highlights.baseline.checkEmptyPw',
    levelKey: 'landing.highlights.levelHigh',
    ok: true,
  },
  {
    nameKey: 'landing.highlights.baseline.checkTime',
    levelKey: 'landing.highlights.levelLow',
    ok: true,
  },
  {
    nameKey: 'landing.highlights.baseline.checkAslr',
    levelKey: 'landing.highlights.levelMedium',
    ok: true,
  },
];

function VisualBaseline() {
  const t = useT();
  return (
    <div className="lp-visual">
      <div className="lp-score">
        <div className="lp-ring">
          <svg viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="33" fill="none" stroke="rgba(15,40,80,.09)" strokeWidth="7" />
            <circle
              cx="40"
              cy="40"
              r="33"
              fill="none"
              stroke="#2ba471"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray="207"
              strokeDashoffset="29"
              transform="rotate(-90 40 40)"
            />
          </svg>
          <span className="lp-ring-num">86</span>
        </div>
        <div className="lp-score-text">
          <div className="lp-score-title">{t('landing.highlights.baseline.score')}</div>
          <div className="lp-score-sub">{t('landing.highlights.baseline.scoreSub')}</div>
          <div className="lp-score-tags">
            <span className="lp-chip is-green">
              {t('landing.highlights.baseline.chipFix')}
            </span>
            <span className="lp-chip">{t('landing.highlights.baseline.chipReview')}</span>
          </div>
        </div>
      </div>

      <div className="lp-check-list">
        {BASELINE_CHECKS.map((check) => (
          <div className="lp-check" key={check.nameKey}>
            <span className={`lp-check-icon${check.ok ? ' is-ok' : ' is-bad'}`}>
              {check.ok ? <IconCheck size={11} /> : <IconAlert size={11} />}
            </span>
            <span className="lp-check-name">{t(check.nameKey)}</span>
            <span className={`lp-check-level is-${check.ok ? 'ok' : 'bad'}`}>
              {t(check.levelKey)}
            </span>
          </div>
        ))}
      </div>

      <div className="lp-visual-note">{t('landing.highlights.baseline.note')}</div>
    </div>
  );
}

/* ---- 4. 自动化：证书续期时间轴 + 飞书确认卡片 ---- */

const CERT_STAGE_KEYS: MessageKey[] = [
  'landing.highlights.auto.stageRequest',
  'landing.highlights.auto.stageValidate',
  'landing.highlights.auto.stageIssue',
  'landing.highlights.auto.stageDeploy',
  'landing.highlights.auto.stageRenew',
];

function VisualAuto() {
  const t = useT();
  return (
    <div className="lp-visual">
      <div className="lp-visual-head">
        <span className="lp-visual-title">{t('landing.highlights.auto.title')}</span>
        <span className="lp-visual-chip">
          <IconClock size={11} />
          {t('landing.highlights.auto.daysLeft')}
        </span>
      </div>

      <div className="lp-timeline">
        {CERT_STAGE_KEYS.map((key, index) => (
          <div className="lp-timeline-item" key={key}>
            <span className={`lp-timeline-dot${index < 3 ? ' is-done' : ''}`} />
            <span className="lp-timeline-label">{t(key)}</span>
          </div>
        ))}
      </div>

      <div className="lp-chat">
        <div className="lp-chat-row is-user">
          <span className="lp-chat-avatar">{t('landing.highlights.auto.chatUser')}</span>
          <span className="lp-chat-bubble">{t('landing.highlights.auto.chatCommand')}</span>
        </div>
        <div className="lp-chat-row is-bot">
          <span className="lp-chat-avatar is-bot">{t('landing.highlights.auto.chatPanel')}</span>
          <span className="lp-chat-bubble">
            {t('landing.highlights.auto.chatCard')}
            <span className="lp-chat-actions">
              <span className="lp-chat-btn is-primary">
                {t('landing.highlights.auto.chatConfirm')}
              </span>
              <span className="lp-chat-btn">{t('landing.highlights.auto.chatCancel')}</span>
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
