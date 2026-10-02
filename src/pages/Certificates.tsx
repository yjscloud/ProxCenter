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
import { useT, type MessageKey, type TFunc } from "../i18n";
import type { CertSite, RemoteCertificate } from "../api/types";

const ACTION_LABEL: Record<string, MessageKey> = {
  apply: 'cert.act.apply',
  renew: 'cert.act.renew',
  deploy: 'cert.act.deploy',
  bind: 'cert.act.bind',
  sync: 'cert.act.sync',
};

const RESULT_META: Record<
  string,
  { label: MessageKey; variant: "success" | "warning" | "danger" | "info" }
> = {
  success: { label: 'cert.result.success', variant: "success" },
  pending: { label: 'cert.result.pending', variant: "info" },
  failed: { label: 'cert.result.failed', variant: "danger" },
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
function targetText(site: CertSite, t: TFunc): string {
  const dir = site.deploy_dir || "";
  if (site.deploy_method === "ssh") {
    return `${site.ssh_user || "root"}@${site.ssh_host || "?"}:${site.ssh_port || 22}${dir}`;
  }
  if (site.deploy_method === "agent") {
    return `VM ${site.agent_vmid || "?"}@${site.agent_node || "?"}${dir}`;
  }
  return t('cert.targetLocal', { dir });
}

export function Certificates() {
  const t = useT();
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
        label: t('cert.agentOption', { name: vm.name, vmid: vm.vmid, node: vm.node }),
        value: `${vm.node}|${vm.vmid}`,
      }));
    if (agentValue && !vms.some((o) => o.value === agentValue)) {
      return [
        { label: t('cert.agentNotRunning', { value: agentValue }), value: agentValue },
        ...vms,
      ];
    }
    return vms;
  }, [vmsQuery.data, agentValue, t]);

  async function run(key: string, fn: () => Promise<string>, okTitle: string): Promise<boolean> {
    setBusy(key);
    try {
      const note = await fn();
      await qc.invalidateQueries({ queryKey: ["certs"] });
      toast.success(okTitle, note || undefined);
      return true;
    } catch (err) {
      toast.error(t('common.opFailed'), errText(err));
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
        return t('cert.tcSaved');
      },
      t('cert.configSaved'),
    );
  }

  function testTencent() {
    void run("test", async () => (await certsApi.testTencent()).detail, t('cert.connectionOk'));
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
        return t('cert.siteSaved');
      },
      t('cert.saveOk'),
    );
  }

  function applyCert(site: CertSite) {
    void run(
      "apply:" + site.id,
      async () => (await certsApi.apply(site.id)).detail,
      t('cert.applySubmitted'),
    );
  }

  function deployCert(site: CertSite) {
    void run(
      "deploy:" + site.id,
      async () => (await certsApi.deploy(site.id)).detail,
      t('cert.deployDone'),
    );
  }

  function syncCert(site: CertSite) {
    void run(
      "sync:" + site.id,
      async () => {
        const s = (await certsApi.sync(site.id)).site;
        return t('cert.syncStatus', { status: s.cert_status_text || t('common.unknown') }) +
          (s.days_left !== null && s.days_left !== undefined
            ? t('cert.syncDays', { n: s.days_left })
            : "");
      },
      t('cert.synced'),
    );
  }

  function loadRemote() {
    void run(
      "remote",
      async () => {
        const r = await certsApi.remoteList(remoteSearch);
        setRemote(r.certificates);
        return t('cert.fetchedCerts', { n: r.count });
      },
      t('cert.remoteListTitle'),
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
        return t('cert.boundCert', { id: cert.cert_id });
      },
      t('cert.bindDone'),
    );
  }

  return (
    <PageShell
      title={t('cert.title')}
      subtitle={t('cert.subtitle')}
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
                  return t('cert.syncedSites', { n: r.sites.length });
                },
                t('cert.syncAllDone'),
              )
            }
          >
            {t('cert.syncAll')}
          </Button>
          <Button
            variant="primary"
            icon={<IconPlus size={15} />}
            disabled={!canManage}
            onClick={openCreate}
          >
            {t('cert.addSite')}
          </Button>
        </>
      }
    >
      {query.isError ? (
        <Notice tone="danger" title={t('cert.loadFailed')}>
          {errText(query.error)}
        </Notice>
      ) : null}

      {/* ---------------- 腾讯云账号 ---------------- */}
      <Card>
        <CardHeader
          title={t('cert.tcTitle')}
          subtitle={t('cert.tcSubtitle')}
          icon={<IconCloud size={16} />}
          actions={
            <>
              <Badge variant={secretSet ? "success" : "neutral"} size="sm" dot>
                <span className="flex items-center gap-4">
                  <IconKey size={12} />
                  {secretSet ? t('cert.secretSet') : t('cert.secretUnset')}
                </span>
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                loading={busy === "test"}
                disabled={!canManage || !secretSet}
                onClick={testTencent}
              >
                {t('cert.testConnection')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<IconSave size={14} />}
                loading={busy === "tc"}
                disabled={!canManage || tc === null}
                onClick={saveTencent}
              >
                {t('common.save')}
              </Button>
            </>
          }
        />
        {tc ? (
          <div className="form-grid">
            <Input
              label={t('cert.fieldSecretId')}
              value={tc.secret_id || ""}
              placeholder="AKIDxxxxxxxxxxxxxxxx"
              autoComplete="off"
              className="mono"
              disabled={!canManage}
              onChange={(e) => setTc({ ...tc, secret_id: e.target.value })}
            />
            <Input
              label={t('cert.fieldSecretKey')}
              type="password"
              value={secretInput}
              placeholder={
                secretSet ? t('cert.secretPlaceholderSet') : t('cert.secretPlaceholder')
              }
              autoComplete="new-password"
              disabled={!canManage}
              hint={
                secretClear
                  ? t('cert.secretHintClear')
                  : secretSet
                    ? t('cert.secretHintSet')
                    : t('cert.secretHintUnset')
              }
              onChange={(e) => {
                setSecretClear(false);
                setSecretInput(e.target.value);
              }}
            />
            <Select
              label={t('cert.fieldDvAuth')}
              value={tc.dv_auth_method || "DNS_AUTO"}
              disabled={!canManage}
              options={options?.dv_auth_methods ?? []}
              onChange={(e) => setTc({ ...tc, dv_auth_method: e.target.value })}
            />
            <Select
              label={t('cert.fieldEncryptAlgo')}
              value={tc.encrypt_algo || "RSA"}
              disabled={!canManage}
              options={options?.encrypt_algos ?? []}
              onChange={(e) => setTc({ ...tc, encrypt_algo: e.target.value })}
            />
            <Input
              label={t('cert.fieldDefaultRenewDays')}
              type="number"
              value={tc.renew_before_days ?? 15}
              disabled={!canManage}
              hint={t('cert.defaultRenewDaysHint')}
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
          title={t('cert.sitesTitle')}
          subtitle={t('cert.sitesSubtitle')}
          icon={<IconShield size={16} />}
        />
        {sites.length > 0 ? (
          <div className="table-container">
            <table className="table table-dense">
              <thead>
                <tr>
                  {isAdmin ? <th>{t('cert.colOwner')}</th> : null}
                  <th>{t('cert.colSite')}</th>
                  <th>{t('cert.colDomain')}</th>
                  <th>{t('cert.colCert')}</th>
                  <th>{t('cert.colExpire')}</th>
                  <th>{t('cert.colTarget')}</th>
                  <th>{t('cert.colAutoRenew')}</th>
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
                          {site.enabled ? t('cert.enabledSite') : t('cert.disabledSite')}
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
                              {site.cert_status_text || t('cert.statusUnknown')}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted">{t('cert.notApplied')}</span>
                        )}
                        {site.pending_cert_id ? (
                          <div className="fs-xs text-accent">
                            {t('cert.pendingIssue', { id: site.pending_cert_id })}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {left === null || left === undefined ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <div>
                            <Badge variant={tone} size="sm" dot>
                              {left < 0
                                ? t('cert.expiredDays', { n: -left })
                                : t('cert.daysLeft', { n: left })}
                            </Badge>
                            <div className="fs-xs text-muted">
                              {formatDate(site.expire_at)}
                            </div>
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="mono fs-sm" style={{ wordBreak: "break-all" }}>
                          {targetText(site, t)}
                        </div>
                        <div className="fs-xs text-muted">
                          {site.cert_filename} · {site.key_filename}
                          {site.reload_command ? " · " + site.reload_command : ""}
                        </div>
                        {site.last_deploy_at ? (
                          <div className="fs-xs text-muted">
                            {t('cert.lastDeploy', {
                              time: formatRelative(site.last_deploy_at),
                            })}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <Badge
                          variant={site.auto_renew ? "success" : "neutral"}
                          size="sm"
                          dot
                        >
                          {site.auto_renew ? t('cert.autoRenewOn') : t('cert.autoRenewOff')}
                        </Badge>
                        <div className="fs-xs text-muted">
                          {t('cert.renewAhead', { n: threshold })}
                        </div>
                      </td>
                      <td>
                        <div className="flex items-center gap-4">
                          <IconButton
                            label={readonly ? t('cert.readonlyForeign') : t('cert.applyOrRenew')}
                            disabled={!canManage || readonly || busy === "apply:" + site.id}
                            onClick={() => applyCert(site)}
                          >
                            <IconShield size={15} />
                          </IconButton>
                          <IconButton
                            label={readonly ? t('cert.readonlyForeign') : t('cert.deployNow')}
                            disabled={!canManage || readonly || busy === "deploy:" + site.id}
                            onClick={() => deployCert(site)}
                          >
                            <IconDownload size={15} />
                          </IconButton>
                          <IconButton
                            label={readonly ? t('cert.readonlyForeign') : t('cert.syncStatusBtn')}
                            disabled={!canManage || readonly || busy === "sync:" + site.id}
                            onClick={() => syncCert(site)}
                          >
                            <IconRefresh size={15} />
                          </IconButton>
                          <IconButton
                            label={readonly ? t('cert.readonlyForeign') : t('cert.editSite')}
                            disabled={!canManage || readonly}
                            onClick={() => openEdit(site)}
                          >
                            <IconEdit size={15} />
                          </IconButton>
                          <IconButton
                            label={readonly ? t('cert.readonlyForeign') : t('cert.deleteSite')}
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
            {t('cert.noSites')}
          </div>
        )}
      </Card>

      {/* ---------------- 部署日志 ---------------- */}
      <Card>
        <CardHeader
          title={t('cert.logsTitle')}
          subtitle={
            logs.length > 0 ? t('cert.logsSubtitle', { n: logs.length }) : undefined
          }
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
              {t('cert.clearLogs')}
            </Button>
          }
        />
        {logs.length > 0 ? (
          <div className="table-container">
            <table className="table table-dense">
              <thead>
                <tr>
                  {isAdmin ? <th>{t('cert.colOwner')}</th> : null}
                  <th>{t('cert.colTime')}</th>
                  <th>{t('cert.colSite')}</th>
                  <th>{t('cert.colAction')}</th>
                  <th>{t('cert.colResult')}</th>
                  <th>{t('cert.colDetail')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const meta = RESULT_META[log.result] ?? {
                    label: log.result as MessageKey,
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
                      <td>
                        {ACTION_LABEL[log.action] ? t(ACTION_LABEL[log.action]) : log.action}
                      </td>
                      <td>
                        <Badge variant={meta.variant} size="sm" dot>
                          {RESULT_META[log.result] ? t(meta.label) : log.result}
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
          <div className="text-secondary fs-sm">{t('cert.noLogs')}</div>
        )}
      </Card>

      {/* ---------------- 站点编辑 ---------------- */}
      <Modal
        open={form !== null}
        title={isNew ? t('cert.addSiteTitle') : t('cert.editSiteTitle')}
        description={t('cert.editDesc')}
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
                {t('cert.chooseExisting')}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setForm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              icon={<IconSave size={14} />}
              loading={busy === "site"}
              onClick={saveSite}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        {form ? (
          <div className="form-grid">
            <Input
              label={t('cert.fieldSiteName')}
              value={form.name || ""}
              placeholder={t('cert.siteNamePlaceholder')}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Input
              label={t('cert.fieldDomain')}
              required
              value={form.domain || ""}
              placeholder="blog.example.com"
              className="mono"
              hint={t('cert.domainHint')}
              onChange={(e) => setForm({ ...form, domain: e.target.value })}
            />
            <Select
              label={t('cert.fieldDeployMethod')}
              value={form.deploy_method || "local"}
              options={options?.deploy_methods ?? []}
              hint={
                form.deploy_method === "local"
                  ? t('cert.deployHintLocal')
                  : form.deploy_method === "ssh"
                    ? t('cert.deployHintSsh')
                    : t('cert.deployHintAgent')
              }
              onChange={(e) =>
                setForm({ ...form, deploy_method: e.target.value as CertSite["deploy_method"] })
              }
            />
            {form.deploy_method === "ssh" ? (
              <>
                <Input
                  label={t('cert.fieldSshHost')}
                  required
                  value={form.ssh_host || ""}
                  placeholder={t('cert.sshHostPlaceholder')}
                  className="mono"
                  hint={t('cert.sshHostHint')}
                  onChange={(e) => setForm({ ...form, ssh_host: e.target.value })}
                />
                <Input
                  label={t('cert.fieldSshPort')}
                  type="number"
                  value={form.ssh_port ?? 22}
                  onChange={(e) => setForm({ ...form, ssh_port: Number(e.target.value) })}
                />
                <Input
                  label={t('cert.fieldSshUser')}
                  required
                  value={form.ssh_user || ""}
                  placeholder="root"
                  className="mono"
                  hint={t('cert.sshUserHint')}
                  onChange={(e) => setForm({ ...form, ssh_user: e.target.value })}
                />
                <Select
                  label={t('cert.fieldSshAuth')}
                  value={form.ssh_auth || "password"}
                  options={[
                    { value: "password", label: t('cert.authPassword') },
                    { value: "key", label: t('cert.authKey') },
                  ]}
                  onChange={(e) => setForm({ ...form, ssh_auth: e.target.value })}
                />
                {form.ssh_auth === "key" ? (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <Textarea
                      label={t('cert.fieldSshKey')}
                      rows={5}
                      mono
                      value={form.ssh_key || ""}
                      placeholder={
                        form.ssh_key_set
                          ? t('cert.sshKeyPlaceholderSet')
                          : "-----BEGIN OPENSSH PRIVATE KEY----- …"
                      }
                      hint={t('cert.sshKeyHint')}
                      onChange={(e) => setForm({ ...form, ssh_key: e.target.value })}
                    />
                  </div>
                ) : (
                  <Input
                    label={t('cert.fieldSshPassword')}
                    type="password"
                    value={form.ssh_password || ""}
                    placeholder={
                      form.ssh_password_set
                        ? t('cert.secretPlaceholderSet')
                        : t('cert.sshPasswordPlaceholder')
                    }
                    autoComplete="new-password"
                    hint={t('cert.sshPasswordHint')}
                    onChange={(e) => setForm({ ...form, ssh_password: e.target.value })}
                  />
                )}
                <div className="field">
                  <div className="field-label">{t('cert.fieldHostKey')}</div>
                  <div className="fs-xs text-muted mono" style={{ wordBreak: "break-all" }}>
                    {form.ssh_host_key || t('cert.hostKeyPlaceholder')}
                  </div>
                </div>
              </>
            ) : null}
            {form.deploy_method === "agent" ? (
              <Select
                label={t('cert.fieldAgentVm')}
                value={agentValue}
                placeholder={t('cert.agentVmPlaceholder')}
                options={agentOptions}
                hint={t('cert.agentVmHint')}
                onChange={(e) => {
                  const [node, vmid] = String(e.target.value).split("|");
                  setForm({ ...form, agent_node: node || "", agent_vmid: vmid || "" });
                }}
              />
            ) : null}
            <Input
              label={
                form.deploy_method === "local"
                  ? t('cert.fieldDeployDir')
                  : t('cert.fieldTargetDeployDir')
              }
              required
              value={form.deploy_dir || ""}
              placeholder={t('cert.deployDirPlaceholder')}
              className="mono"
              hint={
                form.deploy_method === "ssh"
                  ? t('cert.deployDirHintSsh')
                  : form.deploy_method === "agent"
                    ? t('cert.deployDirHintAgent')
                    : t('cert.deployDirHintLocal')
              }
              onChange={(e) => setForm({ ...form, deploy_dir: e.target.value })}
            />
            <Input
              label={t('cert.fieldCertFile')}
              value={form.cert_filename || ""}
              placeholder="fullchain.pem"
              className="mono"
              hint={t('cert.certFileHint')}
              onChange={(e) => setForm({ ...form, cert_filename: e.target.value })}
            />
            <Input
              label={t('cert.fieldKeyFile')}
              value={form.key_filename || ""}
              placeholder="privkey.pem"
              className="mono"
              hint={t('cert.keyFileHint')}
              onChange={(e) => setForm({ ...form, key_filename: e.target.value })}
            />
            <Input
              label={t('cert.fieldReloadCmd')}
              value={form.reload_command || ""}
              placeholder="nginx -s reload"
              className="mono"
              hint={
                form.deploy_method === "ssh"
                  ? t('cert.reloadCmdHintSsh')
                  : form.deploy_method === "agent"
                    ? t('cert.reloadCmdHintAgent')
                    : t('cert.reloadCmdHintLocal')
              }
              onChange={(e) => setForm({ ...form, reload_command: e.target.value })}
            />
            <Input
              label={t('cert.fieldRenewDays')}
              type="number"
              value={form.renew_before_days ?? 0}
              hint={t('cert.renewDaysHint')}
              onChange={(e) =>
                setForm({ ...form, renew_before_days: Number(e.target.value) })
              }
            />
            <Input
              label={t('incident.fieldNote')}
              value={form.notes || ""}
              placeholder={t('cert.notesPlaceholder')}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
            <div className="field">
              <Switch
                checked={form.auto_renew !== false}
                label={t('cert.autoRenewSwitch')}
                hint={t('cert.autoRenewSwitchHint')}
                onChange={(v) => setForm({ ...form, auto_renew: v })}
              />
            </div>
            <div className="field">
              <Switch
                checked={form.enabled !== false}
                label={t('cert.enabledSwitch')}
                hint={t('cert.enabledSwitchHint')}
                onChange={(v) => setForm({ ...form, enabled: v })}
              />
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ---------------- 腾讯云证书选择 ---------------- */}
      <Modal
        open={pickerSite !== null}
        title={t('cert.pickerTitle')}
        description={
          pickerSite ? t('cert.pickerDesc', { name: pickerSite.name }) : undefined
        }
        size="lg"
        onClose={() => setPickerSite(null)}
        footer={
          <Button variant="secondary" onClick={() => setPickerSite(null)}>
            {t('common.close')}
          </Button>
        }
      >
        <div className="flex items-center gap-8">
          <Input
            value={remoteSearch}
            placeholder={t('cert.remoteSearchPlaceholder')}
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
            {t('cert.query')}
          </Button>
        </div>
        {remote && remote.length > 0 ? (
          <div className="table-container" style={{ marginTop: 12 }}>
            <table className="table table-dense">
              <thead>
                <tr>
                  <th>{t('cert.colDomain')}</th>
                  <th>{t('cert.colCertId')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('cert.colExpire')}</th>
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
                        {t('cert.bind')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-secondary fs-sm" style={{ marginTop: 12 }}>
            {remote ? t('cert.noMatchCerts') : t('cert.clickQuery')}
          </div>
        )}
      </Modal>

      {/* ---------------- 删除确认 ---------------- */}
      <ConfirmDialog
        open={deleteTarget !== null}
        danger
        title={t('cert.deleteTitle')}
        confirmText={t('common.delete')}
        message={t('cert.deleteMessage', {
          name: deleteTarget?.name ?? "",
          domain: deleteTarget?.domain ?? "",
        })}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          const ok = await run(
            "delete",
            async () => {
              if (!deleteTarget) return "";
              const r = await certsApi.removeSite(deleteTarget.id);
              return r.detail;
            },
            t('cert.siteDeleted'),
          );
          if (ok) setDeleteTarget(null);
        }}
      />

      {/* ---------------- 清空日志确认 ---------------- */}
      <ConfirmDialog
        open={clearLogsOpen}
        danger
        title={t('cert.clearLogsTitle')}
        confirmText={t('cert.clearLogsConfirm')}
        message={t('cert.clearLogsMessage')}
        onCancel={() => setClearLogsOpen(false)}
        onConfirm={async () => {
          const ok = await run(
            "clearLogs",
            async () => (await certsApi.clearLogs()).detail,
            t('cert.logsCleared'),
          );
          if (ok) setClearLogsOpen(false);
        }}
      />
    </PageShell>
  );
}
