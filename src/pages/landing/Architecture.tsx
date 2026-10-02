/* ==========================================================================
   产品官网 — 架构拓扑
   ==========================================================================

   用「访问入口 → 面板 → 多套 Proxmox 连接」的三段式讲清一件事：
   **PVE 的 8006 端口不需要对外暴露**。左侧到面板是唯一需要开放的入口，
   右侧那一段是内网出站流量。

   纯 HTML/CSS 绘制（连线是渐变细条），不依赖任何图形库。
   ========================================================================== */

import { IconActivity, IconChat, IconMonitor, IconServer, IconShield } from '../../components/Icons';
import { TOPO_CLUSTERS, TOPO_CORE, TOPO_ENTRIES } from './content';
import { SectionHead, StatusPill } from './Common';

const ENTRY_ICONS = [<IconMonitor size={15} />, <IconActivity size={15} />, <IconChat size={15} />];

const NOTES = [
  '面板与 Proxmox 之间只走内网出站请求，PVE 的 8006 端口不必对公网开放',
  '控制台的 VNC 是 WebSocket 双向透传，同样经面板转发，不直连 PVE',
  '任一连接不可达只影响它自己的节点与存储，不会让整块页面报错',
];

export function Architecture() {
  return (
    <section className="lp-section" id="architecture">
      <div className="lp-container">
        <SectionHead
          index="03"
          eyebrow="Architecture"
          title="一套面板，管住多套集群"
          desc="面板是唯一的对外入口。左边是浏览器与机器人，右边是多套 Proxmox 连接 —— 中间这一层负责鉴权、审计、实时通道与后台值守。"
        />

        <div className="lp-topo lp-reveal">
          {/* 左：访问入口 */}
          <div className="lp-topo-col">
            <div className="lp-topo-col-label">访问入口</div>
            {TOPO_ENTRIES.map((entry, index) => (
              <div className="lp-topo-card" key={entry.name}>
                <span className="lp-topo-card-icon">{ENTRY_ICONS[index]}</span>
                <div className="lp-topo-card-body">
                  <span className="lp-topo-card-name">{entry.name}</span>
                  <span className="lp-topo-card-desc">{entry.desc}</span>
                </div>
              </div>
            ))}
          </div>

          {/* 中左连线 */}
          <div className="lp-topo-link" aria-hidden="true">
            <span className="lp-topo-link-line" />
            <span className="lp-topo-link-label">HTTPS · WebSocket</span>
          </div>

          {/* 中：面板 */}
          <div className="lp-topo-core">
            <div className="lp-topo-core-head">
              <span className="lp-topo-core-mark" />
              <span>面板服务</span>
              <StatusPill tone="ok">同源托管</StatusPill>
            </div>
            <div className="lp-topo-core-sub">FastAPI :8080 · MySQL 8 · 单进程对外</div>
            <div className="lp-topo-core-blocks">
              {TOPO_CORE.map((block) => (
                <div className="lp-topo-block" key={block.name}>
                  <span className="lp-topo-block-name">{block.name}</span>
                  <span className="lp-topo-block-desc">{block.desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 中右连线 */}
          <div className="lp-topo-link" aria-hidden="true">
            <span className="lp-topo-link-line" />
            <span className="lp-topo-link-label">PVE API · 出站</span>
          </div>

          {/* 右：多套连接 */}
          <div className="lp-topo-col">
            <div className="lp-topo-col-label">Proxmox 连接</div>
            {TOPO_CLUSTERS.map((cluster) => {
              const online = cluster.meta === '在线';
              return (
                <div className={`lp-topo-cluster${online ? '' : ' is-down'}`} key={cluster.name}>
                  <div className="lp-topo-cluster-head">
                    <span className="lp-topo-cluster-icon">
                      <IconServer size={14} />
                    </span>
                    <span className="lp-topo-cluster-name">{cluster.name}</span>
                    <StatusPill tone={online ? 'ok' : 'bad'}>{cluster.meta}</StatusPill>
                  </div>
                  <div className="lp-topo-cluster-meta">
                    {cluster.nodes} · 节点 / 存储 / 虚拟机与容器
                  </div>
                </div>
              );
            })}
            <div className="lp-topo-cluster-hint">
              <IconShield size={13} />
              按连接隔离，容量与配额跨连接统一统计
            </div>
          </div>
        </div>

        <ul className="lp-topo-notes lp-reveal">
          {NOTES.map((note) => (
            <li className="lp-topo-note" key={note}>
              <span className="lp-topo-note-bar" />
              {note}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
