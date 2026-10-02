/* ==========================================================================
   ProxCenter — Proxmox 连接管理
   ==========================================================================

   原先这块 UI 住在「系统设置」里，但设置页是「面板自己的偏好」，
   连接管理是「有哪些 PVE 主机可管」—— 后者属于节点域：出问题时用户在
   「节点」页看到连接异常，修正的入口却要跳到另一个页面去找。

   现已整体搬到节点页（`/nodes`），本文件只负责渲染，不自带页面骨架：
   它既可以作为节点页的一张卡片，也可以在别处以弹窗形式复用。

   权限：读连接列表只要登录；写（新增 / 修改 / 删除 / 修复权限）需要
   `settings.manage`，并会触发二次确认（step-up）。

   **不再区分「当前连接」与「默认节点」**：面板能同时连多台 PVE，读数据的
   接口都带 `?conn=<id>` 各自取数，没有哪一台比别人更「正式」。原先那条
   「设为当前」按钮只会让人以为其余连接是次要的、甚至没接上 —— 现在每条
   连接平权，各自显示自己**能不能连上**（这才是用户真正关心的问题）。

   想进来就直接填一台新主机，用 `/nodes/connections?new=1`。
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { configApi, connectionsApi, nodesApi } from '../api/endpoints';
import { errorMessage, isNotImplemented } from '../api/client';
import { Card, CardHeader } from './ui/Card';
import { Badge } from './ui/Badge';
import { Button, IconButton } from './ui/Button';
import { Input, Switch, Field } from './ui/Input';
import { Modal } from './ui/Modal';
import { Notice, EmptyState, ErrorState, CollapsibleCard } from './ui/EmptyState';
import {
  IconPlug,
  IconKey,
  IconShield,
  IconActivity,
  IconServer,
  IconSave,
  IconCheck,
  IconClose,
  IconConsole,
  IconLayers,
  IconChevronDown,
  IconEye,
  IconEyeOff,
  IconPlus,
  IconTrash,
} from './Icons';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';
import type {
  ConnectionConfigInput,
  ConnectionProfile,
  ConnectionStatus,
  ConnectionTestResult,
  DiagnosticsResult,
} from '../api/types';

export interface ConnectionManagerProps {
  isAdmin: boolean;
}

export function ConnectionManager({ isAdmin }: ConnectionManagerProps) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  /* ?new=1 = 进来就摊开「新增连接」表单（节点页的「添加节点」从这里进） */
  const [searchParams, setSearchParams] = useSearchParams();

  const [form, setForm] = useState<ConnectionConfigInput>({
    name: '',
    host: '',
    port: 8006,
    token_id: '',
    token_secret: '',
    console_user: '',
    console_password: '',
    verify_ssl: false,
    node_default: '',
  });
  /* 多连接：当前正在编辑哪一条（null 表示「新建」） */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [showConsolePassword, setShowConsolePassword] = useState(false);
  /* 后端不回传 secret 明文，只告知「是否已设置」——用它决定是否必填 */
  const [secretAlreadySet, setSecretAlreadySet] = useState(false);
  const [consolePasswordSet, setConsolePasswordSet] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResult | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  /* 正在执行「一键修复令牌权限」的连接 id */
  const [repairingId, setRepairingId] = useState<string | null>(null);

  /* ---- 读取配置（当前连接）与全部连接 ---- */
  const configQuery = useQuery({
    queryKey: ['config', 'connection'],
    queryFn: () => configApi.getConnection(),
    staleTime: 30_000,
  });

  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    staleTime: 15_000,
  });
  const connections = connectionsQuery.data ?? [];

  /* 逐条探测可达性：连接列表真正要回答的是「能不能连上」，
     这正是原先「谁是当前连接」标记没回答的问题。 */
  const statusQuery = useQuery({
    queryKey: ['connections', 'status'],
    queryFn: connectionsApi.status,
    refetchInterval: 30_000,
    retry: false,
  });
  const statusById = useMemo(() => {
    const map = new Map<string, ConnectionStatus>();
    for (const item of statusQuery.data ?? []) map.set(item.id, item);
    return map;
  }, [statusQuery.data]);

  /* 每条连接下面挂着哪些节点 —— 「这台主机接进来后到底看到了几个节点」
     是连接列表最该回答的第二个问题（第一个是能不能连上）。
     复用节点页那份 ['nodes'] 缓存：同一个键、同一份数据，切页不重复请求。 */
  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    staleTime: 60_000,
  });
  const nodesByConnection = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const n of nodesQuery.data ?? []) {
      const key = n.connection_id ?? '';
      const list = map.get(key);
      if (list) list.push(n.node);
      else map.set(key, [n.node]);
    }
    for (const list of map.values()) list.sort();
    return map;
  }, [nodesQuery.data]);

  /* 表单改成弹窗：一页里同时塞「连接列表 + 一张长表单」时，列表总要被表单
     顶到屏幕外，而新增 / 编辑本来就是低频动作，不该常驻占位。 */
  const [formOpen, setFormOpen] = useState(false);
  /* 展开看节点名的那几条连接（默认收起：节点多的集群一屏就满了） */
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const toggleNodes = (id: string) =>
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /* 首次载入：编辑表单落在第一条连接上（列表按保存顺序排列，
     不再有「当前连接」需要优先挑出来） */
  useEffect(() => {
    if (initialized || dirty || connections.length === 0) return;
    const active = connections[0];
    setEditingId(active.id);
    setForm({
      name: active.name ?? '',
      host: active.host ?? '',
      port: active.port ?? 8006,
      token_id: active.token_id ?? '',
      token_secret: '',
      console_user: active.console_user ?? '',
      console_password: '',
      verify_ssl:
        active.verify_ssl ?? configQuery.data?.verify_ssl_default ?? false,
      node_default: active.node_default ?? '',
    });
    setSecretAlreadySet(Boolean(active.token_secret_set));
    setConsolePasswordSet(Boolean(active.console_password_set));
    setDirty(false);
    setInitialized(true);
  }, [connections, initialized, dirty]);

  const patch = <K extends keyof ConnectionConfigInput>(
    key: K,
    value: ConnectionConfigInput[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    // 修改任何字段后，上次的测试结果就失效了
    setTestResult(null);
    setDiagnostics(null);
  };

  const validate = (): boolean => {
    const next: Record<string, string> = {};

    const host = form.host.trim();
    if (!host) next.host = t('conn.errHostRequired');
    else if (!/^[a-zA-Z0-9.-]+$/.test(host) && !/^\[?[0-9a-fA-F:]+\]?$/.test(host)) {
      next.host = t('conn.errHostFormat');
    }

    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      next.port = t('conn.errPort');
    }

    if (!form.token_id.trim()) {
      next.token_id = t('conn.errTokenIdRequired');
    } else if (!form.token_id.includes('!')) {
      next.token_id = t('conn.errTokenIdFormat');
    }

    const secret = (form.token_secret ?? '').trim();
    // 已存过 secret 时留空是合法的（表示保持不变）
    if (!secret && !secretAlreadySet) {
      next.token_secret = t('conn.errTokenSecretRequired');
    } else if (secret && secret.length < 32) {
      next.token_secret = t('conn.errTokenSecretLength');
    }

    // 默认节点可由后端自动推断，不再是必填项
    void 0;

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  /* ---- 测试连接 ---- */
  const testConnection = async () => {
    if (!validate()) {
      toast.error(t('conn.fixFormErrors'));
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await configApi.testConnection({
        host: form.host.trim(),
        port: Number(form.port),
        token_id: form.token_id.trim(),
        // 留空时后端会复用已保存的 secret
        token_secret: (form.token_secret ?? '').trim(),
        verify_ssl: form.verify_ssl,
      });
      setTestResult(result);
      if (result.ok) {
        toast.success(
          t('conn.testOk'),
          `Proxmox ${result.version || ''} ${result.release || ''}`.trim(),
        );
      } else {
        toast.error(
          t('conn.testFailed'),
          result.message || t('conn.rejectedCredentials'),
        );
      }
    } catch (err) {
      setTestResult({
        ok: false,
        version: '',
        release: '',
        nodes: [],
        message: errorMessage(err),
      });
      toast.error(t('conn.testError'), errorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  /* ---- 环境自检 ---- */
  /* 用已保存的凭据探测 Proxmox，报告有效权限与实际可用的能力。
     目的是把「令牌权限不足导致列表全空」这类问题直接讲清楚。 */
  const runDiagnostics = async () => {
    setDiagnosing(true);
    try {
      const result = await configApi.diagnostics();
      setDiagnostics(result);
      if (result.ok) {
        toast.success(
          t('conn.diagOk'),
          result.status === 'warn' ? t('conn.diagWarn') : '',
        );
      } else {
        toast.error(t('conn.diagIssues'), t('conn.diagSeeReport'));
      }
    } catch (err) {
      setDiagnostics(null);
      toast.error(t('conn.diagError'), errorMessage(err));
    } finally {
      setDiagnosing(false);
    }
  };

  /* ---- 多连接操作 ---- */
  /* 关掉弹窗：不保留未保存的改动（表单值留给下一次打开时重填），
     所以顺带把 dirty 清掉，免得再次打开时空留着「有未保存的修改」。 */
  const closeForm = () => {
    setFormOpen(false);
    setDirty(false);
    setTestResult(null);
    setDiagnostics(null);
  };

  const selectProfile = (p: ConnectionProfile) => {
    setEditingId(p.id);
    setForm({
      name: p.name ?? '',
      host: p.host ?? '',
      port: p.port ?? 8006,
      token_id: p.token_id ?? '',
      token_secret: '',
      console_user: p.console_user ?? '',
      console_password: '',
      verify_ssl: p.verify_ssl ?? false,
      node_default: p.node_default ?? '',
    });
    setSecretAlreadySet(Boolean(p.token_secret_set));
    setConsolePasswordSet(Boolean(p.console_password_set));
    setDirty(false);
    setTestResult(null);
    setDiagnostics(null);
    setFormOpen(true);
  };

  const startNew = () => {
    setEditingId(null);
    setForm({
      name: '',
      host: '',
      port: 8006,
      token_id: '',
      token_secret: '',
      console_user: '',
      console_password: '',
      // 新建连接默认校验证书（PVE_VERIFY_SSL，生产默认开启）
      verify_ssl: configQuery.data?.verify_ssl_default ?? false,
      node_default: '',
    });
    setSecretAlreadySet(false);
    setConsolePasswordSet(false);
    setDirty(false);
    setTestResult(null);
    setDiagnostics(null);
    /* 标记「已初始化」：连接列表可能还在加载，等它回来时那次「自动填入
       第一条连接」不能把用户正要填的新表单冲掉（?new=1 直接进来就是这个
       时序：先进页面拿到空列表，随后数据才到）。 */
    setInitialized(true);
    setFormOpen(true);
  };

  /* /nodes/connections?new=1：直接摊开「新增连接」表单。
     读完立刻抹掉参数，否则用户关掉再刷新又会被弹一次。 */
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    if (isAdmin) startNew();
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
    // startNew 只调 setState，不进依赖以免每次渲染都重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams, isAdmin]);

  const removeProfile = async (p: ConnectionProfile) => {
    try {
      await connectionsApi.remove(p.id);
      toast.success(t('conn.deleted'), p.name || p.host);
      setInitialized(false);
      void queryClient.invalidateQueries();
    } catch (err) {
      toast.error(t('conn.deleteFailed'), errorMessage(err));
    }
  };

  /* ---- 一键修复令牌权限 ---- */
  /* 令牌若在 PVE 中勾选了「特权分离」，它的有效权限为空：PVE 会隐藏节点
     CPU / 内存 / 磁盘指标，面板看起来就像「读不到节点信息」。此操作借用该
     连接里已保存的 PVE 账号密码，给令牌在 / 上授予 PVEAdmin。 */
  const repairProfile = async (p: ConnectionProfile) => {
    setRepairingId(p.id);
    try {
      const result = await connectionsApi.repair(p.id);
      toast.success(
        t('conn.repairOk'),
        t('conn.repairOkDetail', {
          token: result.token_id,
          n: result.effective_privileges.length,
        }),
      );
      if (!result.node_metrics) {
        toast.warning(t('conn.metricsMissing'), t('conn.metricsMissingDetail'));
      }
      void queryClient.invalidateQueries();
    } catch (err) {
      toast.error(t('conn.repairFailed'), errorMessage(err));
    } finally {
      setRepairingId(null);
    }
  };

  /* ---- 保存 ---- */
  /* editingId 有值 = 更新该连接；为 null = 新增一条（不再覆盖已有连接） */
  const save = async () => {
    if (!validate()) {
      toast.error(t('conn.fixFormErrors'));
      return;
    }
    setSaving(true);
    try {
      // token_secret / console_password 为空时不发送，后端据「字段缺失」保留原值。
      const payload: ConnectionConfigInput = {
        name: (form.name ?? '').trim() || form.host.trim(),
        host: form.host.trim(),
        port: Number(form.port),
        token_id: form.token_id.trim(),
        verify_ssl: form.verify_ssl,
        node_default: form.node_default.trim(),
      };
      const secret = (form.token_secret ?? '').trim();
      if (secret) payload.token_secret = secret;
      const consoleUser = (form.console_user ?? '').trim();
      if (consoleUser) payload.console_user = consoleUser;
      const consolePassword = (form.console_password ?? '').trim();
      if (consolePassword) payload.console_password = consolePassword;

      const saved = editingId
        ? await connectionsApi.update(editingId, payload)
        : await connectionsApi.create(payload);

      setEditingId(saved.id);
      setInitialized(true);
      toast.success(
        editingId ? t('conn.updated') : t('conn.created'),
        t('conn.savedHint'),
      );
      setDirty(false);
      setForm((prev) => ({
        ...prev,
        token_secret: '',
        console_password: '',
      }));
      /* 保存成功就收起弹窗：内容是「填完即走」的一次性动作，
         留在弹窗里继续点「保存配置」只会让人怀疑到底存没存。 */
      setFormOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      void queryClient.invalidateQueries({ queryKey: ['health'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster'] });
    } catch (err) {
      toast.error(t('conn.saveFailed'), errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const configured = configQuery.data?.configured ?? false;

  /* 自检结果统计：正常 / 提醒 / 异常 */
  const diagCounts = useMemo(() => {
    const list = diagnostics?.checks ?? [];
    return {
      ok: list.filter((c) => c.status === 'ok').length,
      warn: list.filter((c) => c.status === 'warn').length,
      fail: list.filter((c) => c.status === 'fail').length,
    };
  }, [diagnostics]);

  return (
    <>
      <Card>
        <CardHeader
          title={t('conn.title')}
        subtitle={t('conn.subtitle')}
        icon={<IconPlug size={17} />}
        actions={
          <>
            <Badge variant={configured ? 'success' : 'warning'} dot size="sm">
              {configured ? t('conn.configured') : t('conn.notConfigured')}
            </Badge>
            <Button
              variant="secondary"
              size="sm"
              icon={<IconPlus size={14} />}
              disabled={!isAdmin}
              onClick={startNew}
            >
              {t('conn.add')}
            </Button>
          </>
        }
      />

      {!isAdmin ? (
        <Notice tone="info" title={t('conn.readonlyTitle')}>
          {t('conn.readonlyBody')}
        </Notice>
      ) : null}

      {/* ---- 已保存的连接：卡片网格 ---- */}
      {connections.length > 0 ? (
        <div className="set-conn-grid">
          {connections.map((c) => {
            const connStatus = statusById.get(c.id);
            const nodes = nodesByConnection.get(c.id) ?? [];
            const expanded = expandedNodes.has(c.id);
            const state = connStatus ? (connStatus.ok ? 'ok' : 'down') : 'unknown';
            const repairing = repairingId === c.id;
            return (
              <div key={c.id} className={`set-conn-card is-${state}`}>
                <div className="set-conn-top">
                  <span className="set-conn-icon" aria-hidden="true">
                    <IconServer size={17} />
                  </span>
                  <div className="set-conn-id">
                    <span className="set-conn-name" title={c.name || c.host}>
                      {c.name || c.host}
                    </span>
                    <span className="set-conn-addr mono">
                      {c.host}:{c.port}
                    </span>
                  </div>
                  {/* 状态来自逐条探测：连得上 / 连不上（带原因） */}
                  {connStatus ? (
                    connStatus.ok ? (
                      <Badge variant="success" size="sm" dot>
                        {t('conn.connected')}
                      </Badge>
                    ) : (
                      <Badge
                        variant="danger"
                        size="sm"
                        dot
                        title={connStatus.error || t('conn.cannotConnect')}
                      >
                        {t('conn.disconnected')}
                      </Badge>
                    )
                  ) : statusQuery.isLoading ? (
                    <Badge variant="neutral" size="sm">
                      {t('conn.checking')}
                    </Badge>
                  ) : null}
                  {/* 默认读取：不是「主连接」，只是单台读取接口（健康探活、
                      集群节点状态）的目标，在「设置 → 系统信息」里可换 */}
                  {c.active ? (
                    <Badge
                      variant="accent"
                      size="sm"
                      title={t('conn.defaultReadTitle')}
                    >
                      {t('conn.defaultRead')}
                    </Badge>
                  ) : null}
                </div>

                <div className="set-conn-tags">
                  {/* 节点数 + 可展开的名字：节点一多时收成一行「N 个节点」，
                      展开才铺芯片，列表不会被几十个节点名撑成一面墙 */}
                  <button
                    type="button"
                    className={`conn-node-toggle${expanded ? ' is-open' : ''}`}
                    onClick={() => toggleNodes(c.id)}
                    aria-expanded={expanded}
                    title={
                      nodes.length ? t('conn.toggleNodes') : t('conn.noNodesTitle')
                    }
                  >
                    <IconLayers size={12} />
                    {t('conn.nodeCount', { n: nodes.length })}
                    {nodes.length > 0 ? (
                      <IconChevronDown size={12} className="conn-node-caret" />
                    ) : null}
                  </button>
                  <span
                    className="set-conn-tag"
                    title={c.token_id || t('conn.noToken')}
                  >
                    <IconKey size={12} />
                    {c.token_id || t('conn.noToken')}
                  </span>
                  <span className="set-conn-tag">
                    <IconConsole size={12} />
                    {c.console_user || t('conn.noConsoleCreds')}
                  </span>
                </div>

                {expanded ? (
                  nodes.length > 0 ? (
                    <div className="conn-nodes">
                      {nodes.map((n) => (
                        <span className="conn-node-chip" key={n}>
                          {n}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="conn-nodes-empty">{t('conn.noNodesHint')}</div>
                  )
                ) : null}

                <div className="set-conn-actions">
                  <div className="set-conn-actions-main">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => selectProfile(c)}
                    >
                      {t('common.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconShield size={14} />}
                      disabled={!isAdmin || repairing}
                      loading={repairing}
                      onClick={() => void repairProfile(c)}
                      title={t('conn.repairTitle')}
                    >
                      修复权限
                    </Button>
                  </div>
                  <IconButton
                    label={t('conn.deleteAria', { name: c.name || c.host })}
                    variant="danger"
                    disabled={!isAdmin}
                    onClick={() => void removeProfile(c)}
                  >
                    <IconTrash size={15} />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title={t('conn.empty')}
          description={t('conn.emptyDesc')}
          action={
            isAdmin ? (
              <Button variant="primary" icon={<IconPlus size={15} />} onClick={startNew}>
                {t('conn.add')}
              </Button>
            ) : undefined
          }
        />
      )}

      {configQuery.isError && isNotImplemented(configQuery.error) ? (
        <ErrorState
          notImplemented
          title={t('conn.notImplTitle')}
          message={t('conn.notImplMsg')}
          onRetry={() => void configQuery.refetch()}
        />
      ) : null}
    </Card>

    {/* ---- 新增 / 编辑连接：弹窗 ----
       原来是常驻在卡片下方的一张长表单：一次就填几个字段的低频动作，
       却把「已连接列表」顶到屏幕外，页面上永远是半屏表单 + 半屏列表。
       改成弹窗后，这一页的常态只剩「连接卡片」，点「新增 / 编辑」才进表单。 */}
    <Modal
      open={formOpen}
      onClose={closeForm}
      title={editingId ? t('conn.editTitle') : t('conn.addTitle')}
      description={editingId ? t('conn.editDesc') : t('conn.addDesc')}
      size="lg"
      footer={
        <div className="wizard-footer">
          <span className="wizard-footer-step">
            {dirty ? t('conn.unsaved') : t('conn.credsHint')}
          </span>
          <div className="wizard-footer-actions">
            {isAdmin ? (
              <>
                <Button
                  variant="secondary"
                  icon={<IconPlug size={15} />}
                  onClick={() => void testConnection()}
                  loading={testing}
                >
                  {t('conn.test')}
                </Button>
                <Button
                  variant="secondary"
                  icon={<IconShield size={15} />}
                  onClick={() => void runDiagnostics()}
                  loading={diagnosing}
                  disabled={!configured || dirty}
                  title={dirty ? t('conn.diagBeforeSave') : t('conn.diagHint')}
                >
                  {t('conn.diagnostics')}
                </Button>
                <Button
                  variant="primary"
                  icon={<IconSave size={15} />}
                  onClick={() => void save()}
                  loading={saving}
                  disabled={!dirty}
                >
                  {t('conn.save')}
                </Button>
              </>
            ) : (
              <Button variant="secondary" onClick={closeForm}>
                {t('common.close')}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="dyn-list">
        <div className="dyn-row">
              <Field
                label={t('conn.fieldName')}
                hint={t('conn.fieldNameHint')}
              >
                <Input
                  value={form.name ?? ''}
                  onChange={(e) => patch('name', e.target.value)}
                  placeholder={t('conn.namePlaceholder')}
                  disabled={!isAdmin}
                  autoComplete="off"
                />
              </Field>
              <Field
                label={t('conn.fieldHost')}
                required
                error={errors.host}
                hint={t('conn.fieldHostHint')}
              >
                <Input
                  value={form.host}
                  onChange={(e) => patch('host', e.target.value)}
                  placeholder={t('conn.hostPlaceholder')}
                  disabled={!isAdmin}
                  className="mono"
                  autoComplete="off"
                />
              </Field>

              <Field
                label={t('conn.fieldPort')}
                required
                error={errors.port}
                hint={t('conn.fieldPortHint')}
              >
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={String(form.port)}
                  onChange={(e) => patch('port', Number(e.target.value))}
                  disabled={!isAdmin}
                  className="mono"
                />
              </Field>
            </div>

            <div className="dyn-row">
            <Field
              label={t('conn.fieldTokenId')}
              required
              error={errors.token_id}
              hint={t('conn.fieldTokenIdHint')}
            >
              <Input
                value={form.token_id}
                onChange={(e) => patch('token_id', e.target.value)}
                placeholder="root@pam!panel"
                disabled={!isAdmin}
                className="mono"
                autoComplete="off"
              />
            </Field>

            <Field
              label={t('conn.fieldTokenSecret')}
              required
              error={errors.token_secret}
              hint={
                configured ? t('conn.secretHintConfigured') : t('conn.secretHintNew')
              }
            >
              <Input
                type={showSecret ? 'text' : 'password'}
                value={form.token_secret}
                onChange={(e) => patch('token_secret', e.target.value)}
                placeholder={
                  configured
                    ? t('conn.secretPlaceholderConfigured')
                    : t('conn.secretPlaceholder')
                }
                disabled={!isAdmin}
                className="mono"
                autoComplete="new-password"
                suffix={
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={showSecret ? <IconEyeOff size={15} /> : <IconEye size={15} />}
                    onClick={() => setShowSecret((v) => !v)}
                    aria-label={showSecret ? t('conn.hideSecret') : t('conn.showSecret')}
                  />
                }
              />
            </Field>
            </div>

            <div className="set-form-block-head">
              <span className="set-form-block-icon">
                <IconActivity size={15} />
              </span>
              <span className="set-form-block-title">{t('conn.optionsBlock')}</span>
              <span className="set-form-block-hint">{t('conn.optionsBlockHint')}</span>
            </div>

            <div className="dyn-row">
              <Switch
                checked={form.verify_ssl}
                onChange={(v) => patch('verify_ssl', v)}
                label={t('conn.verifySsl')}
                hint={t('conn.verifySslHint')}
                disabled={!isAdmin}
              />
            </div>

            <div className="set-form-block-head">
              <span className="set-form-block-icon">
                <IconKey size={15} />
              </span>
              <span className="set-form-block-title">{t('conn.consoleBlock')}</span>
              <span className="set-form-block-hint">
                {t('conn.consoleBlockHint')}
              </span>
            </div>

            <Notice tone="info">{t('conn.consoleNotice')}</Notice>

            <div className="dyn-row">
              <Field
                label={t('conn.fieldConsoleUser')}
                error={errors.console_user}
                hint={t('conn.fieldConsoleUserHint')}
              >
                <Input
                  value={form.console_user}
                  onChange={(e) => patch('console_user', e.target.value)}
                  placeholder="proxmox-console@pve"
                  disabled={!isAdmin}
                  className="mono"
                  autoComplete="off"
                />
              </Field>

              <Field
                label={t('conn.fieldConsolePassword')}
                error={errors.console_password}
                hint={
                  consolePasswordSet
                    ? t('conn.consolePwSet')
                    : t('conn.consolePwHint')
                }
              >
                <Input
                  type={showConsolePassword ? 'text' : 'password'}
                  value={form.console_password}
                  onChange={(e) => patch('console_password', e.target.value)}
                  placeholder={
                    consolePasswordSet
                      ? t('conn.consolePwPlaceholderSet')
                      : t('conn.consolePwPlaceholder')
                  }
                  disabled={!isAdmin}
                  className="mono"
                  autoComplete="new-password"
                  suffix={
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={
                        showConsolePassword ? (
                          <IconEyeOff size={15} />
                        ) : (
                          <IconEye size={15} />
                        )
                      }
                      onClick={() => setShowConsolePassword((v) => !v)}
                      aria-label={
                        showConsolePassword
                          ? t('conn.hidePassword')
                          : t('conn.showPassword')
                      }
                    />
                  }
                />
              </Field>
            </div>

          {/* 测试结果 */}
          {testResult ? (
            <Notice
              tone={testResult.ok ? 'success' : 'danger'}
              title={testResult.ok ? t('conn.testPassed') : t('conn.testFailedTitle')}
              icon={testResult.ok ? <IconCheck size={16} /> : <IconClose size={16} />}
            >
              {testResult.ok ? (
                <div className="desc-list">
                  <div className="desc-item">
                    <div className="desc-label">{t('conn.version')}</div>
                    <div className="desc-value mono">
                      {testResult.version || t('conn.unknown')}{' '}
                      {testResult.release ? `(${testResult.release})` : ''}
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('conn.visibleNodes')}</div>
                    <div className="desc-value">
                      {testResult.nodes.length > 0 ? (
                        <>
                          {/* 集群一多，把节点名用「、」拼成一段文本就既看不出
                              总数、也找不到某个名字。改成计数 + 芯片列表，
                              高度封顶后滚动 —— 十几个节点也不会把页面顶开。

                              注意这里拿到的是对象（name/status/type），不是
                              字符串：早先按字符串渲染，直接抛 React #31。
                              status 挂到 title 上，不额外加样式。 */}
                          <span className="fs-sm text-muted">
                            {t('conn.nodeCountShort', { n: testResult.nodes.length })}
                          </span>
                          <div className="conn-nodes">
                            {testResult.nodes.map((node, index) => (
                              <span
                                className="conn-node-chip"
                                key={node.name ?? index}
                                title={
                                  node.status
                                    ? t('conn.statusTitle', { status: node.status })
                                    : undefined
                                }
                              >
                                {node.name ?? t('conn.unnamed')}
                              </span>
                            ))}
                          </div>
                        </>
                      ) : (
                        t('conn.noVisibleNodes')
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                testResult.message || t('conn.rejectedHint')
              )}
            </Notice>
          ) : null}

          {/* 环境自检报告 */}
          {diagnostics ? (
            <div className="mt-16">
              <div className="set-form-block-head">
                <span className="set-form-block-icon">
                  <IconShield size={15} />
                </span>
                <span className="set-form-block-title">{t('conn.diagBlock')}</span>
                <span className="set-form-block-hint">{t('conn.diagBlockHint')}</span>
              </div>

              {/* 结论摘要 */}
              <div className="set-diag-summary">
                <Badge
                  variant={
                    diagnostics.status === 'fail'
                      ? 'danger'
                      : diagnostics.status === 'warn'
                        ? 'warning'
                        : 'success'
                  }
                  dot
                  pulse={diagnostics.status === 'ok'}
                >
                  {diagnostics.status === 'fail'
                    ? t('conn.diagFail')
                    : diagnostics.status === 'warn'
                      ? t('conn.diagWarnStatus')
                      : t('conn.diagAllOk')}
                </Badge>

                <div className="set-diag-counts">
                  <span className="set-diag-count is-ok">
                    {t('conn.diagCountOk', { n: diagCounts.ok })}
                  </span>
                  <span className="set-diag-count is-warn">
                    {t('conn.diagCountWarn', { n: diagCounts.warn })}
                  </span>
                  <span className="set-diag-count is-fail">
                    {t('conn.diagCountFail', { n: diagCounts.fail })}
                  </span>
                </div>

                <div className="set-diag-context">
                  <span className="mono fs-sm">{diagnostics.host || '—'}</span>
                  {diagnostics.pve_version ? (
                    <span className="fs-xs text-muted">
                      Proxmox VE {diagnostics.pve_version}
                    </span>
                  ) : null}
                  <span className="fs-xs text-muted">
                    {t('conn.diagTokenInfo', {
                      token: diagnostics.token_id || '—',
                      n: diagnostics.effective_privileges.length,
                    })}
                  </span>
                </div>
              </div>

              <div className="set-diag-grid">
                {diagnostics.checks.map((c) => (
                  <div key={c.key} className={`set-diag-item is-${c.status}`}>
                    <Badge
                      variant={
                        c.status === 'ok'
                          ? 'success'
                          : c.status === 'warn'
                            ? 'warning'
                            : 'danger'
                      }
                      size="sm"
                    >
                      {c.status === 'ok'
                        ? t('conn.diagOkLabel')
                        : c.status === 'warn'
                          ? t('conn.diagWarnLabel')
                          : t('conn.diagFailLabel')}
                    </Badge>
                    <div className="diag-body">
                      <div className="fw-500 fs-sm">{c.label}</div>
                      <div className="fs-sm text-muted">{c.detail}</div>
                      {c.hint ? (
                        <div className="fs-xs text-muted">{c.hint}</div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>

              {diagnostics.remediation.length > 0 ? (
                <Notice tone="info" title={t('conn.remediation')}>
                  <ol style={{ paddingLeft: 18, margin: 0 }}>
                    {diagnostics.remediation.map((r, i) => (
                      <li key={i} className="fs-sm mono">
                        {r}
                      </li>
                    ))}
                  </ol>
                </Notice>
              ) : null}

              {diagnostics.effective_privileges.length > 0 ? (
                <CollapsibleCard
                  title={t('conn.privilegesTitle', {
                    n: diagnostics.effective_privileges.length,
                  })}
                  icon={<IconShield size={15} />}
                >
                  <div className="fs-xs mono text-muted wrap-anywhere">
                    {diagnostics.effective_privileges.join('　')}
                  </div>
                </CollapsibleCard>
              ) : null}
            </div>
          ) : null}

          <CollapsibleCard
            title={t('conn.howtoTitle')}
            icon={<IconKey size={15} />}
          >
            <ol className="desc-list" style={{ paddingLeft: 18 }}>
              <li className="desc-item">
                <div className="desc-label">{t('conn.step', { n: 1 })}</div>
                <div className="desc-value">
                  {t('conn.howto1Pre')}
                  <span className="mono">root@pam</span>
                  {t('conn.howto1Post')}
                </div>
              </li>
              <li className="desc-item">
                <div className="desc-label">{t('conn.step', { n: 2 })}</div>
                <div className="desc-value">
                  {t('conn.howto2Pre')}
                  <span className="mono">panel</span>
                  {t('conn.howto2Mid')}
                  <strong>{t('conn.howto2Strong')}</strong>
                  {t('conn.howto2Post')}
                </div>
              </li>
              <li className="desc-item">
                <div className="desc-label">{t('conn.step', { n: 3 })}</div>
                <div className="desc-value">{t('conn.howto3')}</div>
              </li>
              <li className="desc-item">
                <div className="desc-label">{t('conn.step', { n: 4 })}</div>
                <div className="desc-value">
                  {t('conn.howto4Pre')}
                  <span className="mono">PVEAdmin</span>
                  {t('conn.howto4Mid')}
                  <span className="mono">/</span>
                  {t('conn.howto4Post')}
                </div>
              </li>
              <li className="desc-item">
                <div className="desc-label">{t('conn.step', { n: 5 })}</div>
                <div className="desc-value">
                  {t('conn.howto5Pre')}
                  <span className="mono">user@realm!token</span>
                  {t('conn.howto5Mid')}
                </div>
              </li>
            </ol>
          </CollapsibleCard>
        </div>
      </Modal>
    </>
  );
}
