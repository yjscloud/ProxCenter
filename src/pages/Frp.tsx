/* ==========================================================================
   ProxCenter — 内网穿透（frp 客户端）
   --------------------------------------------------------------------------
   按职责拆成两块：
   - 服务端：frps 地址 / token / 启停 / 安装 —— 仅 admin 可写（settings.manage）
   - 规则：每条带 username 归属 —— frp.manage 用户能增删改自己的规则，
     普通用户看不到别人的规则
   运行时 server + 全部规则合并渲染成 frpc.toml（见后端 effective_config）
   ========================================================================== */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { frpApi } from "../api/endpoints";
import { errorMessage } from "../api/client";
import { PageShell } from "../components/Layout";
import { Card, CardHeader } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button, IconButton } from "../components/ui/Button";
import { Notice } from "../components/ui/EmptyState";
import { Input, Switch } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import {
  IconNetwork,
  IconPlay,
  IconStop,
  IconPlus,
  IconTrash,
  IconRefresh,
  IconDownload,
  IconServer,
  IconCheck,
} from "../components/Icons";
import type { FrpRule, FrpRuleInput } from "../api/types";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { useT } from "../i18n";

export function Frp() {
  const t = useT();
  return (
    <PageShell
      title={
        <>
          <IconNetwork size={20} />
          {t('frp.title')}
        </>
      }
      subtitle={t('frp.subtitle')}
      actions={<HeaderActions />}
    >
      <StatusRow />

      <div className="grid grid-2">
        <ServerCard />
        <ProcessCard />
      </div>

      <RulesCard />
      <LogCard />
    </PageShell>
  );
}

/* ---------------------------------------------------------------------------
   顶部右侧动作：手动启停 frpc
   --------------------------------------------------------------------------- */
