/* ==========================================================================
   产品官网 — 控制台实况
   ==========================================================================

   四块最常用的界面做成横向 Tab。与旧版的纵向 Tab 相比，横向排布后预览区
   能拿到完整的宽度 —— 里面的表格与进度条按真实比例画，不会被挤到变形。

   Tab 遵循 WAI-ARIA 的 tabs 模式：只有选中的那个 tab 可 tab 聚焦，左右方向键
   在同组内切换，Home / End 跳首尾。这样键盘用户不会一路 tab 过四个按钮。
   ========================================================================== */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  IconAlert,
  IconCheck,
  IconDashboard,
  IconPause,
  IconPlay,
  IconPower,
  IconRefresh,
  IconShield,
  IconStop,
  IconVm,
} from '../../components/Icons';
import { useT, type MessageKey } from '../../i18n';
import { SectionHead } from './Common';

const TABS: { id: string; labelKey: MessageKey; hintKey: MessageKey; icon: ReactNode }[] = [
  {
    id: 'dashboard',
    labelKey: 'landing.showcase.tabDashboard',
    hintKey: 'landing.showcase.tabDashboardHint',
    icon: <IconDashboard size={15} />,
  },
  {
    id: 'guest',
    labelKey: 'landing.showcase.tabGuest',
    hintKey: 'landing.showcase.tabGuestHint',
    icon: <IconVm size={15} />,
  },
  {
    id: 'firewall',
    labelKey: 'landing.showcase.tabFirewall',
    hintKey: 'landing.showcase.tabFirewallHint',
    icon: <IconShield size={15} />,
  },
  {
    id: 'baseline',
    labelKey: 'landing.showcase.tabBaseline',
    hintKey: 'landing.showcase.tabBaselineHint',
    icon: <IconCheck size={15} />,
  },
];

