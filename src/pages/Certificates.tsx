/* ==========================================================================
   pvecenter — 证书管理（多厂商 / ACME 签发、部署、自动续期）

   页面按「巡检优先」组织：顶部一条状态行回答"多少正常、多少要处理"，
   中间是站点表格（有效期进度、最近运行、重试倒计时），展开某一行可以看到
   续期流水线每一步的结果。腾讯云密钥收进折叠卡，首屏只留巡检信息。
   ========================================================================== */

import { Fragment, useMemo, useState } from "react";
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
  IconClock,
  IconSearch,
  IconChevronDown,
  IconTerminal,
  IconCopy,
} from "../components/Icons";
import { useToast } from "../hooks/useToast";
import { useRefreshInterval } from "../hooks/useRefreshInterval";
import { useAuth } from "../hooks/useAuth";
import { PagerBar, usePaged } from "../hooks/usePaged";
import { isRunning } from "../utils/status";
import { formatDate, formatDateTime, formatRelative } from "../utils/format";
import { useT, type MessageKey, type TFunc } from "../i18n";
import { CertTargetsEditor } from "../components/CertTargetsEditor";
import { CertProvidersCard } from "../components/CertProvidersCard";
import type {
  CertInventoryItem,
  CertSite,
  CertTarget,
  CertTemplate,
  RemoteCertificate,
} from "../api/types";

const ACTION_LABEL: Record<string, MessageKey> = {
  apply: 'cert.act.apply',
  renew: 'cert.act.renew',
  deploy: 'cert.act.deploy',
  bind: 'cert.act.bind',
  sync: 'cert.act.sync',
  cleanup: 'cert.act.cleanup',
};

const RESULT_META: Record<
  string,
  { label: MessageKey; variant: "success" | "warning" | "danger" | "info" }
> = {
  success: { label: 'cert.result.success', variant: "success" },
  pending: { label: 'cert.result.pending', variant: "info" },
  failed: { label: 'cert.result.failed', variant: "danger" },
};

/** 流水线步骤 -> 文案。新增步骤时这里补一行，页面不用改结构。 */
const STEP_LABEL: Record<string, MessageKey> = {
  guard: 'cert.step.guard',
  prepare: 'cert.step.prepare',
  sync: 'cert.step.sync',
  decide: 'cert.step.decide',
  warn: 'cert.step.warn',
  issue: 'cert.step.issue',
  deploy: 'cert.step.deploy',
  drop: 'cert.step.drop',
  notice: 'cert.step.notice',
};

const STEP_STATUS: Record<string, MessageKey> = {
  ok: 'cert.stepStatus.ok',
  skipped: 'cert.stepStatus.skipped',
  failed: 'cert.stepStatus.failed',
};

/* ---- 运行日志：把 last_run 的逐步结果摊成一行一条日志 -------------------
   表格里那一版是「扫一眼」的时间轴（单行、会省略），排障时要看的是完整文本，
   所以另给一份日志视图：带相对耗时、整段说明不截断、能整段复制。 */

interface RunLogLine {
  /** 相对本次运行开始的偏移，如 +0.34s */
  at: string;
  name: string;
  status: string;
  ms: string;
  detail: string;
  tone: "ok" | "skipped" | "failed";
}

function runLogLines(site: CertSite, t: TFunc): RunLogLine[] {
  return (site.last_run ?? []).map((step) => ({
    at: typeof step.at === "number" ? `+${(step.at / 1000).toFixed(2)}s` : "—",
    name: STEP_LABEL[step.step] ? t(STEP_LABEL[step.step]) : step.step,
    status: STEP_STATUS[step.status] ? t(STEP_STATUS[step.status]) : step.status,
    ms: step.ms ? `${step.ms} ms` : "",
    detail: step.detail || "",
    tone: step.status,
  }));
}

/** 复制用的纯文本日志：抬头 + 每一步 + 最后的错误（如果有） */
function runLogText(site: CertSite, t: TFunc): string {
  const head = t("cert.runLogHead", {
    site: site.name || site.domain,
    domain: site.domain,
    time: site.last_run_at ? formatDateTime(site.last_run_at) : "—",
    status: STEP_STATUS[site.last_run_status || ""]
      ? t(STEP_STATUS[site.last_run_status || ""])
      : site.last_run_status || "—",
  });
  const lines = runLogLines(site, t).map((line) =>
    [`[${line.at}]`, line.name, line.status, line.ms, line.detail]
      .filter(Boolean)
      .join(" · "),
  );
  if (site.last_error) lines.push(`${t("cert.runLogError")}：${site.last_error}`);
  return [head, ...lines].join("\n");
}

type Filter = "all" | "due" | "failed" | "paused";

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
    auto_delete_old: true,
    renew_before_days: 0,
    enabled: true,
    notes: "",
    ca: "tencent",
    domains: [],
    acme_challenge: "dns",
    acme_webroot: "",
    acme_dns_provider: "",
    targets: [],
    monitor_enabled: false,
    monitor_url: "",
  };
}

