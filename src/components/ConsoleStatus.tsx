/* ==========================================================================
   ProxCenter — 顶栏「控制台状态」
   ==========================================================================

   把原先平铺在顶栏的两个徽章（后端 / PVE）收敛成一个入口。

   为什么收敛：
     * 顶栏是每一页都要用的横向空间，两个常驻徽章只回答「是否正常」这一个
       问题，却一直占着位置；一旦以后再加「任务进度」「告警数」，顶栏会变成
       一排角标；
     * 正常的绝大多数时间里，用户只需要一眼扫过「绿的」，遇到问题时才需要
       知道**具体哪一项**出了问题 —— 详情正好适合收进一层。
   所以：常态只显示一个状态点，点开才是明细。

   数据来源是既有的 `GET /api/health`，用的是全局同一个 queryKey(['health'])，
   与其它页面共享缓存，不产生额外请求。
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { clusterApi, healthApi } from '../api/endpoints';
import { useAuth } from '../hooks/useAuth';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { IconChevronDown, IconRefresh } from './Icons';

/** 总体状态的档位：决定圆点颜色与面板标题 */
type OverallTone = 'success' | 'warning' | 'danger';

const TONE_LABEL: Record<OverallTone, string> = {
  success: '运行正常',
  warning: '部分异常',
  danger: '服务异常',
};

export function ConsoleStatus() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { hasPermission } = useAuth();

  const health = useQuery({
    queryKey: ['health'],
    queryFn: healthApi.check,
    refetchInterval: 30_000,
    retry: false,
  });

  /* 全站合计：/health 只能读「默认连接」那一套，多连接部署下它的 node_count
     只是其中一台的节点数，直接显示会让人以为面板只连了一台机器。
     拿不到（没权限 / 接口失败）时静默回落到 /health 的读数。 */
  const fleet = useQuery({
    queryKey: ['cluster', 'fleet-status'],
    queryFn: clusterApi.fleetStatus,
    refetchInterval: 30_000,
    retry: false,
    enabled: hasPermission('node.view'),
  });

  const totals = fleet.data?.totals;
  const backendUp = !health.isError;
  const connected = health.data?.pve_connected ?? false;
  const offline = totals ? totals.connections - totals.online : 0;
  const tone: OverallTone = !backendUp
    ? 'danger'
    : totals
      ? (totals.no_quorum ?? 0) > 0 || totals.online === 0
        ? 'danger'
        : offline > 0
          ? 'warning'
          : 'success'
      : connected
        ? 'success'
        : 'warning';

  /* 点外部 / Esc 关闭：与命令面板、用户菜单一致 */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  /* 版本：多套 PVE 可能不是同一个版本，去重后展示（超过两个折叠成 +N） */
  const versions = (() => {
    const list = Array.from(
      new Set(
        (fleet.data?.connections ?? []).map((row) => row.version).filter(Boolean),
      ),
    );
    if (!list.length) return health.data?.pve_version || '';
    return list.length > 2
      ? `${list[0]} / ${list[1]} +${list.length - 2}`
      : list.join(' / ');
  })();
  const nodeCount = totals ? totals.nodes : health.data?.node_count;

  const summary = !backendUp
    ? '无法连接到后端服务'
    : totals
      ? `后端服务正常，${totals.online}/${totals.connections} 条 PVE 连接在线，共 ${totals.nodes} 个节点`
      : connected
        ? '后端服务正常，已连接 Proxmox VE'
        : '后端服务正常，但未连接到 Proxmox VE';

  return (
    <div className="topbar-status" ref={rootRef}>
      <button
        type="button"
        className="console-status"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={summary}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`cs-dot cs-dot-${tone}`} aria-hidden="true" />
        <span className="topbar-stat-label">控制台状态</span>
        <span className="cs-caret" aria-hidden="true">
          <IconChevronDown size={13} />
        </span>
      </button>

      {open ? (
        <div className="cs-panel" role="dialog" aria-label="控制台状态">
          <div className="cs-panel-head">
            <span className="cs-panel-title">控制台状态</span>
            <span className={`cs-tone cs-tone-${tone}`}>{TONE_LABEL[tone]}</span>
          </div>

          <div className="cs-rows">
            <div className="cs-row">
              <span className="cs-row-key">后端服务</span>
              <span className="cs-row-val">
                <Badge
                  variant={backendUp ? 'success' : 'danger'}
                  dot
                  pulse={backendUp}
                  size="sm"
                >
                  {backendUp ? '正常' : '离线'}
                </Badge>
              </span>
            </div>

            <div className="cs-row">
              <span className="cs-row-key">Proxmox VE</span>
              <span className="cs-row-val">
                {totals ? (
                  <Badge
                    variant={totals.online === totals.connections ? 'success' : 'warning'}
                    dot
                    pulse={totals.online > 0}
                    size="sm"
                  >
                    {totals.online}/{totals.connections} 条连接在线
                  </Badge>
                ) : (
                  <Badge
                    variant={connected ? 'success' : 'warning'}
                    dot
                    pulse={connected}
                    size="sm"
                  >
                    {connected ? '已连接' : '未连接'}
                  </Badge>
                )}
              </span>
            </div>

            {versions ? (
              <div className="cs-row">
                <span className="cs-row-key">PVE 版本</span>
                <span className="cs-row-val mono fs-sm">{versions}</span>
              </div>
            ) : null}

            {nodeCount !== undefined ? (
              <div className="cs-row">
                <span className="cs-row-key">
                  {totals ? 'PVE 节点（所有连接合计）' : '集群节点'}
                </span>
                <span className="cs-row-val mono fs-sm">{nodeCount} 个</span>
              </div>
            ) : null}

            {health.data?.version ? (
              <div className="cs-row">
                <span className="cs-row-key">面板版本</span>
                <span className="cs-row-val mono fs-sm">{health.data.version}</span>
              </div>
            ) : null}
          </div>

          <div className="cs-panel-foot">
            <Button
              size="sm"
              variant="ghost"
              icon={<IconRefresh size={13} />}
              loading={health.isFetching && !health.isLoading}
              onClick={() => void health.refetch()}
            >
              刷新状态
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