export function Showcase() {
  const t = useT();
  const [active, setActive] = useState(TABS[0].id);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const activeIndex = Math.max(
    0,
    TABS.findIndex((tab) => tab.id === active),
  );
  const current = TABS[activeIndex];

  const focusTab = useCallback((index: number) => {
    const next = TABS[index];
    if (!next) return;
    setActive(next.id);
    tabRefs.current[next.id]?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const last = TABS.length - 1;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        focusTab(activeIndex === last ? 0 : activeIndex + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
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

  const panels: Record<string, ReactNode> = {
    dashboard: <PreviewDashboard />,
    guest: <PreviewGuest />,
    firewall: <PreviewFirewall />,
    baseline: <PreviewBaseline />,
  };

  return (
    <section className="lp-section lp-section-tint" id="console">
      <div className="lp-container">
        <SectionHead
          index="02"
          eyebrow="Console"
          title={t('landing.showcase.title')}
          desc={t('landing.showcase.desc')}
        />

        <div className="lp-showcase lp-reveal">
          <div
            className="lp-tabs"
            role="tablist"
            aria-label={t('landing.showcase.aria')}
            onKeyDown={onKeyDown}
          >
            {TABS.map((tab) => {
              const selected = tab.id === current.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`lp-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={`lp-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  ref={(el) => {
                    tabRefs.current[tab.id] = el;
                  }}
                  className={`lp-tab${selected ? ' is-active' : ''}`}
                  onClick={() => setActive(tab.id)}
                >
                  <span className="lp-tab-icon">{tab.icon}</span>
                  <span className="lp-tab-text">
                    <span className="lp-tab-label">{t(tab.labelKey)}</span>
                    <span className="lp-tab-hint">{t(tab.hintKey)}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* key 让切换时面板重新挂载，从而重放一次淡入 */}
          <div
            className="lp-stage"
            key={current.id}
            role="tabpanel"
            id={`lp-panel-${current.id}`}
            aria-labelledby={`lp-tab-${current.id}`}
            tabIndex={0}
          >
            <div className="lp-stage-bar">
              <span className="lp-dot" />
              <span className="lp-dot" />
              <span className="lp-dot" />
              <span className="lp-stage-url">panel.example.com</span>
            </div>
            <div className="lp-stage-body">{panels[current.id]}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------
   预览 1：集群仪表盘
   --------------------------------------------------------------------------- */

const CAPACITY_BARS = [
  { d: '07-01', pct: 42 },
  { d: '07-08', pct: 55 },
  { d: '07-15', pct: 61 },
  { d: '07-22', pct: 78 },
  { d: '07-29', pct: 91 },
];

function PreviewDashboard() {
  const t = useT();
  return (
    <div className="lp-pv">
      <div className="lp-pv-kpis">
        <div className="lp-pv-kpi">
          <span className="lp-pv-kpi-label">{t('landing.showcase.nodesLabel')}</span>
          <span className="lp-pv-kpi-value">{t('landing.showcase.nodesValue')}</span>
        </div>
        <div className="lp-pv-kpi">
          <span className="lp-pv-kpi-label">{t('landing.showcase.cpuLabel')}</span>
          <span className="lp-pv-kpi-value is-blue">42.6%</span>
        </div>
        <div className="lp-pv-kpi">
          <span className="lp-pv-kpi-label">{t('landing.showcase.memLabel')}</span>
          <span className="lp-pv-kpi-value is-cyan">61.2%</span>
        </div>
      </div>

      <div className="lp-pv-block">
        <div className="lp-pv-block-head">
          <span>{t('landing.showcase.forecastTitle')}</span>
          <span className="lp-pv-chip">{t('landing.showcase.forecastChip')}</span>
        </div>
        <div className="lp-pv-bars">
          {CAPACITY_BARS.map((bar) => (
            <div className="lp-pv-bar" key={bar.d}>
              <span className="lp-pv-bar-fill" style={{ height: `${bar.pct}%` }} />
              <span className="lp-pv-bar-label">{bar.d}</span>
            </div>
          ))}
        </div>
        <div className="lp-pv-note">{t('landing.showcase.forecastNote')}</div>
      </div>

      <div className="lp-pv-block">
        <div className="lp-pv-block-head">
          <span>{t('landing.showcase.topTitle')}</span>
          <span className="lp-pv-chip">{t('landing.showcase.topChip')}</span>
        </div>
        <div className="lp-pv-rows">
          {[
            { n: 'db-01', v: 88 },
            { n: 'web-01', v: 63 },
            { n: 'cache-01', v: 41 },
          ].map((row, index) => (
            <div className="lp-pv-row" key={row.n}>
              <span className="lp-pv-rank">{index + 1}</span>
              <span className="lp-pv-row-name">{row.n}</span>
              <span className="lp-pv-track">
                <span className="lp-pv-fill" style={{ width: `${row.v}%` }} />
              </span>
              <span className="lp-pv-row-val">{row.v}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   预览 2：虚拟机详情
   --------------------------------------------------------------------------- */

function PreviewGuest() {
  const t = useT();
  return (
    <div className="lp-pv">
      <div className="lp-pv-guest-head">
        <div>
          <div className="lp-pv-guest-title">
            web-01
            <span className="lp-pv-tag is-on">{t('landing.showcase.running')}</span>
          </div>
          <div className="lp-pv-guest-sub">{t('landing.showcase.guestSub')}</div>
        </div>
        <div className="lp-pv-power">
          <span className="lp-pv-power-btn is-primary">
            <IconPlay size={12} /> {t('landing.showcase.powerOn')}
          </span>
          <span className="lp-pv-power-btn">
            <IconPower size={12} /> {t('landing.showcase.powerOff')}
          </span>
          <span className="lp-pv-power-btn">
            <IconRefresh size={12} /> {t('landing.showcase.reboot')}
          </span>
          <span className="lp-pv-power-btn">
            <IconStop size={12} /> {t('landing.showcase.stop')}
          </span>
          <span className="lp-pv-power-btn">
            <IconPause size={12} /> {t('landing.showcase.suspend')}
          </span>
        </div>
      </div>

      <div className="lp-pv-gauges">
        {[
          { label: 'CPU', v: 34 },
          { label: t('landing.showcase.gaugeMemory'), v: 58 },
          { label: t('landing.showcase.gaugeDisk'), v: 47 },
        ].map((gauge) => (
          <div className="lp-pv-gauge" key={gauge.label}>
            <div className="lp-pv-gauge-top">
              <span>{gauge.label}</span>
              <span className="lp-pv-gauge-val">{gauge.v}%</span>
            </div>
            <span className="lp-pv-track">
              <span className="lp-pv-fill" style={{ width: `${gauge.v}%` }} />
            </span>
          </div>
        ))}
      </div>

      <div className="lp-pv-table">
        <div className="lp-pv-tr is-head">
          <span>{t('landing.showcase.colDevice')}</span>
          <span>{t('landing.showcase.colTarget')}</span>
          <span>{t('landing.showcase.colSize')}</span>
        </div>
        {[
          { dev: 'scsi0', target: 'local-lvm', size: '32 GiB' },
          { dev: 'net0', target: 'vmbr0 · VLAN 20', size: t('landing.showcase.sizeStaticIp') },
          { dev: 'cloudinit', target: 'ide2', size: t('landing.showcase.sizeInjected') },
        ].map((row) => (
          <div className="lp-pv-tr" key={row.dev}>
            <span className="lp-pv-mono">{row.dev}</span>
            <span>{row.target}</span>
            <span className="lp-pv-muted">{row.size}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   预览 3：防火墙规则
   --------------------------------------------------------------------------- */

/** `any` 只是哨兵值：真要显示的「所有」随语言变，判断在渲染处 */
const FIREWALL_RULES = [
  { act: 'ACCEPT', proto: 'tcp', port: '22', from: '10.0.0.0/8', on: true },
  { act: 'ACCEPT', proto: 'tcp', port: '80,443', from: 'any', on: true },
  { act: 'DROP', proto: 'tcp', port: '3306', from: 'any', on: true },
  { act: 'REJECT', proto: 'udp', port: '137:139', from: '+legacy', on: false },
];

function PreviewFirewall() {
  const t = useT();
  return (
    <div className="lp-pv">
      <div className="lp-pv-scope">
        <span className="lp-pv-scope-item">{t('landing.showcase.scopeCluster')}</span>
        <span className="lp-pv-scope-item is-active">{t('landing.showcase.scopeVm')}</span>
        <span className="lp-pv-scope-item">{t('landing.showcase.scopeNode')}</span>
        <span className="lp-pv-scope-hint">{t('landing.showcase.scopeHint')}</span>
      </div>

      <div className="lp-pv-table">
        <div className="lp-pv-tr is-head is-5">
          <span>{t('landing.showcase.colAction')}</span>
          <span>{t('landing.showcase.colProto')}</span>
          <span>{t('landing.showcase.colPort')}</span>
          <span>{t('landing.showcase.colFrom')}</span>
          <span>{t('landing.showcase.colEnabled')}</span>
        </div>
        {FIREWALL_RULES.map((rule) => (
          <div className="lp-pv-tr is-5" key={rule.port}>
            <span className={`lp-pv-act is-${rule.act.toLowerCase()}`}>{rule.act}</span>
            <span className="lp-pv-mono">{rule.proto}</span>
            <span className="lp-pv-mono">{rule.port}</span>
            <span className="lp-pv-muted">
              {rule.from === 'any' ? t('landing.showcase.fromAny') : rule.from}
            </span>
            <span className={`lp-pv-switch${rule.on ? ' is-on' : ''}`} />
          </div>
        ))}
      </div>

      <div className="lp-pv-note">{t('landing.showcase.firewallNote')}</div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   预览 4：安全基线
   --------------------------------------------------------------------------- */

/** 与「重点能力」区的基线示意共用同一组词条：展示的是同一条检查项，没必要建两份 */
const BASELINE_ROWS: { nameKey: MessageKey; levelKey: MessageKey; ok: boolean }[] = [
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

function PreviewBaseline() {
  const t = useT();
  return (
    <div className="lp-pv">
      <div className="lp-pv-score">
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
        <div className="lp-pv-score-text">
          <div className="lp-pv-score-title">{t('landing.highlights.baseline.score')}</div>
          <div className="lp-pv-score-sub">{t('landing.highlights.baseline.scoreSub')}</div>
          <div className="lp-pv-score-tags">
            <span className="lp-pv-chip is-green">
              {t('landing.highlights.baseline.chipFix')}
            </span>
            <span className="lp-pv-chip">{t('landing.highlights.baseline.chipReview')}</span>
          </div>
        </div>
      </div>

      <div className="lp-pv-rows">
        {BASELINE_ROWS.map((row) => (
          <div className="lp-pv-check" key={row.nameKey}>
            <span className={`lp-pv-check-icon${row.ok ? ' is-ok' : ' is-bad'}`}>
              {row.ok ? <IconCheck size={11} /> : <IconAlert size={11} />}
            </span>
            <span className="lp-pv-check-name">{t(row.nameKey)}</span>
            <span className={`lp-pv-level is-${row.ok ? 'ok' : 'bad'}`}>
              {t(row.levelKey)}
            </span>
          </div>
        ))}
      </div>

      <div className="lp-pv-note">{t('landing.showcase.baselineNote')}</div>
    </div>
  );
}
