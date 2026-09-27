/* ==========================================================================
   ProxCenter — 网站证书（腾讯云免费证书申请 / 部署 / 自动续期）
   ========================================================================== */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { certsApi, vmsApi } from "../api/endpoints";
import { PageShell } from "../components/Layout";
import { Card, CardHeader } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button, IconButton } from "../components/ui/Button";
import { Input, Select, Switch, Textarea } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Notice } from "../components/ui/EmptyState";
import {
  IconShield,
  IconCloud,
  IconPlus,
  IconTrash,
  IconRefresh,
  IconSave,
  IconDownload,
  IconEdit,
  IconKey,
  IconClock,
  IconSearch,
} from "../components/Icons";
import { useToast } from "../hooks/useToast";
import { useAuth } from "../hooks/useAuth";
import { isRunning } from "../utils/status";
import { formatDate, formatDateTime, formatRelative } from "../utils/format";
import type { CertSite, RemoteCertificate } from "../api/types";

const ACTION_LABEL: Record<string, string> = {
  apply: "申请证书",
  renew: "自动续期",
  deploy: "部署证书",
  bind: "绑定证书",
  sync: "状态同步",
};

const RESULT_META: Record<string, { label: string; variant: "success" | "warning" | "danger" | "info" }> = {
  success: { label: "成功", variant: "success" },
  pending: { label: "等待签发", variant: "info" },
  failed: { label: "失败", variant: "danger" },
};

function errText(err: unknown): string {
  const detail = (err as any)?.response?.data?.detail;
  if (typeof detail === "string" && detail) return detail;
  return err instanceof Error ? err.message : String(err);
}

/** 站点编辑表单的默认值 */
function blankSite(): Partial<CertSite> {
  return {
    name: "",
    domain: "",
    deploy_method: "local",
    deploy_dir: "/etc/nginx/ssl",
    cert_filename: "fullchain.pem",
    key_filename: "privkey.pem",
    reload_command: "nginx -s reload",
    ssh_port: 22,
    ssh_user: "root",
    ssh_auth: "password",
    ssh_host: "",
    ssh_password: "",
    ssh_key: "",
    agent_node: "",
    agent_vmid: "",
    auto_renew: true,
    renew_before_days: 0,
    enabled: true,
    notes: "",
  };
}

/** 部署目标的展示文案 */
function targetText(site: CertSite): string {
  const dir = site.deploy_dir || "";
  if (site.deploy_method === "ssh") {
    return `${site.ssh_user || "root"}@${site.ssh_host || "?"}:${site.ssh_port || 22}${dir}`;
  }
  if (site.deploy_method === "agent") {
    return `VM ${site.agent_vmid || "?"}@${site.agent_node || "?"}${dir}`;
  }
  return `本机 ${dir}`;
}

