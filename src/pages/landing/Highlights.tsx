/* ==========================================================================
   产品官网 — 重点能力（左右交替 + 示意图）
   ==========================================================================

   四块内容用「左文右图 / 右文左图」交替排布，而不是四张一样的卡片 ——
   连续四张同构卡片会让人直接跳过中间两张。交替之后视线会被迫走一遍 Z 字，
   每一块才真正被读到。

   每块配一张与该能力**直接相关**的示意图（流水线就画五步流程、隔离就画
   处置顺序），而不是放一张通用插图：图本身就是内容的一部分。
   ========================================================================== */

import { IconAlert, IconCheck, IconClock, IconShield } from '../../components/Icons';
import { HIGHLIGHTS, type VisualKind } from './content';
import { SectionHead } from './Common';

export function Highlights() {
  return (
    <section className="lp-section lp-section-tint" id="highlights">
      <div className="lp-container">
        <SectionHead
          index="04"
          eyebrow="Highlights"
          title="最值得单说的四件事"
          desc="不是功能清单的复读，而是运维真正会因为它们决定用不用这个面板的地方。"
        />

        <div className="lp-rows">
          {HIGHLIGHTS.map((item, index) => (
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
    case 'pipeline':
      return <VisualPipeline />;
    case 'contain':
      return <VisualContain />;
    case 'baseline':
      return <VisualBaseline />;
    case 'auto':
      return <VisualAuto />;
  }
}

/* ---- 1. 模板流水线：五步顺序推进，末步还在跑 ---- */

const PIPELINE_STEPS = [
  { label: '创建空壳虚拟机', state: 'done' },
  { label: 'importdisk 导入镜像', state: 'done' },
  { label: '挂载 cloud-init 驱动', state: 'done' },
  { label: '按需扩容系统盘', state: 'run' },
  { label: '转换为模板', state: 'todo' },
] as const;

function VisualPipeline() {
  return (
    <div className="lp-visual">
      <div className="lp-visual-head">
        <span className="lp-visual-title">构建 debian-12 模板</span>
        <span className="lp-visual-chip">每步等待 PVE 任务完成</span>
      </div>
      <ol className="lp-steps-v">
        {PIPELINE_STEPS.map((step) => (
          <li className={`lp-step-v is-${step.state}`} key={step.label}>
            <span className="lp-step-v-mark">
              {step.state === 'done' ? <IconCheck size={11} /> : null}
            </span>
            <span className="lp-step-v-label">{step.label}</span>
            {step.state === 'run' ? <span className="lp-step-v-tag">进行中</span> : null}
            {step.state === 'todo' ? <span className="lp-step-v-tag is-muted">待执行</span> : null}
          </li>
        ))}
      </ol>
      <div className="lp-visual-note">
        任一步失败 → 自动删除临时虚拟机，不留半成品
      </div>
    </div>
  );
}

/* ---- 2. 应急隔离：处置顺序是内容本身 ---- */

function VisualContain() {
  return (
    <div className="lp-visual">
      <div className="lp-visual-head">
        <span className="lp-visual-title">可疑虚拟机隔离处置</span>
        <span className="lp-visual-chip is-warn">顺序不可颠倒</span>
      </div>

      <div className="lp-order">
        {['① 取证快照', '② 断开网卡', '③ 关机'].map((label, index) => (
          <div className="lp-order-item" key={label}>
            <span className="lp-order-text">{label}</span>
            {index < 2 ? <span className="lp-order-arrow" aria-hidden="true" /> : null}
          </div>
        ))}
      </div>

      <div className="lp-contrast">
        <div className="lp-contrast-row is-bad">
          <IconAlert size={13} />
          <span className="lp-contrast-text">
            先关机再取证 —— <s>机器一关，内存里的现场就没了</s>
          </span>
        </div>
        <div className="lp-contrast-row is-good">
          <IconShield size={13} />
          <span className="lp-contrast-text">先快照、再断网、后关机，每一步单独回报成败</span>
        </div>
      </div>
    </div>
  );
}

/* ---- 3. 安全基线：评分环 + 检查项 ---- */

const BASELINE_CHECKS = [
  { name: 'SSH 禁止 root 直接登录', level: '高危', ok: false },
  { name: '关闭 SSH 空口令登录', level: '高危', ok: true },
  { name: '时间同步已启用', level: '低危', ok: true },
  { name: '内核 ASLR 已开启', level: '中危', ok: true },
];

function VisualBaseline() {
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
          <div className="lp-score-title">安全基线评分 A</div>
          <div className="lp-score-sub">3 台服务器受检 · 1 项不合格 · 1 项待改进</div>
          <div className="lp-score-tags">
            <span className="lp-chip is-green">可一键加固 1 项</span>
            <span className="lp-chip">需逐项确认 1 项</span>
          </div>
        </div>
      </div>

      <div className="lp-check-list">
        {BASELINE_CHECKS.map((check) => (
          <div className="lp-check" key={check.name}>
            <span className={`lp-check-icon${check.ok ? ' is-ok' : ' is-bad'}`}>
              {check.ok ? <IconCheck size={11} /> : <IconAlert size={11} />}
            </span>
            <span className="lp-check-name">{check.name}</span>
            <span className={`lp-check-level is-${check.ok ? 'ok' : 'bad'}`}>{check.level}</span>
          </div>
        ))}
      </div>

      <div className="lp-visual-note">改完立即校验，校验不过自动回滚</div>
    </div>
  );
}

/* ---- 4. 自动化：证书续期时间轴 + 飞书确认卡片 ---- */

const CERT_STAGES = ['申请', '域名校验', 'CA 签发', '部署到目标', '到期前自动续期'];

function VisualAuto() {
  return (
    <div className="lp-visual">
      <div className="lp-visual-head">
        <span className="lp-visual-title">免费 DV 证书全流程</span>
        <span className="lp-visual-chip">
          <IconClock size={11} />
          剩余 74 天
        </span>
      </div>

      <div className="lp-timeline">
        {CERT_STAGES.map((stage, index) => (
          <div className="lp-timeline-item" key={stage}>
            <span className={`lp-timeline-dot${index < 3 ? ' is-done' : ''}`} />
            <span className="lp-timeline-label">{stage}</span>
          </div>
        ))}
      </div>

      <div className="lp-chat">
        <div className="lp-chat-row is-user">
          <span className="lp-chat-avatar">飞书</span>
          <span className="lp-chat-bubble">@机器人 重启 web-01</span>
        </div>
        <div className="lp-chat-row is-bot">
          <span className="lp-chat-avatar is-bot">面板</span>
          <span className="lp-chat-bubble">
            危险操作确认卡片
            <span className="lp-chat-actions">
              <span className="lp-chat-btn is-primary">确认重启</span>
              <span className="lp-chat-btn">取消</span>
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
