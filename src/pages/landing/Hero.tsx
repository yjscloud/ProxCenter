/* ==========================================================================
   产品官网 — 首屏：叙事栏 + 控制台速览 + 指令条
   ==========================================================================
   结构上的取舍（改版时的重要决定，别随手改回去）：

   1. 首屏只放两栏，不放通栏大图。
      大图要滚一屏才看得到，而这一屏最该回答的是「这东西在盯什么」。右侧那块
      「控制台速览」里的 KPI、节点负载、最近动态都是面板里真实存在的栏目，
      首屏即可见，省掉一次滚动。

   2. 检索条做成通栏的「指令条」压在首屏底部。
      它的作用是把人送去能力矩阵。放在两栏之下，才拿得到整行宽度，
      也才担得起「这里是全站唯一入口」这个位置。

   3. 速览面板里的数字全部是示意，但**栏目名与口径与真实面板一致**
      （见 Dashboard.tsx）。官网示意如果编一个面板里不存在的栏目，
      用户登录后会找不到。
   ========================================================================== */

import { Link } from 'react-router-dom';
import {
  IconCheck,
  IconChevronRight,
  IconSearch,
} from '../../components/Icons';
import { CAPABILITY_TOTAL, pick, type Bi } from './content';
import { USAGE_HIGH_PERCENT, USAGE_WARN_PERCENT } from '../../utils/format';
import { useI18n, useT, type MessageKey } from '../../i18n';

/* ---------------------------------------------------------------------------
   Hero
   --------------------------------------------------------------------------- */

/**
 * 指令条右侧的快捷词：覆盖几个最常被找的能力。
 *
 * 必须**跟着语言走**：这些词会被填进检索框去匹配能力矩阵的条目文案，而矩阵
 * 数据（content.tsx）是双语的 —— 中文界面给中文词、英文界面给英文词，否则
 * 点下去会变成「搜不到东西」的死按钮。
 */
const QUICK_TERMS: Bi[] = [
  ['模板', 'template'],
  ['防火墙', 'firewall'],
  ['快照', 'snapshot'],
  ['证书', 'certificate'],
  ['安全基线', 'baseline'],
];

const TRUST_KEYS: MessageKey[] = [
  'landing.hero.trustSinglePort',
  'landing.hero.trustInternal',
  'landing.hero.trustEncrypted',
  'landing.hero.trustAudited',
];

export interface HeroProps {
  query: string;
  onQueryChange: (value: string) => void;
  /** 提交检索：上层负责滚到能力矩阵并落定筛选 */
  onSubmit: () => void;
  consoleHref: string;
  consoleLabel: string;
}

