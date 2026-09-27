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
import { AUDIT_SAMPLE, PILLARS, type AuditRow } from './content';
import { SectionHead } from './Common';

const RESULT_META: Record<AuditRow['result'], { label: string; tone: string }> = {
  ok: { label: '成功', tone: 'ok' },
  denied: { label: '已拦截', tone: 'warn' },
  failed: { label: '失败', tone: 'bad' },
};

export function Security() {
  return (
    <section className="lp-band-dark" id="security">
      <div className="lp-container">
        <SectionHead
          index="05"
          eyebrow="Security & Compliance"
          title="权限、确认、留痕，一个都不省"
          desc="管的是虚拟机与宿主机，任何一次误操作代价都不小。面板在「谁能做、要不要再确认一次、做完留没留下痕迹」这三件事上没有偷懒。"
        />

        <div className="lp-defenses">
          {PILLARS.map((pillar, index) => (
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
            <span className="lp-audit-title">审计流水</span>
            <span className="lp-audit-hint">
              <IconInfo size={13} />
              示意数据 · 真实记录可在「审计日志」页按用户 / 动作 / 结果筛选
            </span>
          </div>

          <div className="lp-audit-table" role="table" aria-label="审计流水示例">
            <div className="lp-audit-tr is-head" role="row">
              <span role="columnheader">时间</span>
              <span role="columnheader">操作人</span>
              <span role="columnheader">动作</span>
              <span role="columnheader">对象</span>
              <span role="columnheader">结果</span>
            </div>
            {AUDIT_SAMPLE.map((row) => {
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
                    {meta.label}
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