/** 把表单里的「主目标」字段与附加目标合成 targets 数组再提交。 */
function buildSitePayload(form: Partial<CertSite>): Partial<CertSite> {
  const existing = (form.targets ?? [])[0] ?? {};
  const primary: CertTarget = {
    ...existing,
    id: existing.id || "primary",
    method: (form.deploy_method || "local") as CertTarget["method"],
    deploy_dir: form.deploy_dir,
    cert_filename: form.cert_filename,
    key_filename: form.key_filename,
    reload_command: form.reload_command,
    ssh_host: form.ssh_host,
    ssh_port: form.ssh_port,
    ssh_user: form.ssh_user,
    ssh_auth: form.ssh_auth,
    ssh_password: form.ssh_password,
    ssh_key: form.ssh_key,
    agent_node: form.agent_node,
    agent_vmid: form.agent_vmid,
  };
  return { ...form, targets: [primary, ...(form.targets ?? []).slice(1)] };
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
  if (site.deploy_method === "pve") {
    return t('cert.targetPve', { node: site.agent_node || "?" });
  }
  return t('cert.targetLocal', { dir });
}

/** 站点健康度：一条规则决定排序、筛选与色带，避免三处各写一遍。 */
function siteTone(site: CertSite): "danger" | "warning" | "ok" | "muted" {
  if (!site.enabled) return "muted";
  const left = site.days_left;
  const threshold = site.renew_before_days_effective ?? 15;
  if (site.last_run_status === "failed" || (site.attempt_count ?? 0) > 0) return "danger";
  if (left !== null && left !== undefined && left <= threshold) return "warning";
  return "ok";
}

function isDue(site: CertSite): boolean {
  const left = site.days_left;
  if (left === null || left === undefined) return false;
  return left <= (site.renew_before_days_effective ?? 15);
}