export function Hero({ query, onQueryChange, onSubmit, consoleHref, consoleLabel }: HeroProps) {
  const t = useT();
  const { lang } = useI18n();
  return (
    <section className="lp-hero">
      <div className="lp-container">
        <div className="lp-hero-grid">
          <div className="lp-hero-copy">
            <div className="lp-badge-row">
              <span className="lp-chip">
                <span className="lp-chip-dot" />
                {t('landing.hero.compat')}
              </span>
              <span className="lp-chip">{t('landing.hero.sameOrigin')}</span>
              <span className="lp-chip">{t('landing.hero.tokenAuth')}</span>
            </div>

            <h1 className="lp-h1">
              {t('landing.hero.titleTop')}
              <br />
              <span className="lp-grad">{t('landing.hero.titleBottom')}</span>
            </h1>

            <p className="lp-lead">{t('landing.hero.lead', { count: CAPABILITY_TOTAL })}</p>

            <div className="lp-cta-row">
              <Link className="lp-btn lp-btn-primary lp-btn-lg" to={consoleHref}>
                {consoleLabel}
                <IconChevronRight size={15} />
              </Link>
              <a className="lp-btn lp-btn-ghost lp-btn-lg" href="#matrix">
                {t('landing.hero.explore')}
              </a>
            </div>

            <div className="lp-trust">
              {TRUST_KEYS.map((key) => (
                <span className="lp-trust-item" key={key}>
                  <IconCheck size={14} />
                  {t(key)}
                </span>
              ))}
            </div>
          </div>

          <aside className="lp-hero-aside">
            <ConsoleBoard />
          </aside>
        </div>

        <form
          className="lp-command-bar"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <span className="lp-command-tag">CAPABILITIES</span>
          <span className="lp-command-icon" aria-hidden="true">
            <IconSearch size={17} />
          </span>
          <input
            className="lp-command-input"
            type="search"
            value={query}
            aria-label={t('landing.hero.searchAria')}
            placeholder={t('landing.hero.searchPlaceholder', { count: CAPABILITY_TOTAL })}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <div className="lp-command-keys">
            {QUICK_TERMS.map((term) => {
              const label = pick(term, lang);
              return (
                <button
                  key={label}
                  type="button"
                  className="lp-command-key"
                  onClick={() => {
                    onQueryChange(label);
                    onSubmit();
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <button type="submit" className="lp-btn lp-btn-primary">
            {t('landing.hero.search')}
          </button>
        </form>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------
   控制台速览（纯 CSS 绘制的示意界面，对读屏隐藏）
   ---------------------------------------------------------------------------
   这里刻意不用 <img>：示意图要跟着主题令牌走，图片做不到；而且用 DOM 画出来
   的文字，读屏用户如果关掉 aria-hidden 也能读到。
   --------------------------------------------------------------------------- */

const BOARD_KPIS: { num: string; labelKey: MessageKey; tone: string }[] = [
  { num: '3/3', labelKey: 'landing.hero.board.kpiNodes', tone: 'is-green' },
  { num: '18', labelKey: 'landing.hero.board.kpiVms', tone: '' },
  { num: '42.6%', labelKey: 'landing.hero.board.kpiCpu', tone: 'is-blue' },
  { num: '2', labelKey: 'landing.hero.board.kpiPending', tone: 'is-amber' },
];

const BOARD_LOAD = [
  { name: 'node-01', pct: 72 },
  { name: 'node-02', pct: 38 },
  { name: 'db-01', pct: 88 },
];

const BOARD_FEED: {
  time: string;
  textKey: MessageKey;
  badgeKey: MessageKey;
  tone: string;
}[] = [
  {
    time: '14:02',
    textKey: 'landing.hero.board.feedStart',
    badgeKey: 'landing.hero.board.badgeSuccess',
    tone: 'is-ok',
  },
  {
    time: '14:03',
    textKey: 'landing.hero.board.feedBuild',
    badgeKey: 'landing.hero.board.badgeRunning',
    tone: 'is-run',
  },
  {
    time: '14:04',
    textKey: 'landing.hero.board.feedAudit',
    badgeKey: 'landing.hero.board.badgeDone',
    tone: 'is-ok',
  },
];

function loadTone(pct: number): string {
  /* 阈值取自全站那一份（utils/format），免得落地页演示的颜色规则和面板里不一样 */
  if (pct >= USAGE_HIGH_PERCENT) return ' is-high';
  if (pct >= USAGE_WARN_PERCENT) return ' is-warn';
  return '';
}

function ConsoleBoard() {
  const t = useT();
  return (
    <>
      <div className="lp-board" aria-hidden="true">
        <div className="lp-board-bar">
          <span className="lp-dot" />
          <span className="lp-dot" />
          <span className="lp-dot" />
          <span className="lp-board-url">panel.example.com/dashboard</span>
          <span className="lp-board-state">
            <span className="lp-board-state-dot" />
            {t('landing.hero.board.quorate')}
          </span>
        </div>

        <div className="lp-board-kpis">
          {BOARD_KPIS.map((kpi) => (
            <div className="lp-board-kpi" key={kpi.labelKey}>
              <div className={`lp-board-kpi-num ${kpi.tone}`}>{kpi.num}</div>
              <div className="lp-board-kpi-label">{t(kpi.labelKey)}</div>
            </div>
          ))}
        </div>

        <div className="lp-board-section">
          <div className="lp-board-section-head">
            <span className="lp-board-section-title">{t('landing.hero.board.load')}</span>
            <span className="lp-board-section-hint">{t('landing.hero.board.loadHint')}</span>
          </div>
          <div>
            {BOARD_LOAD.map((row) => (
              <div className="lp-load-row" key={row.name}>
                <span className="lp-load-name">{row.name}</span>
                <span className="lp-load-track">
                  <span
                    className={`lp-load-fill${loadTone(row.pct)}`}
                    style={{ width: `${row.pct}%` }}
                  />
                </span>
                <span className="lp-load-val">{row.pct}%</span>
              </div>
            ))}
          </div>
        </div>

        <div className="lp-board-section">
          <div className="lp-board-section-head">
            <span className="lp-board-section-title">{t('landing.hero.board.feed')}</span>
            <span className="lp-board-section-hint">{t('landing.hero.board.feedHint')}</span>
          </div>
          <div className="lp-feed">
            {BOARD_FEED.map((item) => (
              <div className="lp-feed-item" key={`${item.time}-${item.textKey}`}>
                <span className="lp-feed-time">{item.time}</span>
                <span className="lp-feed-text">{t(item.textKey)}</span>
                <span className={`lp-feed-badge ${item.tone}`}>{t(item.badgeKey)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="lp-board-section">
          <div className="lp-board-section-head">
            <span className="lp-board-section-title">{t('landing.hero.board.baseline')}</span>
            <span className="lp-board-section-hint">
              {t('landing.hero.board.baselineHint')}
            </span>
          </div>
          <div className="lp-board-score">
            <span className="lp-board-score-num">92</span>
            <span className="lp-board-score-unit">{t('landing.hero.board.scoreUnit')}</span>
            <span className="lp-board-score-tag">{t('landing.hero.board.scoreTag')}</span>
          </div>
        </div>
      </div>
    </>
  );
}
