/* ==========================================================================
   ProxCenter — 节点域的子页面切换
   ==========================================================================

   「有哪些 PVE 主机可管」和「这些主机上有哪些节点」是同一件事的两面：
   节点连不上时，要修的是连接；新增一台主机，用的也是连接表单。
   所以它们同属「节点」这一个功能域，做成两个真实路由而不是页面内 tab ——
   URL 会变，浏览器前进/后退、直接分享链接都成立。

   与 SSH 安全那两个页面用的是同一套 `.subnav` 样式，视觉上属于同一个模式。
   ========================================================================== */

import { Link } from 'react-router-dom';
import { IconPlug, IconServer } from './Icons';
import { useT } from '../i18n';

export type NodeSubPage = 'nodes' | 'connections';

export function NodeSubNav({ active }: { active: NodeSubPage }) {
  const t = useT();
  const items: Array<{ key: NodeSubPage; to: string; label: string; icon: React.ReactNode }> = [
    {
      key: 'nodes',
      to: '/nodes',
      label: t('nodeNav.labelNodes'),
      icon: <IconServer size={14} />,
    },
    {
      key: 'connections',
      to: '/nodes/connections',
      label: t('nodeNav.labelConnections'),
      icon: <IconPlug size={14} />,
    },
  ];

  return (
    /* 与 SSH 安全那两个页面用同一套结构：这里不写 role="tablist" ——
       它们是两个真实页面（导航链接），不是同一个控件里的 tab；
       当前页用 aria-current="page" 表达即可。 */
    <nav className="subnav" aria-label={t('nodeNav.aria')}>
      {items.map((item) =>
        item.key === active ? (
          <span key={item.key} className="subnav-item is-active" aria-current="page">
            {item.icon} {item.label}
          </span>
        ) : (
          <Link key={item.key} className="subnav-item" to={item.to}>
            {item.icon} {item.label}
          </Link>
        ),
      )}
    </nav>
  );
}
