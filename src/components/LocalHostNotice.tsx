/* ==========================================================================
   ProxCenter — 面板本机（导入 / 移出）+ 主机来源说明
   ==========================================================================

   「SSH 安全 / 安全基线 / 端口与进程 / 登录审计」四个功能除了受管主机，还能管
   **面板自己所在那台服务器**：直读 /var/log 与 /proc、跑 `ss` / `last`、改 sshd
   配置与 fail2ban 策略。但它默认**不管控**，理由见后端 `app/localhost.py`：

     * 那一串动作都要相当高的权限，用户没明确要就不该默认打开；
     * 容器化部署下面板读不到宿主机的日志与 /proc，默认开着只会给出一堆
       「取不到数据」的假象，反而让人以为功能坏了。

   于是这里提供统一的入口：未导入时四个页面顶部提示一次，管理员点一下就能导入。
   导入只是打开开关，**不涉及任何凭据** —— 本机不走 SSH，直接读文件。

   状态查询（`GET /api/ssh/local`）特意不要求已导入，否则未导入时连「该不该
   显示这个按钮」都问不出来。

   ---------------------------------------------------------------------------
   顺带承担第二件事：一句「这些主机是从哪来的」。

   四个页面都会列出主机，但没人告诉他们**面板下发的机器是可以自动纳管的** ——
   不写这一句，用户只会看到「又得手工添加一台」。所以这段说明始终渲染（不分
   管理员、也不管本机导没导入），提示条才是条件渲染的那个。
   ========================================================================== */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { sshLocalApi } from '../api/endpoints';
import type { LocalHostState } from '../api/types';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardHeader } from './ui/Card';
import { Notice } from './ui/EmptyState';
import { IconServer } from './Icons';

export interface LocalHostInfo {
  /** 当前用户是不是管理员（本机只有管理员能看、能导入） */
  isAdmin: boolean;
  /** 后端返回的原始状态；还没拿到时为 undefined */
  state?: LocalHostState;
  /** 是否已导入 —— 四个页面据此决定要不要提供「本机」这一项 */
  enabled: boolean;
  /** 面板是否跑在容器里 —— 容器里不提示导入本机（读到的不是宿主机数据） */
  container: boolean;
  /** 展示名（形如 `pve01（面板本机）`） */
  name: string;
}

/**
 * 读面板本机的管控状态。四个安全页面都用它来决定「本机」这一项在不在。
 *
 * 普通用户查了也是 403，所以直接不发请求（`enabled: isAdmin`）。
 */
export function useLocalHost(): LocalHostInfo {
  const { isAdmin } = useAuth();
  const query = useQuery({
    queryKey: ['ssh', 'local'],
    queryFn: sshLocalApi.state,
    enabled: isAdmin,
    retry: false,
    /* 这是个低频开关，一分钟内不必重复问后端 */
    staleTime: 60_000,
  });
  return {
    isAdmin,
    state: query.data,
    enabled: Boolean(query.data?.enabled),
    container: Boolean(query.data?.container),
    name: query.data?.name ?? '',
  };
}

/**
 * 页面顶部的一小块：始终显示「主机来源」一句话，未导入本机时再追加提示条。
 *
 * 提示条三种情况不渲染 —— 不是管理员、状态还没拿到、已经导入过了。
 */
/**
 * 「面板本机」卡片，放在「SSH 安全 → 配置」的受管主机附近。
 *
 * 为什么不把它做成受管主机表里的一行：本机**不是** `ssh_hosts` 的记录 ——
 * 它没有凭据、不走 SSH，是直接读本机文件。而 `GET /api/ssh/hosts` 的返回会被
 * fleet 那条「逐台连上去采集」的路径消费；往里塞一个连不上的假主机，只会让
 * 采集流程多出无意义的失败。所以单独一张卡片，只提供「移出」。
 *
 * 已导入才渲染；容器部署下本机没有意义，也不渲染。
 */
export function LocalHostCard() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const local = useLocalHost();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!local.isAdmin || !local.enabled || local.container) return null;

  const when = local.state?.at
    ? new Date(local.state.at * 1000).toLocaleString()
    : '';

  const remove = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      await sshLocalApi.removeLocal();
      toast.success(t('localHost.removed'), t('localHost.removedHint'));
      await qc.invalidateQueries();
    } catch {
      toast.error(t('localHost.removeFailed'), t('localHost.removeFailedHint'));
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <Card collapsible={false}>
      <CardHeader
        title={local.name || t('sshConfig.localPanelName')}
        subtitle={t('sshConfig.localSubtitle')}
        icon={<IconServer size={16} />}
        actions={
          <Badge variant="success" size="sm" dot>
            {t('sshConfig.localActive')}
          </Badge>
        }
      />
      <p className="fs-sm text-secondary">
        {t('sshConfig.localImportedBy', {
          by: local.state?.by || t('common.unknown'),
          when: when || '—',
        })}
      </p>
      <div className="form-row">
        <Button
          size="sm"
          variant={armed ? 'danger' : 'ghost'}
          loading={busy}
          onClick={() => void remove()}
        >
          {armed ? t('sshConfig.localRemoveConfirm') : t('sshConfig.localRemove')}
        </Button>
      </div>
    </Card>
  );
}

export function LocalHostNotice() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const local = useLocalHost();
  const [busy, setBusy] = useState(false);

  /* 容器部署不提示导入本机：容器里读到的 /var/log、/proc 是容器自己的，
     把它们端上来只会让人误会面板坏了。 */
  const showImport =
    local.isAdmin && Boolean(local.state) && !local.enabled && !local.container;

  const doImport = async () => {
    setBusy(true);
    try {
      await sshLocalApi.importLocal();
      toast.success(t('localHost.imported'), t('localHost.importedHint'));
      /* 导入之后「本机」才会出现在各页面的作用域里，把所有查询重取一遍 */
      await qc.invalidateQueries();
    } catch {
      toast.error(t('localHost.importFailed'), t('localHost.importFailedHint'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {showImport ? (
        <Notice
          tone="info"
          title={t('localHost.noticeTitle')}
          action={
            <Button size="sm" loading={busy} onClick={() => void doImport()}>
              {t('localHost.importAction')}
            </Button>
          }
        >
          <span className="fs-sm">{t('localHost.noticeBody')}</span>
        </Notice>
      ) : null}

      <p className="fs-xs text-muted">
        {local.container
          ? t('managedSources.hintContainer')
          : t('managedSources.hint')}
      </p>
    </>
  );
}
