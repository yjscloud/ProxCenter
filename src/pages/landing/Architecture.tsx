/* ==========================================================================
   产品官网 — 架构拓扑
   ==========================================================================

   用「访问入口 → 面板 → 多套 Proxmox 连接」的三段式讲清一件事：
   **PVE 的 8006 端口不需要对外暴露**。左侧到面板是唯一需要开放的入口，
   右侧那一段是内网出站流量。

   纯 HTML/CSS 绘制（连线是渐变细条），不依赖任何图形库。
   ========================================================================== */

import { IconActivity, IconChat, IconMonitor, IconServer, IconShield } from '../../components/Icons';
import { useT, type MessageKey } from '../../i18n';
import { useLandingContent } from './hooks';
import { SectionHead, StatusPill } from './Common';

const ENTRY_ICONS = [<IconMonitor size={15} />, <IconActivity size={15} />, <IconChat size={15} />];

const NOTE_KEYS: MessageKey[] = [
  'landing.architecture.noteInternal',
  'landing.architecture.noteConsole',
  'landing.architecture.noteIsolated',
];

export function Architecture() {
  const t = useT();
  const { topoEntries, topoCore, topoClusters } = useLandingContent();

  return (
    <section className="lp-section" id="architecture">
      <div className="lp-container">
        <SectionHead
          index="03"
          eyebrow="Architecture"
          title={t('landing.architecture.title')}
          desc={t('landing.architecture.desc')}
        />

        <div className="lp-topo lp-reveal">
          {/* 左：访问入口 */}
          <div className="lp-topo-col">
            <div className="lp-topo-col-label">{t('landing.architecture.entriesLabel')}</div>
            {topoEntries.map((entry, index) => (
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
              <span>{t('landing.architecture.coreName')}</span>
              <StatusPill tone="ok">{t('landing.architecture.corePill')}</StatusPill>
            </div>
            <div className="lp-topo-core-sub">{t('landing.architecture.coreSub')}</div>
            <div className="lp-topo-core-blocks">
              {topoCore.map((block) => (
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
            <span className="lp-topo-link-label">{t('landing.architecture.linkOut')}</span>
          </div>

          {/* 右：多套连接 */}
          <div className="lp-topo-col">
            <div className="lp-topo-col-label">{t('landing.architecture.clustersLabel')}</div>
            {topoClusters.map((cluster) => {
              const online = cluster.online;
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
                    {t('landing.architecture.clusterMeta', { nodes: cluster.nodes })}
                  </div>
                </div>
              );
            })}
            <div className="lp-topo-cluster-hint">
              <IconShield size={13} />
              {t('landing.architecture.clusterHint')}
            </div>
          </div>
        </div>

        <ul className="lp-topo-notes lp-reveal">
          {NOTE_KEYS.map((key) => (
            <li className="lp-topo-note" key={key}>
              <span className="lp-topo-note-bar" />
              {t(key)}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
