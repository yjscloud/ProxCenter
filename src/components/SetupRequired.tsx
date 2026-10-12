/* ==========================================================================
   ProxCenter — 依赖 PVE 的页面共用的「还没配置 / 连不上」呈现

   两个东西，一个目的：把「不是故障」和「是故障」分开。

   · SetupRequired —— 页面级引导态。给已经知道原因的地方直接用。
   · PveQueryError —— 替页面判断该用哪一种：请求失败时，它自己决定是渲染
     引导态（SetupRequired）还是普通错误态（ErrorState）。各页面只要把原来的
     `<ErrorState .../>` 换成这一个组件即可，判断逻辑只有一份。

   为什么要分「没配连接」和「配了但连不上」：前者要做的是去添连接，后者要做的是
   去排查，而且**只有后者该给「重试」**——未配置时点多少次重试都不会成功，
   给重试按钮等于把用户引到死路，还会让人以为平台坏了。
   ========================================================================== */

import { useNavigate } from 'react-router-dom';
import { ApiError, errorMessage, isNotConfigured, isNotImplemented } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { usePveStatus, type PveStatus } from '../hooks/usePveStatus';
import { useT } from '../i18n';
import { Card } from './ui/Card';
import { EmptyState, ErrorState } from './ui/EmptyState';
import { Button } from './ui/Button';
import { IconAlert, IconPlug, IconPlus, IconRefresh } from './Icons';

/** 「添加节点」跳转的目标：连接管理页，并让它自动摊开新增表单 */
const SETUP_PATH = '/nodes/connections';

/** 页面为什么拿不到 PVE 数据 */
export type PveFailure = 'not-configured' | 'unreachable';

/**
 * 判断这次失败是不是 PVE 侧的两种「非故障」情形之一。
 *
 * 「配了但连不上」要三方同时成立才算：探测真的回来过（hasData）、说已配置、
 * 说连不上，且这次失败确实是 PVE 不可达的 502/503/504。缺一不可 —— 否则
 * 面板后端自己挂掉时，也会被说成「PVE 连不上」，那就换了个方向误导用户。
 */
export function pveFailureKind(
  error: unknown,
  status: PveStatus,
): PveFailure | null {
  if (isNotConfigured(error)) return 'not-configured';
  if (!(error instanceof ApiError)) return null;
  if (!status.hasData || !status.configured || status.reachable) return null;
  if (error.status === 502 || error.status === 503 || error.status === 504) {
    return 'unreachable';
  }
  return null;
}

/* ---------------------------------------------------------------------------
   引导态
   --------------------------------------------------------------------------- */

export function SetupRequired({
  reason = 'not-configured',
  onRetry,
}: {
  reason?: PveFailure;
  onRetry?: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const unreachable = reason === 'unreachable';

  const title = unreachable
    ? t('pve.unreachableTitle')
    : isAdmin
      ? t('setup.pveTitle')
      : t('setup.pveUserTitle');
  const description = unreachable
    ? t('pve.unreachableDesc')
    : isAdmin
      ? t('setup.pveDesc')
      : t('setup.pveUserDesc');

  /* 「重试」只出现在真故障（连不上）时；未配置时它是个必然失败的按钮 */
  const retryAction =
    unreachable && onRetry ? (
      <Button
        variant="secondary"
        icon={<IconRefresh size={15} />}
        onClick={onRetry}
      >
        {t('common.retry')}
      </Button>
    ) : null;

  /* 普通用户没有配置权限：给按钮等于给了个点不动的入口，不如只说清情况 */
  const primaryAction = !isAdmin ? null : unreachable ? (
    <Button
      variant="secondary"
      icon={<IconPlug size={15} />}
      onClick={() => navigate(SETUP_PATH)}
    >
      {t('setup.pveManage')}
    </Button>
  ) : (
    <Button
      variant="primary"
      icon={<IconPlus size={15} />}
      onClick={() => navigate(`${SETUP_PATH}?new=1`)}
    >
      {t('setup.pveAction')}
    </Button>
  );

  const action =
    retryAction || primaryAction ? (
      <div className="flex items-center gap-8">
        {retryAction}
        {primaryAction}
      </div>
    ) : undefined;

  return (
    <Card>
      <EmptyState
        title={title}
        description={description}
        icon={unreachable ? <IconAlert size={30} /> : <IconPlug size={30} />}
        action={action}
      />
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   页面错误态：自动在「引导态」与「错误态」之间选
   --------------------------------------------------------------------------- */

export function PveQueryError({
  error,
  title,
  message,
  notImplemented,
  onRetry,
}: {
  error: unknown;
  /** 普通错误态用的标题（引导态有自己的文案，不用这个）*/
  title?: string;
  /** 普通错误态用的正文；不给就退回后端给的错误文案 */
  message?: string;
  /** 默认按 `isNotImplemented(error)` 自动判断 */
  notImplemented?: boolean;
  onRetry?: () => void;
}) {
  const status = usePveStatus();

  /* 已经确定没配连接时不必等错误：页面可能压根没发请求（enabled 被关掉了），
     这时 error 是空的，但该显示的仍然是「去添加连接」的引导。 */
  if (!status.configured) return <SetupRequired />;

  const kind = pveFailureKind(error, status);
  if (kind) return <SetupRequired reason={kind} onRetry={onRetry} />;

  return (
    <ErrorState
      title={title}
      message={message ?? errorMessage(error)}
      notImplemented={notImplemented ?? isNotImplemented(error)}
      onRetry={onRetry}
    />
  );
}