export function Certificates() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { hasPermission } = useAuth();
  const canManage = hasPermission("cert.manage");

  /** 多站点绑定：清单里选中的证书 + 勾选的站点 */
  const [bindCert, setBindCert] = useState<CertInventoryItem | null>(null);
  const [bindSites, setBindSites] = useState<string[]>([]);
  const [importTarget, setImportTarget] = useState<CertSite | null>(null);
  const [importPem, setImportPem] = useState("");
  const [importKey, setImportKey] = useState("");
  const [form, setForm] = useState<Partial<CertSite> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CertSite | null>(null);
  const [clearLogsOpen, setClearLogsOpen] = useState(false);
  const [pickerSite, setPickerSite] = useState<CertSite | null>(null);
  const [remote, setRemote] = useState<RemoteCertificate[] | null>(null);
  const [remoteSearch, setRemoteSearch] = useState("");
  const [busy, setBusy] = useState("");
  /** 展开的行：一次只展开一个，避免表格被切成碎片 */
  const [expanded, setExpanded] = useState("");
  /** 打开「运行日志」弹窗的站点（null = 关闭） */
  const [runLogSite, setRunLogSite] = useState<CertSite | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  /* 轮询间隔跟「设置 → 面板设置 → 数据刷新间隔」走（见 useRefreshInterval） */
  const refresh = useRefreshInterval();
  const query = useQuery({
    queryKey: ["certs"],
    queryFn: certsApi.get,
    refetchInterval: refresh,
    retry: false,
  });

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
  const providers = query.data?.providers ?? [];
  const inventory: CertInventoryItem[] = query.data?.inventory ?? [];
  // 证书按用户隔离：腾讯云密钥、站点、日志都归属到使用者；管理员可见全部
  const ownUsername = String(query.data?.own_username ?? "");
  const isAdmin = !!query.data?.is_admin;
  /** 别人的站点：管理员可查看但只读（操作一律用站点归属者的密钥） */
  const isForeign = (site: CertSite) =>
    isAdmin && !!site.username && String(site.username) !== ownUsername;

  /* ---- 巡检快照 ---- */
  const stats = useMemo(() => {
    let ok = 0, due = 0, failed = 0, paused = 0;
    for (const site of sites) {
      if (!site.enabled) { paused += 1; continue; }
      const tone = siteTone(site);
      if (tone === "danger") failed += 1;
      else if (tone === "warning") due += 1;
      else ok += 1;
    }
    return { ok, due, failed, paused };
  }, [sites]);

  const lastSynced = useMemo(() => {
    const stamps = sites.map((s) => Number(s.last_check_at || 0)).filter(Boolean);
    return stamps.length ? Math.max(...stamps) : 0;
  }, [sites]);

  /** 列表顺序即优先级：要处理的在前，其次快到期的 */
  const visible = useMemo(() => {
    const kw = search.trim().toLowerCase();
    const matches = sites.filter((site) => {
      if (kw) {
        const hay = `${site.name} ${site.domain} ${site.username || ""}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      if (filter === "due") return site.enabled && isDue(site);
      if (filter === "failed") return site.enabled && siteTone(site) === "danger";
      if (filter === "paused") return !site.enabled;
      return true;
    });
    const rank = { danger: 0, warning: 1, ok: 2, muted: 3 } as const;
    return matches.sort((a, b) => {
      const diff = rank[siteTone(a)] - rank[siteTone(b)];
      if (diff !== 0) return diff;
      const la = a.days_left ?? Number.MAX_SAFE_INTEGER;
      const lb = b.days_left ?? Number.MAX_SAFE_INTEGER;
      return la - lb;
    });
  }, [sites, search, filter]);

  /* ---- 分页：三张表各自分页，筛选条件一变就回到第 1 页 ---- */
  const sitePager = usePaged(visible, `${filter}|${search}`);
  const inventoryPager = usePaged(inventory, "inventory");
  const logPager = usePaged(logs, "logs");

  /* ---- 签发渠道凭据（腾讯云 / 阿里云 / 华为云，同一套接口） ---- */
  async function saveProvider(
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const ok = await run(
      "provider:" + kind,
      async () => {
        await certsApi.saveProvider(kind, payload);
        return t('cert.providerSaved');
      },
      t('cert.configSaved'),
    );
    if (!ok) return false;

    /* ACME 没有可自检的接口（要知道证书能不能签，得真去申请一次），跳过 */
    if (providers.find((item) => item.kind === kind)?.test_disabled) return true;

    /* 保存后立刻自检一次：凭据错在添加时就说清楚，不要等第一次申请证书才炸 */
    const toastId = toast.loading(t('cert.testingConnection'));
    try {
      const result = await certsApi.testProvider(kind);
      toast.update(toastId, {
        type: "success",
        title: t('cert.connectionOk'),
        message: result.detail,
        persistent: false,
        loading: false,
      });
    } catch (err) {
      toast.update(toastId, {
        type: "warning",
        title: t('cert.testFailed'),
        message: errText(err),
        persistent: false,
        loading: false,
      });
    }
    return true;
  }

  function testProvider(kind: string) {
    void run(
      "provider-test:" + kind,
      async () => (await certsApi.testProvider(kind)).detail,
      t('cert.connectionOk'),
    );
  }

  /* ---- 多站点绑定：一张证书一次写到多个站点 ---- */
  function openBind(cert: CertInventoryItem) {
    setBindCert(cert);
    setBindSites(cert.sites.map((site) => site.id));
  }

  function submitBind() {
    if (!bindCert) return;
    void run(
      "inventory-bind",
      async () => {
        const result = await certsApi.bindInventory({
          provider: bindCert.provider,
          cert_id: bindCert.cert_id,
          site_ids: bindSites,
        });
        setBindCert(null);
        setBindSites([]);
        return result.skipped.length
          ? t('cert.inventoryBoundSkipped', {
              n: result.bound,
              skipped: result.skipped.length,
            })
          : result.detail;
      },
      t('cert.inventoryBindOk'),
    );
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
        const payload = buildSitePayload(form);
        if (isNew) {
          await certsApi.createSite(payload);
        } else if (form.id) {
          await certsApi.updateSite(form.id, payload);
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

  /* ---- 托管证书（上传自己签好的 PEM/KEY） ---- */
  function submitImport() {
    if (!importTarget) return;
    void run(
      "import:" + importTarget.id,
      async () => {
        const result = await certsApi.importCertificate(
          importTarget.id,
          importPem,
          importKey,
        );
        setImportTarget(null);
        setImportPem("");
        setImportKey("");
        return result.detail;
      },
      t('cert.importDone'),
    );
  }

  /* ---- 站点模板 ---- */
  function applyTemplate(templateId: string) {
    const template = (query.data?.templates ?? []).find((item) => item.id === templateId);
    if (!template || !form) return;
    const { id: _id, name: _name, ...rest } = template as CertTemplate;
    setForm({ ...form, ...rest });
  }

  /** 站点用哪家厂商的证书列表：非云厂商（ACME / 托管）回落到腾讯云，仅用于选择已有证书 */
  function cloudKind(site: CertSite | null): string {
    const kinds = query.data?.options?.provider_kinds ?? [];
    const kind = String(site?.ca || "");
    return kinds.includes(kind) ? kind : kinds[0] || "tencent";
  }

  function loadRemote() {
    const kind = cloudKind(pickerSite);
    void run(
      "remote",
      async () => {
        const r = await certsApi.remoteCerts(kind, remoteSearch);
        setRemote(r.certificates);
        return t('cert.fetchedCerts', { n: r.count });
      },
      t('cert.remoteListTitle'),
    );
  }

  function bindRemote(cert: RemoteCertificate) {
    if (!pickerSite) return;
    const kind = cloudKind(pickerSite);
    void run(
      "bind",
      async () => {
        await certsApi.bind(pickerSite.id, cert.cert_id, kind);
        setPickerSite(null);
        setRemote(null);
        return t('cert.boundCert', { id: cert.cert_id });
      },
      t('cert.bindDone'),
    );
  }

  const FILTERS: { id: Filter; label: MessageKey; count: number }[] = [
    { id: "all", label: 'cert.filterAll', count: sites.length },
    { id: "due", label: 'cert.filterDue', count: stats.due },
    { id: "failed", label: 'cert.filterFailed', count: stats.failed },
    { id: "paused", label: 'cert.filterPaused', count: stats.paused },
  ];

  /* 把日志整段塞进剪贴板：排障时更多人是要贴到工单 / 群里，而不是逐行抄 */
  async function copyRunLog() {
    if (!runLogSite) return;
    try {
      await navigator.clipboard.writeText(runLogText(runLogSite, t));
      toast.success(t('cert.runLogCopied'));
    } catch {
      toast.error(t('common.opFailed'), t('cert.runLogCopy'));
    }
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

      {/* ---------------- 巡检总览：先回答「多少正常、多少要处理」 ---------------- */}
      <div className="cert-overview">
        <div className="cert-overview-stats">
          <div className="cert-stat">
            <span className="cert-stat-label">
              <span className="cert-status-dot is-ok" aria-hidden="true" />
              {t('cert.statOk')}
            </span>
            <span className="cert-stat-value">{stats.ok}</span>
          </div>
          <div className="cert-stat">
            <span className="cert-stat-label">
              <span className="cert-status-dot is-warning" aria-hidden="true" />
              {t('cert.statDue')}
            </span>
            <span className="cert-stat-value">{stats.due}</span>
          </div>
          <div className="cert-stat">
            <span className="cert-stat-label">
              <span className="cert-status-dot is-danger" aria-hidden="true" />
              {t('cert.statFailed')}
            </span>
            <span className="cert-stat-value">{stats.failed}</span>
          </div>
          <div className="cert-stat">
            <span className="cert-stat-label">
              <span className="cert-status-dot is-muted" aria-hidden="true" />
              {t('cert.statPaused')}
            </span>
            <span className="cert-stat-value">{stats.paused}</span>
          </div>
        </div>
        <div className="cert-overview-meta">
          {lastSynced ? t('cert.statSynced', { time: formatRelative(lastSynced) }) : ""}
        </div>
      </div>

      {/* ---------------- 证书站点：页面主体，不折叠 ---------------- */}
      <Card className="cert-card-main" collapsible={false}>
        <CardHeader title={t('cert.sitesTitle')} icon={<IconShield size={16} />} />

        <div className="cert-toolbar">
          <div className="cert-search">
            <IconSearch size={14} />
            <input
              value={search}
              placeholder={t('cert.searchPlaceholder')}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={t('cert.searchPlaceholder')}
            />
          </div>
          <div className="cert-filters" role="tablist">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={filter === item.id}
                className={`cert-filter${filter === item.id ? " is-active" : ""}`}
                onClick={() => setFilter(item.id)}
              >
                {t(item.label)}
                <span className="cert-filter-count">{item.count}</span>
              </button>
            ))}
          </div>
        </div>

        {visible.length > 0 ? (
          <div className="table-container">
            <table className="table table-dense cert-table">
              <thead>
                <tr>
                  <th className="cert-col-site">{t('cert.colSite')}</th>
                  <th className="cert-col-expire">{t('cert.colExpire')}</th>
                  <th className="cert-col-target">{t('cert.colTarget')}</th>
                  <th className="cert-col-run">{t('cert.colRun')}</th>
                  <th className="cert-col-actions">{t('cert.colAction')}</th>
                </tr>
              </thead>
              <tbody>
                {sitePager.rows.map((site) => {
                  const left = site.days_left;
                  const tone = siteTone(site);
                  const readonly = isForeign(site);
                  const open = expanded === site.id;
                  const pct =
                    left === null || left === undefined
                      ? null
                      : Math.max(0, Math.min(100, Math.round((left / 90) * 100)));
                  const nextAt = Number(site.next_attempt_at || 0);
                  const nowSec = Math.floor(Date.now() / 1000);
                  const retryIn =
                    nextAt > nowSec ? Math.max(1, Math.round((nextAt - nowSec) / 60)) : 0;
                  const runStatus = site.last_run_status;
                  return (
                    <Fragment key={site.id}>
                      <tr className={open ? "is-expanded" : undefined}>
                        <td className="cert-col-site">
                          <div className="cert-site-head">
                            <span className="cert-site-name">{site.name || site.domain}</span>
                            {isAdmin ? (
                              <Badge variant={readonly ? "neutral" : "success"} size="sm">
                                {site.username || ownUsername || "-"}
                              </Badge>
                            ) : null}
                            {/* 只标异常：正常站点不需要每行挂一枚「已开启」 */}
                            {!site.enabled ? (
                              <Badge variant="neutral" size="sm">
                                {t('cert.disabledSite')}
                              </Badge>
                            ) : null}
                            {!site.auto_renew ? (
                              <Badge variant="warning" size="sm" dot>
                                {t('cert.autoRenewOff')}
                              </Badge>
                            ) : null}
                          </div>
                          <div className="cert-site-domain mono" title={site.domain}>
                            {site.domain}
                          </div>
                          {site.notes ? (
                            <div className="cert-site-note" title={site.notes}>
                              {site.notes}
                            </div>
                          ) : null}
                        </td>
                        <td className="cert-col-expire">
                          {left === null || left === undefined ? (
                            <span className="text-muted">—</span>
                          ) : (
                            <div className="cert-expiry">
                              <span className={`cert-days is-${tone}`}>
                                {left < 0
                                  ? t('cert.expiredDays', { n: -left })
                                  : t('cert.daysLeft', { n: left })}
                              </span>
                              {pct !== null ? (
                                <span
                                  className={`cert-bar is-${tone}`}
                                  role="progressbar"
                                  aria-valuenow={left}
                                  aria-valuemin={0}
                                  aria-valuemax={90}
                                >
                                  <span style={{ width: `${pct}%` }} />
                                </span>
                              ) : null}
                              <span className="cert-expiry-date">
                                {formatDate(site.expire_at)}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="cert-col-target">
                          <div className="cert-target mono">{targetText(site, t)}</div>
                          <div className="cert-sub mono">
                            {site.cert_filename} · {site.key_filename}
                          </div>
                          {site.last_deploy_at ? (
                            <div className="cert-sub">
                              {t('cert.lastDeploy', {
                                time: formatRelative(site.last_deploy_at),
                              })}
                            </div>
                          ) : null}
                        </td>
                        <td className="cert-col-run">
                          <div className="cert-run">
                            <span className={`cert-run-pill is-${runStatus || "none"}`}>
                              {runStatus === "failed"
                                ? t('cert.stepStatus.failed')
                                : runStatus === "ok"
                                  ? t('cert.stepStatus.ok')
                                  : "—"}
                            </span>
                            <span className="cert-run-time">
                              {site.last_run_at ? formatRelative(site.last_run_at) : ""}
                            </span>
                          </div>
                          {retryIn > 0 ? (
                            <div className="cert-run-note is-warning">
                              {t('cert.retryInMin', { n: retryIn })}
                            </div>
                          ) : null}
                          {(site.attempt_count ?? 0) > 0 ? (
                            <div className="cert-run-note is-danger">
                              {t('cert.attempts', { n: site.attempt_count ?? 0 })}
                            </div>
                          ) : null}
                        </td>
                        <td className="cert-col-actions">
                          <div className="cert-actions">
                            <div className="cert-actions-group">
                            <IconButton
                              label={
                                readonly
                                  ? t('cert.readonlyForeign')
                                  : site.ca === "upload"
                                    ? t('cert.uploadOnly')
                                    : t('cert.applyOrRenew')
                              }
                              disabled={
                                !canManage ||
                                readonly ||
                                site.ca === "upload" ||
                                busy === "apply:" + site.id
                              }
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
                            </div>
                            <span className="cert-actions-sep" aria-hidden="true" />
                            <div className="cert-actions-group">
                              <IconButton
                                label={readonly ? t('cert.readonlyForeign') : t('cert.editSite')}
                                disabled={!canManage || readonly}
                                onClick={() => openEdit(site)}
                              >
                                <IconEdit size={15} />
                              </IconButton>
                              <IconButton
                                variant="danger"
                                label={
                                  readonly ? t('cert.readonlyForeign') : t('cert.deleteSite')
                                }
                                disabled={!canManage || readonly}
                                onClick={() => setDeleteTarget(site)}
                              >
                                <IconTrash size={15} />
                              </IconButton>
                            </div>
                            <span className="cert-actions-sep" aria-hidden="true" />
                            <button
                              type="button"
                              className={`cert-expand${open ? " is-open" : ""}`}
                              aria-expanded={open}
                              aria-label={open ? t('cert.collapseRun') : t('cert.expandRun')}
                              title={t('cert.expandHint')}
                              onClick={() => setExpanded(open ? "" : site.id)}
                            >
                              <IconChevronDown size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {open ? (
                        <tr className="cert-detail-row">
                          <td colSpan={5}>
                            <div className="cert-detail">
                              <div className="cert-detail-main">
                                <div className="cert-detail-head">
                                  <span className="cert-detail-title">{t('cert.runTitle')}</span>
                                  <span className="fs-xs text-muted">
                                    {site.last_run_at
                                      ? t('cert.runAt', { time: formatDateTime(site.last_run_at) })
                                      : ""}
                                  </span>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="cert-runlog-btn"
                                    icon={<IconTerminal size={14} />}
                                    onClick={() => setRunLogSite(site)}
                                  >
                                    {t('cert.runLog')}
                                  </Button>
                                </div>
                                {(site.last_run ?? []).length > 0 ? (
                                  <ol className="cert-steps">
                                    {(site.last_run ?? []).map((step) => (
                                      <li
                                        key={step.step}
                                        className={`cert-step is-${step.status}`}
                                      >
                                        <span className="cert-step-dot" aria-hidden="true" />
                                        <span className="cert-step-name">
                                          {STEP_LABEL[step.step] ? t(STEP_LABEL[step.step]) : step.step}
                                        </span>
                                        <span className="cert-step-status">
                                          {STEP_STATUS[step.status]
                                            ? t(STEP_STATUS[step.status])
                                            : step.status}
                                        </span>
                                        {step.detail ? (
                                          <span className="cert-step-detail" title={step.detail}>
                                            {step.detail}
                                          </span>
                                        ) : null}
                                        {step.ms ? (
                                          <span className="cert-step-ms">{step.ms} ms</span>
                                        ) : null}
                                      </li>
                                    ))}
                                  </ol>
                                ) : (
                                  <div className="fs-xs text-muted">{t('cert.runEmpty')}</div>
                                )}
                              </div>

                              <aside className="cert-detail-side">
                                <div className="cert-kv">
                                  <span>{t('cert.fieldCa')}</span>
                                  <span>{site.ca_label || site.ca || "tencent"}</span>
                                </div>
                                <div className="cert-kv">
                                  <span>{t('cert.colAutoRenew')}</span>
                                  <span>
                                    {site.auto_renew
                                      ? t('cert.autoRenewOn')
                                      : t('cert.autoRenewOff')}
                                  </span>
                                </div>
                                <div className="cert-kv">
                                  <span>{t('cert.certIds')}</span>
                                  <span className="mono">
                                    {site.cert_id || t('cert.notApplied')}
                                  </span>
                                </div>
                                {site.pending_cert_id ? (
                                  <div className="cert-kv">
                                    <span>{t('cert.pendingId')}</span>
                                    <span className="mono text-accent">
                                      {site.pending_cert_id}
                                    </span>
                                  </div>
                                ) : null}
                                <div className="cert-kv">
                                  <span>{t('cert.deployTo')}</span>
                                  <span className="mono">{targetText(site, t)}</span>
                                </div>
                                {nextAt > 0 && nextAt <= nowSec ? (
                                  <div className="cert-kv">
                                    <span>{t('cert.colRun')}</span>
                                    <span className="text-warning">{t('cert.retryInMin', { n: 1 })}</span>
                                  </div>
                                ) : null}
                                {site.last_error ? (
                                  <div className="cert-detail-error">{site.last_error}</div>
                                ) : null}
                                {/* 窄屏放不下行内动作图标，操作收进展开区 */}
                                <div className="cert-detail-actions cert-detail-actions-touch">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    icon={<IconShield size={14} />}
                                    disabled={
                                      !canManage ||
                                      readonly ||
                                      site.ca === "upload" ||
                                      busy === "apply:" + site.id
                                    }
                                    onClick={() => applyCert(site)}
                                  >
                                    {t('cert.applyOrRenew')}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    icon={<IconDownload size={14} />}
                                    disabled={!canManage || readonly}
                                    onClick={() => deployCert(site)}
                                  >
                                    {t('cert.deployNow')}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    icon={<IconRefresh size={14} />}
                                    disabled={!canManage || readonly}
                                    onClick={() => syncCert(site)}
                                  >
                                    {t('cert.syncStatusBtn')}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    icon={<IconEdit size={14} />}
                                    disabled={!canManage || readonly}
                                    onClick={() => openEdit(site)}
                                  >
                                    {t('cert.editSite')}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="cert-danger-text"
                                    icon={<IconTrash size={14} />}
                                    disabled={!canManage || readonly}
                                    onClick={() => setDeleteTarget(site)}
                                  >
                                    {t('cert.deleteSite')}
                                  </Button>
                                </div>
                                {site.ca === "upload" ? (
                                  <div className="cert-detail-actions">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      icon={<IconDownload size={14} />}
                                      disabled={!canManage || readonly}
                                      onClick={() => {
                                        setImportTarget(site);
                                        setImportPem("");
                                        setImportKey("");
                                      }}
                                    >
                                      {t('cert.uploadCert')}
                                    </Button>
                                  </div>
                                ) : null}
                              </aside>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="cert-empty">
            {sites.length > 0 ? t('cert.noMatchSites') : t('cert.noSites')}
          </div>
        )}
        {visible.length > 0 ? <PagerBar pager={sitePager} /> : null}
      </Card>

      {/* ---------------- 辅助区：清单 / 渠道 / 日志 ---------------- */}
      <div className="cert-section-stack">
        {/* ---------------- 证书清单（一张证书绑了哪些站点） ---------------- */}
        <Card className="cert-card-sub">
          <CardHeader
            title={t('cert.inventoryTitle')}
            subtitle={t('cert.inventoryDesc')}
            icon={<IconShield size={16} />}
          />
          {inventory.length ? (
            <div className="table-container">
              <table className="table table-dense cert-inventory-table">
                <thead>
                  <tr>
                    <th className="cert-col-cert">{t('cert.inventoryColCert')}</th>
                    <th className="cert-col-domains">{t('cert.inventoryColDomains')}</th>
                    <th className="cert-col-expire">{t('cert.colExpire')}</th>
                    <th className="cert-col-sites">{t('cert.inventoryColSites')}</th>
                    <th className="cert-col-actions">{t('cert.colAction')}</th>
                  </tr>
                </thead>
                <tbody>
                  {inventoryPager.rows.map((item) => (
                    <tr key={`${item.username || ""}:${item.provider}:${item.cert_id}`}>
                      <td className="cert-col-cert">
                        <div className="cert-site-head">
                          <Badge variant="info" size="sm">
                            {item.provider_label}
                          </Badge>
                          <span className="mono cert-id">{item.cert_id}</span>
                        </div>
                      </td>
                      <td className="mono cert-col-domains">{item.domains.join(", ")}</td>
                      <td className="cert-col-expire">
                        <div className="cert-expiry">
                          {item.days_left !== null ? (
                            <>
                              <span className="cert-days is-ok">
                                {t('cert.daysLeft', { n: item.days_left })}
                              </span>
                              <span className="cert-expiry-date">
                                {item.expire_at ? formatDate(item.expire_at) : "—"}
                              </span>
                            </>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </div>
                      </td>
                      <td className="cert-col-sites">
                        {item.sites.map((site) => site.name || site.domain).join("、")}
                      </td>
                      <td className="cert-col-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canManage || item.pending}
                          onClick={() => openBind(item)}
                        >
                          {t('cert.inventoryBind')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="cert-empty">{t('cert.inventoryEmpty')}</div>
          )}
          {inventory.length ? <PagerBar pager={inventoryPager} /> : null}
        </Card>

        {/* ---------------- 签发渠道（一张卡 + 分段切换，字段由后端 schema 驱动） ---------------- */}
        <CertProvidersCard
          providers={providers}
          canManage={canManage}
          busy={busy}
          onSave={saveProvider}
          onTest={testProvider}
        />

        {/* ---------------- 操作日志 ---------------- */}
        <Card className="cert-card-sub">
          <CardHeader
            title={t('cert.logsTitle')}
            subtitle={
              logs.length > 0 ? t('cert.logsSubtitle', { n: logs.length }) : undefined
            }
            icon={<IconClock size={16} />}
            actions={
              <Button
                variant="ghost"
                size="sm"
                className="cert-danger-text"
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
              <table className="table table-dense cert-log-table">
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
                  {logPager.rows.map((log) => {
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
            <div className="cert-empty">{t('cert.noLogs')}</div>
          )}
          {logs.length > 0 ? <PagerBar pager={logPager} /> : null}
        </Card>
      </div>

      {/* ---------------- 运行日志（逐步结果 → 可复制的完整日志） ---------------- */}
      <Modal
        open={runLogSite !== null}
        title={t('cert.runLog')}
        description={
          runLogSite
            ? t('cert.runLogHead', {
                site: runLogSite.name || runLogSite.domain,
                domain: runLogSite.domain,
                time: runLogSite.last_run_at
                  ? formatDateTime(runLogSite.last_run_at)
                  : '—',
                status: STEP_STATUS[runLogSite.last_run_status || '']
                  ? t(STEP_STATUS[runLogSite.last_run_status || ''])
                  : runLogSite.last_run_status || '—',
              })
            : undefined
        }
        size="lg"
        onClose={() => setRunLogSite(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRunLogSite(null)}>
              {t('common.close')}
            </Button>
            <Button
              variant="primary"
              icon={<IconCopy size={14} />}
              disabled={!runLogSite || (runLogSite.last_run ?? []).length === 0}
              onClick={copyRunLog}
            >
              {t('cert.runLogCopy')}
            </Button>
          </>
        }
      >
        {runLogSite ? (
          (runLogSite.last_run ?? []).length > 0 ? (
            <>
              <div className="log-viewer cert-runlog">
                {runLogLines(runLogSite, t).map((line, index) => (
                  <div key={index} className={`cert-runlog-line is-${line.tone}`}>
                    <span className="cert-runlog-at">{line.at}</span>
                    <span className="cert-runlog-name">{line.name}</span>
                    <span className="cert-runlog-status">{line.status}</span>
                    <span className="cert-runlog-ms">{line.ms}</span>
                    <span className="cert-runlog-detail">{line.detail}</span>
                  </div>
                ))}
              </div>
              {/* 失败步骤的说明里通常已经带着同一段错误，不再重复一遍 */}
              {runLogSite.last_error &&
              !(runLogSite.last_run ?? []).some((step) =>
                (step.detail || '').includes(runLogSite.last_error as string),
              ) ? (
                <div className="cert-detail-error mt-8">{runLogSite.last_error}</div>
              ) : null}
            </>
          ) : (
            <div className="fs-sm text-secondary">{t('cert.runEmpty')}</div>
          )
        ) : null}
      </Modal>

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
            {isNew && (query.data?.templates ?? []).length > 0 ? (
              <Select
                label={t('cert.fieldTemplate')}
                value=""
                options={[
                  { value: "", label: t('cert.templateNone') },
                  ...(query.data?.templates ?? []).map((template) => ({
                    value: template.id,
                    label: template.name,
                  })),
                ]}
                hint={t('cert.templateHint')}
                onChange={(e) => applyTemplate(e.target.value)}
              />
            ) : null}
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
              label={t('cert.fieldCa')}
              value={form.ca || "tencent"}
              options={options?.cas ?? []}
              hint={
                form.ca === "upload"
                  ? t('cert.caHintUpload')
                  : form.ca === "acme"
                    ? t('cert.caHintAcme')
                    : form.ca === "tencent"
                      ? t('cert.caHintTencent')
                      : t('cert.caHintProvider')
              }
              onChange={(e) => setForm({ ...form, ca: e.target.value as CertSite["ca"] })}
            />
            {form.ca === "acme" ? (
              <>
                <Input
                  label={t('cert.fieldExtraDomains')}
                  value={(form.domains ?? []).join(", ")}
                  placeholder="www.example.com, *.example.com"
                  className="mono"
                  hint={t('cert.extraDomainsHint')}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      domains: e.target.value
                        .split(/[,;\s]+/)
                        .map((v) => v.trim())
                        .filter(Boolean),
                    })
                  }
                />
                <Select
                  label={t('cert.fieldAcmeChallenge')}
                  value={form.acme_challenge || "dns"}
                  options={options?.acme_challenges ?? []}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      acme_challenge: e.target.value as CertSite["acme_challenge"],
                    })
                  }
                />
                {form.acme_challenge === "http" ? (
                  <Input
                    label={t('cert.fieldAcmeWebroot')}
                    value={form.acme_webroot || ""}
                    placeholder="/var/www/html"
                    className="mono"
                    hint={t('cert.acmeWebrootHint')}
                    onChange={(e) => setForm({ ...form, acme_webroot: e.target.value })}
                  />
                ) : (
                  <Select
                    label={t('cert.fieldAcmeDnsProvider')}
                    value={form.acme_dns_provider || ""}
                    options={[
                      { value: "", label: t('cert.acmeFollowAccount') },
                      ...(options?.dns_providers ?? []),
                    ]}
                    hint={t('cert.acmeDnsProviderHint')}
                    onChange={(e) =>
                      setForm({ ...form, acme_dns_provider: e.target.value })
                    }
                  />
                )}
              </>
            ) : null}
            <Select
              label={t('cert.fieldDeployMethod')}
              value={form.deploy_method || "local"}
              options={options?.deploy_methods ?? []}
              hint={
                form.deploy_method === "local"
                  ? t('cert.deployHintLocal')
                  : form.deploy_method === "ssh"
                    ? t('cert.deployHintSsh')
                    : form.deploy_method === "agent"
                      ? t('cert.deployHintAgent')
                      : form.deploy_method === "lxc"
                        ? t('cert.deployHintLxc')
                        : t('cert.deployHintPve')
              }
              onChange={(e) =>
                setForm({ ...form, deploy_method: e.target.value as CertSite["deploy_method"] })
              }
            />
            {form.deploy_method === "local" && query.data?.local_deploy_hint ? (
              <div style={{ gridColumn: "1 / -1" }}>
                <Notice tone="warning">{query.data.local_deploy_hint}</Notice>
              </div>
            ) : null}
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
            {form.deploy_method === "lxc" ? (
              <>
                <Input
                  label={t('cert.fieldNode')}
                  required
                  value={form.agent_node || ""}
                  placeholder="pve"
                  className="mono"
                  onChange={(e) => setForm({ ...form, agent_node: e.target.value })}
                />
                <Input
                  label={t('cert.fieldCtId')}
                  required
                  value={form.agent_vmid || ""}
                  placeholder="101"
                  className="mono"
                  onChange={(e) => setForm({ ...form, agent_vmid: e.target.value })}
                />
                <Input
                  label={t('cert.fieldSshHost')}
                  required
                  value={form.ssh_host || ""}
                  placeholder="10.0.0.10"
                  className="mono"
                  hint={t('cert.nodeHostHint')}
                  onChange={(e) => setForm({ ...form, ssh_host: e.target.value })}
                />
                <Input
                  label={t('cert.fieldSshUser')}
                  value={form.ssh_user || "root"}
                  className="mono"
                  onChange={(e) => setForm({ ...form, ssh_user: e.target.value })}
                />
                <Input
                  label={t('cert.fieldSshPassword')}
                  type="password"
                  autoComplete="new-password"
                  value={form.ssh_password || ""}
                  placeholder={form.ssh_password_set ? t('cert.secretPlaceholderSet') : ""}
                  onChange={(e) => setForm({ ...form, ssh_password: e.target.value })}
                />
              </>
            ) : null}
            {form.deploy_method === "pve" ? (
              <Input
                label={t('cert.fieldNode')}
                required
                value={form.agent_node || ""}
                placeholder="pve1"
                className="mono"
                hint={t('cert.pveNodeHint')}
                onChange={(e) => setForm({ ...form, agent_node: e.target.value })}
              />
            ) : null}
            {form.deploy_method !== "pve" ? (
              <>
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
              </>
            ) : null}
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
                checked={form.auto_delete_old !== false}
                label={t('cert.autoDeleteOld')}
                hint={t('cert.autoDeleteOldHint')}
                onChange={(v) => setForm({ ...form, auto_delete_old: v })}
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
            <CertTargetsEditor
              targets={(form.targets ?? []).slice(1)}
              methods={options?.deploy_methods ?? []}
              disabled={!canManage}
              onChange={(extra) =>
                setForm({
                  ...form,
                  targets: [(form.targets ?? [])[0] ?? {}, ...extra],
                })
              }
            />
            <div className="field">
              <Switch
                checked={!!form.monitor_enabled}
                label={t('cert.monitorSwitch')}
                hint={t('cert.monitorSwitchHint')}
                onChange={(v) => setForm({ ...form, monitor_enabled: v })}
              />
            </div>
            {form.monitor_enabled ? (
              <Input
                label={t('cert.fieldMonitorUrl')}
                value={form.monitor_url || ""}
                placeholder={`https://${form.domain || "example.com"}`}
                className="mono"
                hint={t('cert.monitorUrlHint')}
                onChange={(e) => setForm({ ...form, monitor_url: e.target.value })}
              />
            ) : null}
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

      {/* ---------------- 上传托管证书（PEM / 私钥） ---------------- */}
      <Modal
        open={importTarget !== null}
        title={t('cert.importTitle')}
        description={t('cert.importDesc')}
        size="lg"
        onClose={() => setImportTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setImportTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              icon={<IconDownload size={14} />}
              loading={
                importTarget !== null && busy === "import:" + importTarget.id
              }
              disabled={!importPem.trim() || !importKey.trim()}
              onClick={submitImport}
            >
              {t('cert.uploadCert')}
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <Textarea
            label={t('cert.fieldPem')}
            required
            mono
            rows={8}
            value={importPem}
            placeholder={t('cert.pemPlaceholder')}
            hint={t('cert.importHint')}
            onChange={(e) => setImportPem(e.target.value)}
          />
          <Textarea
            label={t('cert.fieldKeyPem')}
            required
            mono
            rows={6}
            value={importKey}
            placeholder={t('cert.keyPemPlaceholder')}
            onChange={(e) => setImportKey(e.target.value)}
          />
        </div>
      </Modal>

      {/* ---------------- 多站点绑定（一张证书绑到多个站点） ---------------- */}
      <Modal
        open={bindCert !== null}
        title={t('cert.inventoryBindTitle')}
        description={
          bindCert ? t('cert.inventoryBindDesc', { id: bindCert.cert_id }) : undefined
        }
        size="lg"
        onClose={() => {
          setBindCert(null);
          setBindSites([]);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setBindCert(null);
                setBindSites([]);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy === "inventory-bind"}
              disabled={bindSites.length === 0}
              onClick={submitBind}
            >
              {t('cert.inventoryBindConfirm')}
            </Button>
          </>
        }
      >
        <div className="fs-xs text-muted" style={{ marginBottom: 8 }}>
          {t('cert.inventoryBindHint')}
        </div>
        {bindCert?.domains?.length ? (
          <div className="fs-xs text-muted mono" style={{ marginBottom: 8 }}>
            {t('cert.inventoryBindCovered', { domains: bindCert.domains.join(", ") })}
          </div>
        ) : null}
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          {sites
            .filter((site) => !isForeign(site))
            .map((site) => (
              <label
                key={site.id}
                className="flex items-center gap-8 fs-sm"
                style={{ padding: "6px 0" }}
              >
                <input
                  type="checkbox"
                  checked={bindSites.includes(site.id)}
                  onChange={(e) =>
                    setBindSites(
                      e.target.checked
                        ? [...bindSites, site.id]
                        : bindSites.filter((id) => id !== site.id),
                    )
                  }
                />
                <span>{site.name || site.domain}</span>
                <span className="mono fs-xs text-muted">{site.domain}</span>
                {site.cert_id && site.cert_id !== bindCert?.cert_id ? (
                  <span className="fs-xs text-warning">
                    {t('cert.inventoryBindReplace')}
                  </span>
                ) : null}
              </label>
            ))}
        </div>
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