export function Certificates() {
  const qc = useQueryClient();
  const toast = useToast();
  const { hasPermission } = useAuth();
  const canManage = hasPermission("cert.manage");

  const [tc, setTc] = useState<Record<string, any> | null>(null);
  const [secretInput, setSecretInput] = useState("");
  const [secretClear, setSecretClear] = useState(false);
  const [form, setForm] = useState<Partial<CertSite> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CertSite | null>(null);
  const [clearLogsOpen, setClearLogsOpen] = useState(false);
  const [pickerSite, setPickerSite] = useState<CertSite | null>(null);
  const [remote, setRemote] = useState<RemoteCertificate[] | null>(null);
  const [remoteSearch, setRemoteSearch] = useState("");
  const [busy, setBusy] = useState("");

  const query = useQuery({
    queryKey: ["certs"],
    queryFn: certsApi.get,
    refetchInterval: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (query.data?.tencent && tc === null) setTc(query.data.tencent);
  }, [query.data, tc]);

  const needsAgent = form?.deploy_method === "agent";
  const vmsQuery = useQuery({
    queryKey: ["vms", "all"],
    queryFn: () => vmsApi.list(),
    staleTime: 30_000,
    enabled: needsAgent,
  });

  const agentValue =
    form?.agent_node && form?.agent_vmid
      ? `${form.agent_node}|${form.agent_vmid}`
      : "";
  // Guest Agent 部署只能选运行中的虚拟机（虚拟机没开机时 Agent 无法工作）
  const agentOptions = useMemo(() => {
    const vms = (vmsQuery.data ?? [])
      .filter((vm) => isRunning(vm.status) && !vm.template)
      .map((vm) => ({
        label: `${vm.name}（VMID ${vm.vmid} · ${vm.node}）`,
        value: `${vm.node}|${vm.vmid}`,
      }));
    if (agentValue && !vms.some((o) => o.value === agentValue)) {
      return [{ label: `${agentValue}（当前未运行）`, value: agentValue }, ...vms];
    }
    return vms;
  }, [vmsQuery.data, agentValue]);

  async function run(key: string, fn: () => Promise<string>, okTitle: string): Promise<boolean> {
    setBusy(key);
    try {
      const note = await fn();
      await qc.invalidateQueries({ queryKey: ["certs"] });
      toast.success(okTitle, note || undefined);
      return true;
    } catch (err) {
      toast.error("操作失败", errText(err));
      return false;
    } finally {
      setBusy("");
    }
  }

  const sites: CertSite[] = query.data?.sites ?? [];
  const logs = query.data?.logs ?? [];
  const options = query.data?.options;
  const secretSet = !!query.data?.secret_set;
  // 证书按用户隔离：腾讯云密钥、站点、日志都归属到使用者；管理员可见全部
  const ownUsername = String(query.data?.own_username ?? "");
  const isAdmin = !!query.data?.is_admin;
  /** 别人的站点：管理员可查看但只读（操作一律用站点归属者的密钥） */
  const isForeign = (site: CertSite) =>
    isAdmin && !!site.username && String(site.username) !== ownUsername;

  /* ---- 腾讯云账号 ---- */
  function saveTencent() {
    if (!tc) return;
    void run(
      "tc",
      async () => {
        const payload: Record<string, unknown> = { ...tc, secret_key: secretInput };
        if (secretClear) payload.secret_key_clear = true;
        await certsApi.saveTencent(payload);
        setSecretInput("");
        setSecretClear(false);
        return "腾讯云 API 密钥已保存";
      },
      "配置已保存",
    );
  }

  function testTencent() {
    void run("test", async () => (await certsApi.testTencent()).detail, "连接正常");
  }

  /* ---- 站点 ---- */
  function openCreate() {
    setForm(blankSite());
    setIsNew(true);
  }

  function openEdit(site: CertSite) {
    setForm({ ...site });
    setIsNew(false);
  }

  function saveSite() {
    if (!form) return;
    void run(
      "site",
      async () => {
        if (isNew) {
          await certsApi.createSite(form);
        } else if (form.id) {
          await certsApi.updateSite(form.id, form);
        }
        setForm(null);
        return "站点已保存";
      },
      "保存成功",
    );
  }

  function applyCert(site: CertSite) {
    void run(
      "apply:" + site.id,
      async () => (await certsApi.apply(site.id)).detail,
      "申请已提交",
    );
  }

  function deployCert(site: CertSite) {
    void run(
      "deploy:" + site.id,
      async () => (await certsApi.deploy(site.id)).detail,
      "部署完成",
    );
  }

  function syncCert(site: CertSite) {
    void run(
      "sync:" + site.id,
      async () => {
        const s = (await certsApi.sync(site.id)).site;
        return `状态：${s.cert_status_text || "未知"}${
          s.days_left !== null && s.days_left !== undefined ? ` · 剩余 ${s.days_left} 天` : ""
        }`;
      },
      "已同步",
    );
  }

  function loadRemote() {
    void run(
      "remote",
      async () => {
        const r = await certsApi.remoteList(remoteSearch);
        setRemote(r.certificates);
        return `获取到 ${r.count} 张证书`;
      },
      "已获取证书列表",
    );
  }

  function bindRemote(cert: RemoteCertificate) {
    if (!pickerSite) return;
    void run(
      "bind",
      async () => {
        await certsApi.bind(pickerSite.id, cert.cert_id);
        setPickerSite(null);
        setRemote(null);
        return `已绑定证书 ${cert.cert_id}`;
      },
      "绑定成功",
    );
  }

  return (
    <PageShell
      title="网站证书"
      subtitle="使用腾讯云免费 DV 证书（有效期 90 天、单域名），自动申请、部署到本机 / 远程服务器 / 虚拟机，并在到期前续期"
      actions={
        <>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            loading={busy === "syncAll"}
            disabled={!canManage || sites.length === 0}
            onClick={() =>
              void run(
                "syncAll",
                async () => {
                  const r = await certsApi.syncAll();
                  return `已同步 ${r.sites.length} 个站点`;
                },
                "同步完成",
              )
            }
          >
            同步全部
          </Button>
          <Button
            variant="primary"
            icon={<IconPlus size={15} />}
            disabled={!canManage}
            onClick={openCreate}
          >
            添加站点
          </Button>
        </>
      }
    >
      {query.isError ? (
        <Notice tone="danger" title="无法加载证书配置">
          {errText(query.error)}
        </Notice>
      ) : null}

      {/* ---------------- 腾讯云账号 ---------------- */}
      <Card>
        <CardHeader
          title="腾讯云账号"
          subtitle="在「访问管理 → API 密钥」中创建密钥；免费证书额度 50 张，需账号完成实名认证"
          icon={<IconCloud size={16} />}
          actions={
            <>
              <Badge variant={secretSet ? "success" : "neutral"} size="sm" dot>
                <span className="flex items-center gap-4">
                  <IconKey size={12} />
                  {secretSet ? "密钥已加密保存" : "未配置密钥"}
                </span>
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                loading={busy === "test"}
                disabled={!canManage || !secretSet}
                onClick={testTencent}
              >
                测试连接
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<IconSave size={14} />}
                loading={busy === "tc"}
                disabled={!canManage || tc === null}
                onClick={saveTencent}
              >
                保存
              </Button>
            </>
          }
        />
        {tc ? (
          <div className="form-grid">
            <Input
              label="SecretId"
              value={tc.secret_id || ""}
              placeholder="AKIDxxxxxxxxxxxxxxxx"
              autoComplete="off"
              className="mono"
              disabled={!canManage}
              onChange={(e) => setTc({ ...tc, secret_id: e.target.value })}
            />
            <Input
              label="SecretKey"
              type="password"
              value={secretInput}
              placeholder={secretSet ? "已加密保存，留空表示不修改" : "填写 API 密钥"}
              autoComplete="new-password"
              disabled={!canManage}
              hint={
                secretClear
                  ? "保存后将清除已保存的密钥，自动续期随即停止"
                  : secretSet
                    ? "密钥以密文存储，不会回显。留空表示不修改。"
                    : "密钥仅保存在本机数据库（加密存储）"
              }
              onChange={(e) => {
                setSecretClear(false);
                setSecretInput(e.target.value);
              }}
            />
            <Select
              label="域名验证方式"
              value={tc.dv_auth_method || "DNS_AUTO"}
              disabled={!canManage}
              options={options?.dv_auth_methods ?? []}
              onChange={(e) => setTc({ ...tc, dv_auth_method: e.target.value })}
            />
            <Select
              label="证书密钥算法"
              value={tc.encrypt_algo || "RSA"}
              disabled={!canManage}
              options={options?.encrypt_algos ?? []}
              onChange={(e) => setTc({ ...tc, encrypt_algo: e.target.value })}
            />
            <Input
              label="默认提前续期天数"
              type="number"
              value={tc.renew_before_days ?? 15}
              disabled={!canManage}
              hint="证书剩余天数小于该值时自动申请续期（免费证书仅 90 天，建议 15~20 天）"
              onChange={(e) =>
                setTc({ ...tc, renew_before_days: Number(e.target.value) })
              }
            />
          </div>
        ) : (
          <div className="skeleton skeleton-text" />
        )}
      </Card>

      {/* ---------------- 证书站点 ---------------- */}
      <Card>
        <CardHeader
          title="证书站点"
          subtitle="填写域名与证书部署目录后，点「申请」即可自动签发并部署"
          icon={<IconShield size={16} />}
        />
        {sites.length > 0 ? (
          <div className="table-container">
            <table className="table table-dense">
              <thead>
                <tr>
                  {isAdmin ? <th>归属</th> : null}
                  <th>站点</th>
                  <th>域名</th>
                  <th>证书</th>
                  <th>到期</th>
                  <th>部署位置</th>
                  <th>自动续期</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => {
                  const left = site.days_left;
                  const threshold = site.renew_before_days_effective ?? 15;
                  const tone: "danger" | "warning" | "success" =
                    left === null || left === undefined
                      ? "success"
                      : left <= 7
                        ? "danger"
                        : left <= threshold
                          ? "warning"
                          : "success";
                  const readonly = isForeign(site);
                  return (
                    <tr key={site.id}>
                      {isAdmin ? (
                        <td>
                          <Badge variant={readonly ? "neutral" : "success"} size="sm">
                            {site.username || ownUsername || "-"}
                          </Badge>
                        </td>
                      ) : null}
                      <td>
                        <div>{site.name}</div>
                        <div className="fs-xs text-muted">
                          {site.enabled ? "已启用" : "已停用"}
                          {site.notes ? ` · ${site.notes}` : ""}
                        </div>
                      </td>
                      <td>
                        <span className="mono">{site.domain}</span>
                      </td>
                      <td>
                        {site.cert_id ? (
                          <div>
                            <span className="mono fs-sm">{site.cert_id}</span>
                            <div className="fs-xs text-muted">
                              {site.cert_status_text || "状态未知"}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted">未申请</span>
                        )}
                        {site.pending_cert_id ? (
                          <div className="fs-xs text-accent">
                            待签发：{site.pending_cert_id}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {left === null || left === undefined ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <div>
                            <Badge variant={tone} size="sm" dot>
                              {left < 0 ? `已过期 ${-left} 天` : `剩余 ${left} 天`}
                            </Badge>
                            <div className="fs-xs text-muted">
                              {formatDate(site.expire_at)}
                            </div>
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="mono fs-sm" style={{ wordBreak: "break-all" }}>
                          {targetText(site)}
                        </div>
                        <div className="fs-xs text-muted">
                          {site.cert_filename} · {site.key_filename}
                          {site.reload_command ? " · " + site.reload_command : ""}
                        </div>
                        {site.last_deploy_at ? (
                          <div className="fs-xs text-muted">
                            上次部署 {formatRelative(site.last_deploy_at)}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <Badge
                          variant={site.auto_renew ? "success" : "neutral"}
                          size="sm"
                          dot
                        >
                          {site.auto_renew ? "已开启" : "未开启"}
                        </Badge>
                        <div className="fs-xs text-muted">
                          提前 {threshold} 天
                        </div>
                      </td>
                      <td>
                        <div className="flex items-center gap-4">
                          <IconButton
                            label={readonly ? "他人的站点，只读" : "申请 / 续期证书"}
                            disabled={!canManage || readonly || busy === "apply:" + site.id}
                            onClick={() => applyCert(site)}
                          >
                            <IconShield size={15} />
                          </IconButton>
                          <IconButton
                            label={readonly ? "他人的站点，只读" : "立即部署"}
                            disabled={!canManage || readonly || busy === "deploy:" + site.id}
                            onClick={() => deployCert(site)}
                          >
                            <IconDownload size={15} />
                          </IconButton>
                          <IconButton
                            label={readonly ? "他人的站点，只读" : "同步腾讯云状态"}
                            disabled={!canManage || readonly || busy === "sync:" + site.id}
                            onClick={() => syncCert(site)}
                          >
                            <IconRefresh size={15} />
                          </IconButton>
                          <IconButton
                            label={readonly ? "他人的站点，只读" : "编辑站点"}
                            disabled={!canManage || readonly}
                            onClick={() => openEdit(site)}
                          >
                            <IconEdit size={15} />
                          </IconButton>
                          <IconButton
                            label={readonly ? "他人的站点，只读" : "删除站点"}
                            variant="danger"
                            disabled={!canManage || readonly}
                            onClick={() => setDeleteTarget(site)}
                          >
                            <IconTrash size={15} />
                          </IconButton>
                        </div>
                        {site.last_error ? (
                          <div className="fs-xs text-danger">{site.last_error}</div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-secondary fs-sm">
            还没有站点。点击右上角「添加站点」填写域名与部署目录，然后点「申请」即可自动签发并部署证书。
          </div>
        )}
      </Card>

      {/* ---------------- 部署日志 ---------------- */}
      <Card>
        <CardHeader
          title="部署日志"
          subtitle={logs.length > 0 ? `最近 ${logs.length} 条操作记录` : undefined}
          icon={<IconClock size={16} />}
          actions={
            <Button
              variant="danger"
              size="sm"
              icon={<IconTrash size={14} />}
              loading={busy === "clearLogs"}
              disabled={!canManage || logs.length === 0}
              onClick={() => setClearLogsOpen(true)}
            >
              清除日志
            </Button>
          }
        />
        {logs.length > 0 ? (
          <div className="table-container">
            <table className="table table-dense">
              <thead>
                <tr>
                  {isAdmin ? <th>归属</th> : null}
                  <th>时间</th>
                  <th>站点</th>
                  <th>动作</th>
                  <th>结果</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const meta = RESULT_META[log.result] ?? {
                    label: log.result,
                    variant: "neutral" as const,
                  };
                  return (
                    <tr key={log.id}>
                      {isAdmin ? (
                        <td>
                          <span className="fs-sm">{log.username || "-"}</span>
                        </td>
                      ) : null}
                      <td className="text-secondary fs-sm">{formatDateTime(log.ts)}</td>
                      <td>
                        <div>{log.site_name || "—"}</div>
                        <div className="fs-xs text-muted mono">{log.domain}</div>
                      </td>
                      <td>{ACTION_LABEL[log.action] ?? log.action}</td>
                      <td>
                        <Badge variant={meta.variant} size="sm" dot>
                          {meta.label}
                        </Badge>
                      </td>
                      <td className="fs-sm text-secondary">{log.detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-secondary fs-sm">暂无操作记录。</div>
        )}
      </Card>

      {/* ---------------- 站点编辑 ---------------- */}
      <Modal
        open={form !== null}
        title={isNew ? "添加证书站点" : "编辑证书站点"}
        description="域名、部署目录与重载命令决定证书最终落到哪里"
        size="lg"
        onClose={() => setForm(null)}
        footer={
          <>
            {!isNew && form?.id ? (
              <Button
                variant="ghost"
                icon={<IconCloud size={14} />}
                onClick={() => {
                  const site = form as CertSite;
                  setPickerSite(site);
                  setRemote(null);
                }}
              >
                选择已有证书
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setForm(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              icon={<IconSave size={14} />}
              loading={busy === "site"}
              onClick={saveSite}
            >
              保存
            </Button>
          </>
        }
      >
        {form ? (
          <div className="form-grid">
            <Input
              label="站点名称"
              value={form.name || ""}
              placeholder="例如：博客站点"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Input
              label="域名"
              required
              value={form.domain || ""}
              placeholder="blog.example.com"
              className="mono"
              hint="腾讯云免费证书仅支持单个域名，不支持泛域名与 IP"
              onChange={(e) => setForm({ ...form, domain: e.target.value })}
            />
            <Select
              label="部署方式"
              value={form.deploy_method || "local"}
              options={options?.deploy_methods ?? []}
              hint={
                form.deploy_method === "local"
                  ? "证书写到面板所在服务器（本机）的目录"
                  : form.deploy_method === "ssh"
                    ? "通过 SSH 把证书上传到目标服务器并执行重载命令"
                    : "通过 Proxmox Guest Agent 把证书写进虚拟机（无需 SSH 凭据）"
              }
              onChange={(e) =>
                setForm({ ...form, deploy_method: e.target.value as CertSite["deploy_method"] })
              }
            />
            {form.deploy_method === "ssh" ? (
              <>
                <Input
                  label="目标服务器地址"
                  required
                  value={form.ssh_host || ""}
                  placeholder="192.168.1.20 或 web.example.com"
                  className="mono"
                  hint="Linux 服务器的 IP 或域名"
                  onChange={(e) => setForm({ ...form, ssh_host: e.target.value })}
                />
                <Input
                  label="SSH 端口"
                  type="number"
                  value={form.ssh_port ?? 22}
                  onChange={(e) => setForm({ ...form, ssh_port: Number(e.target.value) })}
                />
                <Input
                  label="登录用户名"
                  required
                  value={form.ssh_user || ""}
                  placeholder="root"
                  className="mono"
                  hint="需要对该目录有写权限，且能执行重载命令"
                  onChange={(e) => setForm({ ...form, ssh_user: e.target.value })}
                />
                <Select
                  label="认证方式"
                  value={form.ssh_auth || "password"}
                  options={[
                    { value: "password", label: "密码" },
                    { value: "key", label: "私钥（推荐）" },
                  ]}
                  onChange={(e) => setForm({ ...form, ssh_auth: e.target.value })}
                />
                {form.ssh_auth === "key" ? (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <Textarea
                      label="SSH 私钥"
                      rows={5}
                      mono
                      value={form.ssh_key || ""}
                      placeholder={
                        form.ssh_key_set
                          ? "已加密保存，留空表示不修改"
                          : "-----BEGIN OPENSSH PRIVATE KEY----- …"
                      }
                      hint="支持 RSA / ECDSA / Ed25519，不能带密码短语；私钥以密文存储"
                      onChange={(e) => setForm({ ...form, ssh_key: e.target.value })}
                    />
                  </div>
                ) : (
                  <Input
                    label="SSH 密码"
                    type="password"
                    value={form.ssh_password || ""}
                    placeholder={form.ssh_password_set ? "已加密保存，留空表示不修改" : "登录密码"}
                    autoComplete="new-password"
                    hint="密码以密文存储，接口不会回显"
                    onChange={(e) => setForm({ ...form, ssh_password: e.target.value })}
                  />
                )}
                <div className="field">
                  <div className="field-label">主机指纹</div>
                  <div className="fs-xs text-muted mono" style={{ wordBreak: "break-all" }}>
                    {form.ssh_host_key || "首次部署成功后自动记录，用于识别服务器是否被替换"}
                  </div>
                </div>
              </>
            ) : null}
            {form.deploy_method === "agent" ? (
              <Select
                label="目标虚拟机"
                value={agentValue}
                placeholder="选择一台运行中的虚拟机"
                options={agentOptions}
                hint="需要虚拟机内已安装并运行 qemu-guest-agent"
                onChange={(e) => {
                  const [node, vmid] = String(e.target.value).split("|");
                  setForm({ ...form, agent_node: node || "", agent_vmid: vmid || "" });
                }}
              />
            ) : null}
            <Input
              label={form.deploy_method === "local" ? "证书部署目录" : "目标机上的部署目录"}
              required
              value={form.deploy_dir || ""}
              placeholder="/etc/nginx/ssl/blog.example.com"
              className="mono"
              hint={
                form.deploy_method === "ssh"
                  ? "远程服务器上的绝对路径，不存在时会自动创建"
                  : form.deploy_method === "agent"
                    ? "虚拟机内的绝对路径，不存在时会自动创建"
                    : "本机绝对路径，目录不存在时会自动创建"
              }
              onChange={(e) => setForm({ ...form, deploy_dir: e.target.value })}
            />
            <Input
              label="证书文件名"
              value={form.cert_filename || ""}
              placeholder="fullchain.pem"
              className="mono"
              hint="Nginx 请使用完整证书链文件"
              onChange={(e) => setForm({ ...form, cert_filename: e.target.value })}
            />
            <Input
              label="私钥文件名"
              value={form.key_filename || ""}
              placeholder="privkey.pem"
              className="mono"
              hint="写入后权限为 0600"
              onChange={(e) => setForm({ ...form, key_filename: e.target.value })}
            />
            <Input
              label="部署后执行命令"
              value={form.reload_command || ""}
              placeholder="nginx -s reload"
              className="mono"
              hint={
                form.deploy_method === "ssh"
                  ? "在目标服务器上执行（如 systemctl reload nginx）"
                  : form.deploy_method === "agent"
                    ? "在虚拟机内执行（如 systemctl reload nginx）"
                    : "在面板所在服务器上执行；留空则不执行"
              }
              onChange={(e) => setForm({ ...form, reload_command: e.target.value })}
            />
            <Input
              label="提前续期天数"
              type="number"
              value={form.renew_before_days ?? 0}
              hint="0 表示跟随全局设置"
              onChange={(e) =>
                setForm({ ...form, renew_before_days: Number(e.target.value) })
              }
            />
            <Input
              label="备注"
              value={form.notes || ""}
              placeholder="例如：公司官网，证书给 Nginx 用"
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
            <div className="field">
              <Switch
                checked={form.auto_renew !== false}
                label="自动续期"
                hint="到期前自动申请新证书并重新部署"
                onChange={(v) => setForm({ ...form, auto_renew: v })}
              />
            </div>
            <div className="field">
              <Switch
                checked={form.enabled !== false}
                label="启用该站点"
                hint="停用后不再自动检查与续期"
                onChange={(v) => setForm({ ...form, enabled: v })}
              />
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ---------------- 腾讯云证书选择 ---------------- */}
      <Modal
        open={pickerSite !== null}
        title="选择腾讯云已有证书"
        description={
          pickerSite ? `为站点「${pickerSite.name}」绑定一张已签发的证书` : undefined
        }
        size="lg"
        onClose={() => setPickerSite(null)}
        footer={
          <Button variant="secondary" onClick={() => setPickerSite(null)}>
            关闭
          </Button>
        }
      >
        <div className="flex items-center gap-8">
          <Input
            value={remoteSearch}
            placeholder="按域名 / 备注 / 证书 ID 搜索"
            onChange={(e) => setRemoteSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") loadRemote();
            }}
          />
          <Button
            variant="secondary"
            icon={<IconSearch size={14} />}
            loading={busy === "remote"}
            onClick={loadRemote}
          >
            查询
          </Button>
        </div>
        {remote && remote.length > 0 ? (
          <div className="table-container" style={{ marginTop: 12 }}>
            <table className="table table-dense">
              <thead>
                <tr>
                  <th>域名</th>
                  <th>证书 ID</th>
                  <th>状态</th>
                  <th>到期</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {remote.map((cert) => (
                  <tr key={cert.cert_id}>
                    <td>
                      <div className="mono">{cert.domain}</div>
                      <div className="fs-xs text-muted">{cert.alias}</div>
                    </td>
                    <td className="mono fs-sm">{cert.cert_id}</td>
                    <td>
                      <Badge
                        variant={cert.status === 1 ? "success" : "warning"}
                        size="sm"
                        dot
                      >
                        {cert.status_text}
                      </Badge>
                    </td>
                    <td className="fs-sm text-secondary">
                      {cert.expire_at ? formatDate(cert.expire_at) : "—"}
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busy === "bind"}
                        disabled={cert.status !== 1}
                        onClick={() => bindRemote(cert)}
                      >
                        绑定
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-secondary fs-sm" style={{ marginTop: 12 }}>
            {remote ? "没有匹配的证书。" : "点击「查询」获取账号下的证书列表。"}
          </div>
        )}
      </Modal>

      {/* ---------------- 删除确认 ---------------- */}
      <ConfirmDialog
        open={deleteTarget !== null}
        danger
        title="删除证书站点"
        confirmText="删除"
        message={`将删除站点「${deleteTarget?.name ?? ""}」（${deleteTarget?.domain ?? ""}）的配置，之后的自动续期也会停止。已写入磁盘的证书文件不会被删除。`}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          const ok = await run(
            "delete",
            async () => {
              if (!deleteTarget) return "";
              const r = await certsApi.removeSite(deleteTarget.id);
              return r.detail;
            },
            "站点已删除",
          );
          if (ok) setDeleteTarget(null);
        }}
      />

      {/* ---------------- 清空日志确认 ---------------- */}
      <ConfirmDialog
        open={clearLogsOpen}
        danger
        title="清除部署日志"
        confirmText="清除"
        message="将删除全部证书申请与部署记录，此操作不可撤销。证书本身与站点配置不受影响。"
        onCancel={() => setClearLogsOpen(false)}
        onConfirm={async () => {
          const ok = await run(
            "clearLogs",
            async () => (await certsApi.clearLogs()).detail,
            "日志已清除",
          );
          if (ok) setClearLogsOpen(false);
        }}
      />
    </PageShell>
  );
}
