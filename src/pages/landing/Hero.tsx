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
import { CAPABILITY_TOTAL } from './content';

/* ---------------------------------------------------------------------------
   Hero
   --------------------------------------------------------------------------- */

/** 指令条右侧的快捷词：覆盖几个最常被找的能力 */
const QUICK_TERMS = ['模板', '防火墙', '快照', '证书', '安全基线'];

const TRUST = [
  '一个端口对外，无需额外反代',
  '集群凭据不出内网',
  '敏感配置加密落库',
  '写操作与敏感读取都留痕',
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
  return (
    <section className="lp-hero">
      <div className="lp-container">
        <div className="lp-hero-grid">
          <div className="lp-hero-copy">
            <div className="lp-badge-row">
              <span className="lp-chip">
                <span className="lp-chip-dot" />
                兼容 Proxmox VE 8.x / 9.x
              </span>
              <span className="lp-chip">前后端同源</span>
              <span className="lp-chip">API Token 鉴权</span>
            </div>

            <h1 className="lp-h1">
              把 Proxmox 集群
              <br />
              <span className="lp-grad">管成一份说得清的资产</span>
            </h1>

            <p className="lp-lead">
              虚拟机与容器、模板交付与配额、快照备份与应急隔离、防火墙与安全基线、
              监控告警与证书续期、飞书机器人与内网穿透 —— {CAPABILITY_TOTAL} 项能力收在
              一个浏览器窗口里，每一步操作都留痕。
            </p>

            <div className="lp-cta-row">
              <Link className="lp-btn lp-btn-primary lp-btn-lg" to={consoleHref}>
                {consoleLabel}
                <IconChevronRight size={15} />
              </Link>
              <a className="lp-btn lp-btn-ghost lp-btn-lg" href="#matrix">
                先看看能做什么
              </a>
            </div>

            <div className="lp-trust">
              {TRUST.map((text) => (
                <span className="lp-trust-item" key={text}>
                  <IconCheck size={14} />
                  {text}
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
            aria-label="检索平台能力"
            placeholder={`检索 ${CAPABILITY_TOTAL} 项能力，例如「模板」「防火墙」「快照」`}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <div className="lp-command-keys">
            {QUICK_TERMS.map((term) => (
              <button
                key={term}
                type="button"
                className="lp-command-key"
                onClick={() => {
                  onQueryChange(term);
                  onSubmit();
                }}
              >
                {term}
              </button>
            ))}
          </div>
          <button type="submit" className="lp-btn lp-btn-primary">
            检索
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

const BOARD_KPIS = [
  { num: '3/3', label: '节点在线', tone: 'is-green' },
  { num: '18', label: '虚拟机', tone: '' },
  { num: '42.6%', label: 'CPU 使用率', tone: 'is-blue' },
  { num: '2', label: '待处理', tone: 'is-amber' },
];

const BOARD_LOAD = [
  { name: 'node-01', pct: 72 },
  { name: 'node-02', pct: 38 },
  { name: 'db-01', pct: 88 },
];

const BOARD_FEED = [
  { time: '14:02', text: 'web-01 开机完成', badge: '成功', tone: 'is-ok' },
  { time: '14:03', text: '模板 debian-12 构建中', badge: '进行中', tone: 'is-run' },
  { time: '14:04', text: '安全基线巡检 3 台服务器', badge: '完成', tone: 'is-ok' },
];

function loadTone(pct: number): string {
  if (pct >= 85) return ' is-high';
  if (pct >= 65) return ' is-warn';
  return '';
}

function ConsoleBoard() {
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
            集群仲裁正常
          </span>
        </div>

        <div className="lp-board-kpis">
          {BOARD_KPIS.map((kpi) => (
            <div className="lp-board-kpi" key={kpi.label}>
              <div className={`lp-board-kpi-num ${kpi.tone}`}>{kpi.num}</div>
              <div className="lp-board-kpi-label">{kpi.label}</div>
            </div>
          ))}
        </div>

        <div className="lp-board-section">
          <div className="lp-board-section-head">
            <span className="lp-board-section-title">节点负载</span>
            <span className="lp-board-section-hint">实时 · 5s 推送</span>
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
            <span className="lp-board-section-title">最近动态</span>
            <span className="lp-board-section-hint">任务与巡检</span>
          </div>
          <div className="lp-feed">
            {BOARD_FEED.map((item) => (
              <div className="lp-feed-item" key={`${item.time}-${item.text}`}>
                <span className="lp-feed-time">{item.time}</span>
                <span className="lp-feed-text">{item.text}</span>
                <span className={`lp-feed-badge ${item.tone}`}>{item.badge}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="lp-board-section">
          <div className="lp-board-section-head">
            <span className="lp-board-section-title">安全基线</span>
            <span className="lp-board-section-hint">3 台服务器受检</span>
          </div>
          <div className="lp-board-score">
            <span className="lp-board-score-num">92</span>
            <span className="lp-board-score-unit">分 · A 级</span>
            <span className="lp-board-score-tag">2 项可一键加固</span>
          </div>
        </div>
      </div>
    </>
  );
}
