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
import { Input } from "../components/ui/Input";
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

export function Frp() {
  return (
    <PageShell
      title={
        <>
          <IconNetwork size={20} />
          内网穿透
        </>
      }
      subtitle="以 frpc 客户端把内网服务暴露到公网 frps —— 服务端配置由管理员维护，规则按用户归属"
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
          toast.error("没有权限", "启停 frpc 需要管理员（settings.manage）权限");
          return;
        }
        setBusy(true);
        try {
          if (running) {
            await frpApi.server.stop();
            toast.success("已停止内网穿透");
          } else {
            await frpApi.server.start();
            toast.success("frpc 已启动");
          }
          void qc.invalidateQueries({ queryKey: ["frp"] });
        } catch (err) {
          toast.error("操作失败", errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {running ? "停止穿透" : "启动穿透"}
    </Button>
  );
}

/* ---------------------------------------------------------------------------
   状态行：运行状态 / frpc 二进制 / 规则数
   --------------------------------------------------------------------------- */
function StatusRow() {
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
  const serverAddr = serverQuery.data?.server_addr || "未配置";
  const serverPort = serverQuery.data?.server_port ?? 7000;
  const tokenSet = serverQuery.data?.token_set ?? false;

  return (
    <Card collapsible={false}>
      <CardHeader title="运行状态" icon={<IconNetwork size={16} />} />
      <div className="grid grid-4">
        <Stat label="frpc 进程">
          <Badge variant={running ? "success" : "neutral"} dot pulse={running} size="sm">
            {running ? "运行中" : "已停止"}
          </Badge>
        </Stat>
        <Stat label="客户端程序">
          <Badge variant={available ? "success" : "warning"} size="sm">
            {available ? "已安装" : "未安装"}
          </Badge>
        </Stat>
        <Stat label="frps 服务端">
          {serverAddr ? (
            <span className="mono fs-sm">
              {serverAddr}:{serverPort}
              {tokenSet ? <span className="text-success"> · token</span> : null}
            </span>
          ) : (
            <span className="text-warning fs-sm">未配置</span>
          )}
        </Stat>
        <Stat label="生效规则数">
          <span className="mono">{ruleCount} 条</span>
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
        toast.warning("已保存", "但自动重启 frpc 失败：" + result.restart_error);
      } else if (result.restarted) {
        toast.success("服务端配置已保存，frpc 已重启并立即生效");
      } else {
        toast.success("服务端配置已保存");
      }
      setTokenDraft("");
      void qc.invalidateQueries({ queryKey: ["frp"] });
    } catch (err) {
      toast.error("保存失败", errorMessage(err));
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
      toast.success("Token 已清空");
      void qc.invalidateQueries({ queryKey: ["frp"] });
    } catch (err) {
      toast.error("清空失败", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card collapsible={false}>
      <CardHeader
        title="frps 服务端"
        icon={<IconServer size={16} />}
        subtitle={canManage ? "仅管理员可改 —— 服务端地址 / token 属于基础设施" : "只读 —— 服务端配置仅管理员可改"}
        actions={
          canManage ? (
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!dirty}
              onClick={() => void save()}
            >
              保存修改
            </Button>
          ) : null
        }
      />
      {draft ? (
        <div className="flex flex-col gap-12">
          <Field label="服务端地址">
            <input
              className="input"
              value={draft.server_addr}
              placeholder="frps.example.com 或公网 IP"
              disabled={!canManage}
              onChange={(e) => setDraft({ ...draft, server_addr: e.target.value })}
            />
          </Field>
          <Field label="服务端端口（frps bindPort）">
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
            label="Token（与服务端 auth.token 一致）"
            hint={
              serverQuery.data?.token_set
                ? "已加密保存，前端不回显明文；输入新值可替换，留空则保持原值。"
                : "服务端未设置则留空。保存后以 **** 显示，不会回显明文。"
            }
          >
            <div className="flex gap-8">
              <input
                className="input"
                type="password"
                value={tokenDraft}
                placeholder={serverQuery.data?.token_set ? "****（已设置）" : ""}
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
                  清空
                </Button>
              ) : null}
            </div>
          </Field>
          {canManage ? (
            <p className="fs-xs text-muted">
              修改服务端配置后，若 frpc 正在运行会自动重启使新配置生效。
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
      <CardHeader title="frpc 客户端" icon={<IconNetwork size={16} />} />
      <div className="flex flex-col gap-12">
        <div className="flex items-center justify-between">
          <span className="fs-sm text-secondary">安装位置</span>
          <span className="mono fs-xs text-secondary" title={statusQuery.data?.binary}>
            {statusQuery.data?.binary || "未安装"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="fs-sm text-secondary">客户端版本</span>
          <span className="mono fs-sm">{available ? "已就绪" : "缺失"}</span>
        </div>
        {!available ? (
          <Notice tone="warning" title="尚未安装 frpc">
            面板自带目录与系统 PATH 中都没有 frpc 二进制。
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
                toast.success("frpc 安装完成", res.binary);
                void qc.invalidateQueries({ queryKey: ["frp"] });
              } catch (err) {
                toast.error("安装失败", errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            下载安装 frpc
          </Button>
        ) : null}
        {canManage ? (
          <p className="fs-xs text-muted">
            安装完成后点上方「启动穿透」即可让 frpc 连接服务端。
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
        title="穿透规则"
        icon={<IconNetwork size={16} />}
        subtitle={
          isAdmin
            ? "管理员可看到所有人的规则；非本人规则请同步删除按钮可触发认领/迁移"
            : `只显示归属 ${ownUsername || "当前用户"} 的规则`
        }
        actions={
          canManage ? (
            <Button
              variant="primary"
              size="sm"
              icon={<IconPlus size={14} />}
              onClick={() => setCreating(true)}
            >
              新建规则
            </Button>
          ) : null
        }
      />

      {dupNames.length > 0 ? (
        <Notice tone="danger" title="存在重名规则">
          以下规则名重复：{dupNames.join("、")}。frpc 启动会因此失败，请改名。
        </Notice>
      ) : null}

      {rules.length === 0 ? (
        <p className="text-secondary fs-sm">还没有规则，点击右上角「新建规则」开始。</p>
      ) : (
        <div className="table-container">
          <table className="table table-dense">
            <thead>
              <tr>
                <th>归属</th>
                <th>名称</th>
                <th>本地 IP</th>
                <th>本地端口</th>
                <th>公网端口</th>
                <th>状态</th>
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
                      toast.error("保存失败", errorMessage(err));
                    }
                  }}
                  onDelete={async () => {
                    try {
                      await remove(r.id);
                      void qc.invalidateQueries({ queryKey: ["frp"] });
                      toast.success("已删除");
                    } catch (err) {
                      toast.error("删除失败", errorMessage(err));
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
    if (!name) next.name = "请填写规则名称";
    else if (!/^[A-Za-z0-9_-]+$/.test(name))
      next.name = "只能用字母、数字、下划线与短横线";
    if (!(form.local_ip ?? "").trim()) next.local_ip = "请填写本地 IP";
    if (!(form.local_port > 0 && form.local_port <= 65535))
      next.local_port = "端口范围 1-65535";
    if (!(form.remote_port > 0 && form.remote_port <= 65535))
      next.remote_port = "端口范围 1-65535";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit() {
    if (!validate()) return;
    setBusy(true);
    try {
      await onSave({ ...form, name: form.name.trim() });
      toast.success("规则已创建", "frpc 正在按新配置重载");
      onClose();
    } catch (err) {
      toast.error("创建失败", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建穿透规则"
      description="把内网服务映射到公网端口，保存后 frpc 会自动重启使其生效。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={<IconCheck size={14} />}
            loading={busy}
            onClick={() => void submit()}
          >
            保存
          </Button>
        </>
      }
    >
      <Input
        label="规则名称"
        required
        value={form.name}
        error={errors.name}
        hint="frpc 内的唯一标识，只能用字母 / 数字 / 下划线 / 短横线"
        onChange={(e) => patch("name", e.target.value)}
      />
      <Input
        label="本地 IP"
        className="mono"
        value={form.local_ip}
        error={errors.local_ip}
        hint="要暴露的内网服务地址，通常填 127.0.0.1"
        onChange={(e) => patch("local_ip", e.target.value)}
      />
      <div className="form-grid-2">
        <Input
          label="本地端口"
          type="number"
          value={String(form.local_port)}
          error={errors.local_port}
          onChange={(e) => patch("local_port", Number(e.target.value))}
        />
        <Input
          label="公网端口"
          type="number"
          value={String(form.remote_port)}
          error={errors.remote_port}
          hint="需在 frps 服务端允许的端口范围内"
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
          {rule.username || "无主"}
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
            {isEffective ? "已生效" : "未应用"}
          </Badge>
          {isDirty ? (
            <Badge variant={busy ? "info" : "warning"} size="sm" dot={busy} pulse={busy}>
              {busy ? "保存中…" : "未保存"}
            </Badge>
          ) : null}
        </div>
      </td>
      <td>
        <div className="flex items-center gap-4">
          {isDirty ? (
            <>
              <IconButton
                label="保存该规则"
                variant="primary"
                disabled={busy}
                onClick={() => void save()}
              >
                <IconCheck size={15} />
              </IconButton>
              <IconButton label="撤销修改" disabled={busy} onClick={() => setDraft(rule)}>
                <IconRefresh size={15} />
              </IconButton>
            </>
          ) : (
            <IconButton
              label={`删除规则 ${rule.name}`}
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
  const logsQuery = useQuery({
    queryKey: ["frp", "logs"],
    queryFn: frpApi.logs,
    refetchInterval: 5000,
  });
  const logs = logsQuery.data?.logs ?? [];

  return (
    <Card>
      <CardHeader
        title="frpc 运行日志"
        icon={<IconNetwork size={16} />}
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon={<IconRefresh size={14} />}
            onClick={() => void logsQuery.refetch()}
          >
            刷新日志
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
        <p className="text-secondary fs-sm">暂无日志，启动穿透后会显示 frpc 输出。</p>
      )}
    </Card>
  );
}