function HeaderActions() {
  const t = useT();
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["frp", "status"],
    queryFn: frpApi.status,
    refetchInterval: 5000,
  });
  const running = statusQuery.data?.running ?? false;
  const canManage = hasPermission("settings.manage");

  return (
    <Button
      variant={running ? "danger" : "primary"}
      icon={running ? <IconStop size={15} /> : <IconPlay size={15} />}
      loading={busy}
      disabled={!canManage || statusQuery.isLoading}
      onClick={async () => {
        if (!canManage) {
          toast.error(t('frp.noPermission'), t('frp.noPermissionDetail'));
          return;
        }
        setBusy(true);
        try {
          if (running) {
            await frpApi.server.stop();
            toast.success(t('frp.stopped'), t('frp.stoppedDetail'));
          } else {
            await frpApi.server.start();
            toast.success(t('frp.started'));
          }
          void qc.invalidateQueries({ queryKey: ["frp"] });
        } catch (err) {
          toast.error(t('common.opFailed'), errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {running ? t('frp.stopTunnel') : t('frp.startTunnel')}
    </Button>
  );
}

/* ---------------------------------------------------------------------------
   状态行：运行状态 / frpc 二进制 / 规则数
   --------------------------------------------------------------------------- */
function StatusRow() {
  const t = useT();
  const statusQuery = useQuery({
    queryKey: ["frp", "status"],
    queryFn: frpApi.status,
    refetchInterval: 5000,
  });
  const rulesQuery = useQuery({
    queryKey: ["frp", "rules"],
    queryFn: frpApi.rules.list,
    refetchInterval: 8000,
  });
  const serverQuery = useQuery({
    queryKey: ["frp", "server"],
    queryFn: frpApi.server.get,
    refetchInterval: 30_000,
  });

  const running = statusQuery.data?.running ?? false;
  const available = statusQuery.data?.available ?? false;
  const ruleCount = rulesQuery.data?.rules.length ?? 0;
  const serverAddr = serverQuery.data?.server_addr || t('frp.notConfigured');
  const serverPort = serverQuery.data?.server_port ?? 7000;
  const tokenSet = serverQuery.data?.token_set ?? false;

  return (
    <Card collapsible={false}>
      <CardHeader title={t('frp.statusTitle')} icon={<IconNetwork size={16} />} />
      <div className="grid grid-4">
        <Stat label={t('frp.statProcess')}>
          <Badge variant={running ? "success" : "neutral"} dot pulse={running} size="sm">
            {running ? t('frp.running') : t('frp.stoppedState')}
          </Badge>
        </Stat>
        <Stat label={t('frp.statClient')}>
          <Badge variant={available ? "success" : "warning"} size="sm">
            {available ? t('frp.installed') : t('frp.notInstalled')}
          </Badge>
        </Stat>
        <Stat label={t('frp.statServer')}>
          {serverAddr ? (
            <span className="mono fs-sm">
              {serverAddr}:{serverPort}
              {tokenSet ? <span className="text-success"> · token</span> : null}
            </span>
          ) : (
            <span className="text-warning fs-sm">{t('frp.notConfigured')}</span>
          )}
        </Stat>
        <Stat label={t('frp.statRules')}>
          <span className="mono">{t('frp.ruleCount', { n: ruleCount })}</span>
        </Stat>
      </div>
    </Card>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <span className="fs-xs text-muted">{label}</span>
      <div>{children}</div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   服务端配置（admin 可写，其他人只读）
   --------------------------------------------------------------------------- */
const EMPTY_SERVER = { server_addr: "", server_port: 7000, token: "" };

function ServerCard() {
  const t = useT();
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canManage = hasPermission("settings.manage");

  const serverQuery = useQuery({
    queryKey: ["frp", "server"],
    queryFn: frpApi.server.get,
    refetchInterval: 30_000,
  });

  const [draft, setDraft] = useState<typeof EMPTY_SERVER | null>(null);
  const [busy, setBusy] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");

  useEffect(() => {
    if (serverQuery.data && draft === null) {
      setDraft({
        server_addr: serverQuery.data.server_addr,
        server_port: serverQuery.data.server_port,
        token: "",
      });
    }
  }, [serverQuery.data, draft]);

  const dirty =
    draft !== null &&
    serverQuery.data !== undefined &&
    (draft.server_addr !== serverQuery.data.server_addr ||
      draft.server_port !== serverQuery.data.server_port ||
      Boolean(tokenDraft));

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const payload: {
        server_addr: string;
        server_port: number;
        token?: string;
        token_clear?: boolean;
      } = {
        server_addr: draft.server_addr,
        server_port: draft.server_port,
      };
      if (tokenDraft) {
        payload.token = tokenDraft;
      } else if (serverQuery.data?.token_set === false) {
        // 从未设置过但还是空字符串 —— 不主动发 token_clear
      }
      const result = await frpApi.server.save(payload);
      if (result.restart_error) {
        toast.warning(
          t('frp.savedTitle'),
          t('frp.savedRestartFailedDetail', { error: result.restart_error }),
        );
      } else if (result.restarted) {
        toast.success(t('frp.savedRestarted'));
      } else {
        toast.success(t('frp.saved'));
      }
      setTokenDraft("");
      void qc.invalidateQueries({ queryKey: ["frp"] });
    } catch (err) {
      toast.error(t('frp.saveFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearToken() {
    if (!draft) return;
    setBusy(true);
    try {
      await frpApi.server.save({
        server_addr: draft.server_addr,
        server_port: draft.server_port,
        token_clear: true,
      });
      toast.success(t('frp.tokenCleared'));
      void qc.invalidateQueries({ queryKey: ["frp"] });
    } catch (err) {
      toast.error(t('frp.clearFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card collapsible={false}>
      <CardHeader
        title={t('frp.serverTitle')}
        icon={<IconServer size={16} />}
        subtitle={
          canManage ? t('frp.serverSubtitleAdmin') : t('frp.serverSubtitleUser')
        }
        actions={
          canManage ? (
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!dirty}
              onClick={() => void save()}
            >
              {t('frp.saveChanges')}
            </Button>
          ) : null
        }
      />
      {draft ? (
        <div className="flex flex-col gap-12">
          <Field label={t('frp.fieldServerAddr')}>
            <input
              className="input"
              value={draft.server_addr}
              placeholder={t('frp.serverAddrPlaceholder')}
              disabled={!canManage}
              onChange={(e) => setDraft({ ...draft, server_addr: e.target.value })}
            />
          </Field>
          <Field label={t('frp.fieldServerPort')}>
            <input
              className="input"
              type="number"
              value={draft.server_port}
              disabled={!canManage}
              onChange={(e) =>
                setDraft({ ...draft, server_port: Number(e.target.value) })
              }
            />
          </Field>
          <Field
            label={t('frp.fieldToken')}
            hint={
              serverQuery.data?.token_set
                ? t('frp.tokenHintSet')
                : t('frp.tokenHintUnset')
            }
          >
            <div className="flex gap-8">
              <input
                className="input"
                type="password"
                value={tokenDraft}
                placeholder={serverQuery.data?.token_set ? t('frp.tokenPlaceholder') : ""}
                disabled={!canManage}
                onChange={(e) => setTokenDraft(e.target.value)}
              />
              {canManage && serverQuery.data?.token_set ? (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busy}
                  onClick={() => void clearToken()}
                >
                  {t('frp.clear')}
                </Button>
              ) : null}
            </div>
          </Field>
          {canManage ? (
            <p className="fs-xs text-muted">
              {t('frp.restartNote')}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="skeleton skeleton-text" />
      )}
    </Card>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
      {hint ? <span className="field-message">{hint}</span> : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   进程控制：安装 frpc 二进制（admin only）
   --------------------------------------------------------------------------- */
function ProcessCard() {
  const t = useT();
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canManage = hasPermission("settings.manage");

  const statusQuery = useQuery({
    queryKey: ["frp", "status"],
    queryFn: frpApi.status,
    refetchInterval: 5000,
  });
  const available = statusQuery.data?.available ?? false;

  const [busy, setBusy] = useState(false);

  return (
    <Card collapsible={false}>
      <CardHeader title={t('frp.clientTitle')} icon={<IconNetwork size={16} />} />
      <div className="flex flex-col gap-12">
        <div className="flex items-center justify-between">
          <span className="fs-sm text-secondary">{t('frp.installPath')}</span>
          <span className="mono fs-xs text-secondary" title={statusQuery.data?.binary}>
            {statusQuery.data?.binary || t('frp.notInstalled')}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="fs-sm text-secondary">{t('frp.clientVersion')}</span>
          <span className="mono fs-sm">{available ? t('frp.ready') : t('frp.missing')}</span>
        </div>
        {!available ? (
          <Notice tone="warning" title={t('frp.notInstalledTitle')}>
            {t('frp.notInstalledBody')}
          </Notice>
        ) : null}
        {canManage && !available ? (
          <Button
            variant="primary"
            icon={<IconDownload size={14} />}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await frpApi.server.install();
                toast.success(t('frp.installDone'), res.binary);
                void qc.invalidateQueries({ queryKey: ["frp"] });
              } catch (err) {
                toast.error(t('frp.installFailed'), errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('frp.installBtn')}
          </Button>
        ) : null}
        {canManage ? (
          <div className="flex items-center justify-between gap-16">
            <div className="flex flex-col gap-2">
              <span className="fs-sm">{t('frp.autoRestartLabel')}</span>
              <span className="fs-xs text-muted">
                {t('frp.autoRestartHint')}
              </span>
            </div>
            <Switch
              checked={statusQuery.data?.auto_restart ?? false}
              disabled={busy || statusQuery.isLoading || !available}
              ariaLabel={t('frp.autoRestartAria')}
              onChange={async (next) => {
                setBusy(true);
                try {
                  const res = await frpApi.server.autoRestart(next);
                  if (res.start_error) {
                    toast.warning(
                      t('frp.autoRestartOn'),
                      t('frp.autoRestartStartFailed', { error: res.start_error }),
                    );
                  } else if (res.started) {
                    toast.success(t('frp.autoRestartOn'), t('frp.autoRestartStarted'));
                  } else {
                    toast.success(
                      next ? t('frp.autoRestartOn') : t('frp.autoRestartOff'),
                      next ? t('frp.autoRestartOnDetail') : undefined,
                    );
                  }
                  void qc.invalidateQueries({ queryKey: ["frp"] });
                } catch (err) {
                  toast.error(t('common.opFailed'), errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            />
          </div>
        ) : null}
        {canManage ? (
          <p className="fs-xs text-muted">
            {t('frp.installNextStep')}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   规则列表（按用户归属过滤）
   --------------------------------------------------------------------------- */
const EMPTY_RULE: FrpRuleInput = {
  name: "tunnel",
  type: "tcp",
  local_ip: "127.0.0.1",
  local_port: 8080,
  remote_port: 16080,
};

function RulesCard() {
  const t = useT();
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canManage = hasPermission("frp.manage");
  /** 新建规则走弹窗，填完再保存 —— 避免先落库一条空规则再反复重启 frpc */
  const [creating, setCreating] = useState(false);

  const listQuery = useQuery({
    queryKey: ["frp", "rules"],
    queryFn: frpApi.rules.list,
    refetchInterval: 8000,
  });
  const effectiveQuery = useQuery({
    queryKey: ["frp", "effective"],
    queryFn: frpApi.effective,
    refetchInterval: 8000,
  });

  const rules = listQuery.data?.rules ?? [];
  const isAdmin = listQuery.data?.is_admin ?? false;
  const ownUsername = listQuery.data?.own_username ?? "";

  /* 当前生效（合并后）规则名集合 —— 用于标记「已生效 / 未生效」 */
  const effectiveNames = useMemo(() => {
    const set = new Set<string>();
    for (const r of effectiveQuery.data?.config.proxies ?? []) set.add(r.name);
    return set;
  }, [effectiveQuery.data]);

  const dupNames = useMemo(() => {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const r of rules) {
      const key = r.username + ":" + r.name;
      if (seen.has(key)) dups.add(r.name);
      else seen.add(key);
    }
    return [...dups];
  }, [rules]);

  async function create(payload: FrpRuleInput) {
    await frpApi.rules.create(payload);
  }

  async function update(id: string, payload: Partial<FrpRuleInput>) {
    await frpApi.rules.update(id, payload);
  }

  async function remove(id: string) {
    await frpApi.rules.remove(id);
  }

  function nextName(): string {
    const used = new Set(rules.map((r) => r.name));
    for (let i = 1; i <= 999; i += 1) {
      const candidate = `tunnel-${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return `tunnel-${Date.now()}`;
  }

  return (
    <Card>
      <CardHeader
        title={t('frp.rulesTitle')}
        icon={<IconNetwork size={16} />}
        subtitle={
          isAdmin
            ? t('frp.rulesSubtitleAdmin')
            : t('frp.rulesSubtitleUser', { user: ownUsername || t('frp.currentUser') })
        }
        actions={
          canManage ? (
            <Button
              variant="primary"
              size="sm"
              icon={<IconPlus size={14} />}
              onClick={() => setCreating(true)}
            >
              {t('frp.newRule')}
            </Button>
          ) : null
        }
      />

      {dupNames.length > 0 ? (
        <Notice tone="danger" title={t('frp.dupTitle')}>
          {t('frp.dupBody', { names: dupNames.join(t('incident.evidenceSeparator')) })}
        </Notice>
      ) : null}

      {rules.length === 0 ? (
        <p className="text-secondary fs-sm">{t('frp.noRules')}</p>
      ) : (
        <div className="table-container">
          <table className="table table-dense">
            <thead>
              <tr>
                <th>{t('frp.colOwner')}</th>
                <th>{t('frp.colName')}</th>
                <th>{t('frp.colLocalIp')}</th>
                <th>{t('frp.colLocalPort')}</th>
                <th>{t('frp.colRemotePort')}</th>
                <th>{t('common.status')}</th>
                <th style={{ width: 96 }} />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <RuleRow
                  key={r.id}
                  rule={r}
                  canManageRow={canManage && (isAdmin || r.username === ownUsername)}
                  isEffective={effectiveNames.has(r.name)}
                  onUpdate={async (patch) => {
                    try {
                      await update(r.id, patch);
                      void qc.invalidateQueries({ queryKey: ["frp"] });
                    } catch (err) {
                      toast.error(t('frp.saveFailed'), errorMessage(err));
                    }
                  }}
                  onDelete={async () => {
                    try {
                      await remove(r.id);
                      void qc.invalidateQueries({ queryKey: ["frp"] });
                      toast.success(t('frp.deleted'));
                    } catch (err) {
                      toast.error(t('frp.deleteFailed'), errorMessage(err));
                    }
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RuleDialog
        open={creating}
        initialName={nextName()}
        onClose={() => setCreating(false)}
        onSave={async (payload) => {
          await create(payload);
          void qc.invalidateQueries({ queryKey: ["frp"] });
        }}
      />
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   新建规则弹窗：填完再保存
   —— 原先是「点一下就落库一条空规则」，随后每次失焦又各触发一次 frpc 重启，
   既容易卡顿，也会把没填完的规则写进配置。
   --------------------------------------------------------------------------- */
function RuleDialog({
  open,
  initialName,
  onClose,
  onSave,
}: {
  open: boolean;
  initialName: string;
  onClose: () => void;
  onSave: (payload: FrpRuleInput) => Promise<void>;
}) {
  const t = useT();
  const toast = useToast();
  const [form, setForm] = useState<FrpRuleInput>({ ...EMPTY_RULE, name: initialName });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY_RULE, name: initialName });
      setErrors({});
      setBusy(false);
    }
  }, [open, initialName]);

  function patch<K extends keyof FrpRuleInput>(key: K, value: FrpRuleInput[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    const name = form.name.trim();
    if (!name) next.name = t('frp.ruleNameRequired');
    else if (!/^[A-Za-z0-9_-]+$/.test(name))
      next.name = t('frp.ruleNameInvalid');
    if (!(form.local_ip ?? "").trim()) next.local_ip = t('frp.localIpRequired');
    if (!(form.local_port > 0 && form.local_port <= 65535))
      next.local_port = t('frp.portRange');
    if (!(form.remote_port > 0 && form.remote_port <= 65535))
      next.remote_port = t('frp.portRange');
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit() {
    if (!validate()) return;
    setBusy(true);
    try {
      await onSave({ ...form, name: form.name.trim() });
      toast.success(t('frp.ruleCreated'), t('frp.ruleCreatedDetail'));
      onClose();
    } catch (err) {
      toast.error(t('frp.createFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('frp.dialogTitle')}
      description={t('frp.dialogDesc')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<IconCheck size={14} />}
            loading={busy}
            onClick={() => void submit()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Input
        label={t('frp.fieldRuleName')}
        required
        value={form.name}
        error={errors.name}
        hint={t('frp.ruleNameHint')}
        onChange={(e) => patch("name", e.target.value)}
      />
      <Input
        label={t('frp.fieldLocalIp')}
        className="mono"
        value={form.local_ip}
        error={errors.local_ip}
        hint={t('frp.localIpHint')}
        onChange={(e) => patch("local_ip", e.target.value)}
      />
      <div className="form-grid-2">
        <Input
          label={t('frp.fieldLocalPort')}
          type="number"
          value={String(form.local_port)}
          error={errors.local_port}
          onChange={(e) => patch("local_port", Number(e.target.value))}
        />
        <Input
          label={t('frp.fieldRemotePort')}
          type="number"
          value={String(form.remote_port)}
          error={errors.remote_port}
          hint={t('frp.remotePortHint')}
          onChange={(e) => patch("remote_port", Number(e.target.value))}
        />
      </div>
    </Modal>
  );
}

function RuleRow({
  rule,
  canManageRow,
  isEffective,
  onUpdate,
  onDelete,
}: {
  rule: FrpRule;
  canManageRow: boolean;
  isEffective: boolean;
  onUpdate: (patch: Partial<FrpRuleInput>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState(rule);
  const [busy, setBusy] = useState(false);
  const isDirty = JSON.stringify(draft) !== JSON.stringify(rule);

  /* 只在服务端值真的变化时才同步草稿：列表每 8 秒轮询一次，
     不能因为拿到新对象就把用户正在输入的内容覆盖掉 */
  useEffect(() => {
    setDraft(rule);
  }, [rule.id, rule.name, rule.local_ip, rule.local_port, rule.remote_port]);

  /* 显式保存：一次改动只提交一次请求，也就只重启一次 frpc */
  async function save() {
    if (!isDirty) return;
    setBusy(true);
    try {
      await onUpdate({
        name: draft.name,
        local_ip: draft.local_ip,
        local_port: draft.local_port,
        remote_port: draft.remote_port,
      });
    } finally {
      setBusy(false);
    }
  }

  const locked = !canManageRow || busy;

  return (
    <tr>
      <td>
        <Badge variant={rule.username === "" ? "warning" : "neutral"} size="sm">
          {rule.username || t('frp.ownerless')}
        </Badge>
      </td>
      <td>
        <div className="input-wrap">
          <input
            className="input"
            value={draft.name}
            disabled={locked}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>
      </td>
      <td>
        <div className="input-wrap">
          <input
            className="input mono"
            value={draft.local_ip}
            disabled={locked}
            onChange={(e) => setDraft({ ...draft, local_ip: e.target.value })}
          />
        </div>
      </td>
      <td>
        <div className="input-wrap">
          <input
            className="input"
            type="number"
            value={draft.local_port}
            disabled={locked}
            onChange={(e) => setDraft({ ...draft, local_port: Number(e.target.value) })}
          />
        </div>
      </td>
      <td>
        <div className="input-wrap">
          <input
            className="input"
            type="number"
            value={draft.remote_port}
            disabled={locked}
            onChange={(e) => setDraft({ ...draft, remote_port: Number(e.target.value) })}
          />
        </div>
      </td>
      <td>
        <div className="flex flex-wrap items-center gap-4">
          <Badge variant={isEffective ? "success" : "neutral"} size="sm" dot pulse={isEffective}>
            {isEffective ? t('frp.effective') : t('frp.notApplied')}
          </Badge>
          {isDirty ? (
            <Badge variant={busy ? "info" : "warning"} size="sm" dot={busy} pulse={busy}>
              {busy ? t('frp.saving') : t('frp.unsaved')}
            </Badge>
          ) : null}
        </div>
      </td>
      <td>
        <div className="flex items-center gap-4">
          {isDirty ? (
            <>
              <IconButton
                label={t('frp.saveRow')}
                variant="primary"
                disabled={busy}
                onClick={() => void save()}
              >
                <IconCheck size={15} />
              </IconButton>
              <IconButton label={t('frp.revertRow')} disabled={busy} onClick={() => setDraft(rule)}>
                <IconRefresh size={15} />
              </IconButton>
            </>
          ) : (
            <IconButton
              label={t('frp.deleteRule', { name: rule.name })}
              variant="danger"
              disabled={busy}
              onClick={() => void onDelete()}
            >
              <IconTrash size={15} />
            </IconButton>
          )}
        </div>
      </td>
    </tr>
  );
}

/* ---------------------------------------------------------------------------
   日志
   --------------------------------------------------------------------------- */
function LogCard() {
  const t = useT();
  const logsQuery = useQuery({
    queryKey: ["frp", "logs"],
    queryFn: frpApi.logs,
    refetchInterval: 5000,
  });
  const logs = logsQuery.data?.logs ?? [];

  return (
    <Card>
      <CardHeader
        title={t('frp.logsTitle')}
        icon={<IconNetwork size={16} />}
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon={<IconRefresh size={14} />}
            onClick={() => void logsQuery.refetch()}
          >
            {t('frp.refreshLogs')}
          </Button>
        }
      />
      {logs.length > 0 ? (
        <div className="log-viewer">
          {logs.map((line, i) => (
            <div className="log-line" key={i}>
              <span className="log-line-num">{i + 1}</span>
              <span className="log-line-text">{line}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-secondary fs-sm">{t('frp.noLogs')}</p>
      )}
    </Card>
  );
}