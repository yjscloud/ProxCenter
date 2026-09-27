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
import { SectionHead } from './Common';

const TABS: { id: string; label: string; hint: string; icon: ReactNode }[] = [
  { id: 'dashboard', label: '集群仪表盘', hint: '态势与容量', icon: <IconDashboard size={15} /> },
  { id: 'guest', label: '虚拟机详情', hint: '电源与配置', icon: <IconVm size={15} /> },
  { id: 'firewall', label: '防火墙规则', hint: '三级作用域', icon: <IconShield size={15} /> },
  { id: 'baseline', label: '安全基线', hint: '评分与加固', icon: <IconCheck size={15} /> },
];

export function Showcase() {
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
          title="界面长这样"
          desc="四块最常用的界面 —— 切换看看它把哪些信息摆在明面上。以下均为示意，不包含任何真实集群数据。"
        />

        <div className="lp-showcase lp-reveal">
          <div
            className="lp-tabs"
            role="tablist"
            aria-label="控制台界面预览"
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
                    <span className="lp-tab-label">{tab.label}</span>
                    <span className="lp-tab-hint">{tab.hint}</span>
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
  return (
    <div className="lp-pv">
      <div className="lp-pv-kpis">
        <div className="lp-pv-kpi">
          <span className="lp-pv-kpi-label">集群节点</span>
          <span className="lp-pv-kpi-value">3 / 3 在线</span>
        </div>
        <div className="lp-pv-kpi">
          <span className="lp-pv-kpi-label">CPU 使用率</span>
          <span className="lp-pv-kpi-value is-blue">42.6%</span>
        </div>
        <div className="lp-pv-kpi">
          <span className="lp-pv-kpi-label">内存使用率</span>
          <span className="lp-pv-kpi-value is-cyan">61.2%</span>
        </div>
      </div>

      <div className="lp-pv-block">
        <div className="lp-pv-block-head">
          <span>根分区写满预测</span>
          <span className="lp-pv-chip">按日增长率 +0.9%</span>
        </div>
        <div className="lp-pv-bars">
          {CAPACITY_BARS.map((bar) => (
            <div className="lp-pv-bar" key={bar.d}>
              <span className="lp-pv-bar-fill" style={{ height: `${bar.pct}%` }} />
              <span className="lp-pv-bar-label">{bar.d}</span>
            </div>
          ))}
        </div>
        <div className="lp-pv-note">按当前趋势，约 38 天后写满 · 建议提前扩容</div>
      </div>

      <div className="lp-pv-block">
        <div className="lp-pv-block-head">
          <span>资源占用排行</span>
          <span className="lp-pv-chip">内存 Top 3</span>
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
  return (
    <div className="lp-pv">
      <div className="lp-pv-guest-head">
        <div>
          <div className="lp-pv-guest-title">
            web-01
            <span className="lp-pv-tag is-on">运行中</span>
          </div>
          <div className="lp-pv-guest-sub">VM 100 · node-01 · Ubuntu 24.04 · 4 核 / 8 GB</div>
        </div>
        <div className="lp-pv-power">
          <span className="lp-pv-power-btn is-primary">
            <IconPlay size={12} /> 开机
          </span>
          <span className="lp-pv-power-btn">
            <IconPower size={12} /> 关机
          </span>
          <span className="lp-pv-power-btn">
            <IconRefresh size={12} /> 重启
          </span>
          <span className="lp-pv-power-btn">
            <IconStop size={12} /> 停止
          </span>
          <span className="lp-pv-power-btn">
            <IconPause size={12} /> 挂起
          </span>
        </div>
      </div>

      <div className="lp-pv-gauges">
        {[
          { label: 'CPU', v: 34 },
          { label: '内存', v: 58 },
          { label: '磁盘', v: 47 },
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
          <span>设备</span>
          <span>存储 / 网桥</span>
          <span>容量</span>
        </div>
        {[
          { dev: 'scsi0', target: 'local-lvm', size: '32 GiB' },
          { dev: 'net0', target: 'vmbr0 · VLAN 20', size: '静态 IP' },
          { dev: 'cloudinit', target: 'ide2', size: '已注入' },
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

const FIREWALL_RULES = [
  { act: 'ACCEPT', proto: 'tcp', port: '22', from: '10.0.0.0/8', on: true },
  { act: 'ACCEPT', proto: 'tcp', port: '80,443', from: '所有', on: true },
  { act: 'DROP', proto: 'tcp', port: '3306', from: '所有', on: true },
  { act: 'REJECT', proto: 'udp', port: '137:139', from: '+legacy', on: false },
];

function PreviewFirewall() {
  return (
    <div className="lp-pv">
      <div className="lp-pv-scope">
        <span className="lp-pv-scope-item">集群</span>
        <span className="lp-pv-scope-item is-active">虚拟机 web-01</span>
        <span className="lp-pv-scope-item">节点 node-01</span>
        <span className="lp-pv-scope-hint">默认策略：入站 DROP · 出站 ACCEPT</span>
      </div>

      <div className="lp-pv-table">
        <div className="lp-pv-tr is-head is-5">
          <span>动作</span>
          <span>协议</span>
          <span>端口</span>
          <span>来源</span>
          <span>启用</span>
        </div>
        {FIREWALL_RULES.map((rule) => (
          <div className="lp-pv-tr is-5" key={rule.port}>
            <span className={`lp-pv-act is-${rule.act.toLowerCase()}`}>{rule.act}</span>
            <span className="lp-pv-mono">{rule.proto}</span>
            <span className="lp-pv-mono">{rule.port}</span>
            <span className="lp-pv-muted">{rule.from}</span>
            <span className={`lp-pv-switch${rule.on ? ' is-on' : ''}`} />
          </div>
        ))}
      </div>

      <div className="lp-pv-note">
        规则顺序即优先级，改动先「待应用」，确认后统一下发到 Proxmox 原生防火墙
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   预览 4：安全基线
   --------------------------------------------------------------------------- */

const BASELINE_ROWS = [
  { name: 'SSH 禁止 root 直接登录', level: '高危', ok: false },
  { name: '关闭 SSH 空口令登录', level: '高危', ok: true },
  { name: '时间同步已启用', level: '低危', ok: true },
  { name: '内核 ASLR 已开启', level: '中危', ok: true },
];

function PreviewBaseline() {
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
          <div className="lp-pv-score-title">安全基线评分 A</div>
          <div className="lp-pv-score-sub">3 台服务器受检 · 1 项不合格 · 1 项待改进</div>
          <div className="lp-pv-score-tags">
            <span className="lp-pv-chip is-green">可一键加固 1 项</span>
            <span className="lp-pv-chip">需逐项确认 1 项</span>
          </div>
        </div>
      </div>

      <div className="lp-pv-rows">
        {BASELINE_ROWS.map((row) => (
          <div className="lp-pv-check" key={row.name}>
            <span className={`lp-pv-check-icon${row.ok ? ' is-ok' : ' is-bad'}`}>
              {row.ok ? <IconCheck size={11} /> : <IconAlert size={11} />}
            </span>
            <span className="lp-pv-check-name">{row.name}</span>
            <span className={`lp-pv-level is-${row.ok ? 'ok' : 'bad'}`}>{row.level}</span>
          </div>
        ))}
      </div>

      <div className="lp-pv-note">
        改 SSH / sysctl 前先备份，改完立即校验，校验不过自动回滚
      </div>
    </div>
  );
}
