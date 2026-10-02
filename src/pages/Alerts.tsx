import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { alertsApi, exportUrl, nodesApi, vmsApi } from "../api/endpoints";
import { PageShell } from "../components/Layout";
import { Card, CardHeader } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button, IconButton } from "../components/ui/Button";
import { Field, Input, Switch, Textarea } from "../components/ui/Input";
import { Notice } from "../components/ui/EmptyState";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import {
  IconAlert,
  IconBell,
  IconPlus,
  IconTrash,
  IconRefresh,
  IconSave,
  IconCheck,
  IconClose,
  IconCpu,
  IconMemory,
  IconDisk,
  IconClock,
  IconKey,
  IconPlug,
  IconPower,
  IconBackup,
  IconDownload,
  IconChat,
  IconFilter,
  IconMail,
} from "../components/Icons";
import { useSectionSpy } from "../hooks/useSectionSpy";
import { useSiteInfo } from "../hooks/useSiteInfo";
import { tStatic, useT, type TFunc } from "../i18n";
import { formatRelative, usageColor } from "../utils/format";
import { isRunning } from "../utils/status";
import type {
  AlertEmailConfig,
  AlertRule,
  AlertWebhookConfig,
} from "../api/types";

/**
 * 指标定义：label 在组件内取词（切语言即时生效），因此做成接收 t 的工厂函数，
 * 不能提到模块级常量（那会让文案停在首次加载时的语言上）。
 */
function metricOptions(t: TFunc) {
  return [
    { value: "cpu", label: t("alerts.metric.cpu"), icon: <IconCpu size={14} /> },
    { value: "mem", label: t("alerts.metric.mem"), icon: <IconMemory size={14} /> },
    { value: "disk", label: t("alerts.metric.disk"), icon: <IconDisk size={14} /> },
    { value: "offline", label: t("alerts.metric.offline"), icon: <IconPower size={14} /> },
    { value: "backup", label: t("alerts.metric.backup"), icon: <IconBackup size={14} /> },
  ];
}

/**
 * 状态型指标：它们不看阈值，只看「状态是否偏离预期」。
 * 配规则时应当隐藏阈值输入 —— 让用户填一个用不上的百分比只会造成困惑。
 */
const STATE_METRICS = new Set(["offline", "backup"]);

const isStateMetric = (metric: string) => STATE_METRICS.has(metric);

/* ---------------------------------------------------------------------------
   页内区块导航
   ---------------------------------------------------------------------------
   这一页也是「分区多、每个都不短」的长页面，因此用与「系统设置」同一套写法：
   顶部一条吸顶的区块条（layout.css 的 .page-index），正文按分组铺开往下排。

   id 与下面 .page-block 的 id 一一对应；前缀见 SECTION_PREFIX。
   --------------------------------------------------------------------------- */

const SECTION_PREFIX = "alert-";

/** 分组键：与下面 section.group 对应，文案在组件内取词 */
type SectionGroup = "channels" | "records";

function newRule(): AlertRule {
  return {
    // 同一毫秒内连续新增两条会撞 id，加随机后缀避免被后端按 id 合并
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: tStatic("alerts.newRuleName"),
    target_type: "node",
    target: "*",
    metric: "cpu",
    threshold: 80,
    enabled: true,
  };
}

function toText(note: unknown, fallback: string): string {
  if (typeof note === "string" && note) return note;
  if (note && typeof note === "object") {
    try {
      return JSON.stringify(note);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function Alerts() {
  const t = useT();
  const qc = useQueryClient();

  /* 区块导航、分组说明与指标定义：文案随语言走，所以在组件内构造 */
  const sections = useMemo(
    () => [
      {
        id: "notify",
        group: "channels" as SectionGroup,
        label: t("alerts.secNotify"),
        icon: <IconBell size={15} />,
      },
      {
        id: "channels",
        group: "channels" as SectionGroup,
        label: t("alerts.secChannels"),
        icon: <IconChat size={15} />,
      },
      {
        id: "email",
        group: "channels" as SectionGroup,
        label: t("alerts.secEmail"),
        icon: <IconMail size={15} />,
      },
      {
        id: "rules",
        group: "records" as SectionGroup,
        label: t("alerts.secRules"),
        icon: <IconFilter size={15} />,
      },
      {
        id: "history",
        group: "records" as SectionGroup,
        label: t("alerts.secHistory"),
        icon: <IconClock size={15} />,
      },
    ],
    [t],
  );
  const groupDesc = useMemo<Record<SectionGroup, string>>(
    () => ({
      channels: t("alerts.groupChannelsDesc"),
      records: t("alerts.groupRecordsDesc"),
    }),
    [t],
  );
  const metrics = useMemo(() => metricOptions(t), [t]);
  const metricMap = useMemo(
    () => Object.fromEntries(metrics.map((m) => [m.value, m])),
    [metrics],
  );
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [feishu, setFeishu] = useState<Record<string, any> | null>(null);
  const [emailCfg, setEmailCfg] = useState<AlertEmailConfig | null>(null);
  const [hook, setHook] = useState<AlertWebhookConfig | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  // 输入框留空表示"不修改"，因此清除动作需要显式标记
  const [webhookClear, setWebhookClear] = useState(false);
  const [secretClear, setSecretClear] = useState(false);
  // 通用 Webhook 的清除标记，与飞书的相互独立（两个通道各存各的）
  const [hookWebhookClear, setHookWebhookClear] = useState(false);
  const [hookSecretClear, setHookSecretClear] = useState(false);
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);

  const query = useQuery({
    queryKey: ["alerts"],
    queryFn: alertsApi.get,
    refetchInterval: 15000,
    retry: false,
  });

  const nodesQuery = useQuery({
    queryKey: ["nodes"],
    queryFn: nodesApi.list,
    staleTime: 60_000,
  });

  const vmsQuery = useQuery({
    queryKey: ["vms", "all"],
    queryFn: () => vmsApi.list(),
    refetchInterval: 15_000,
  });

  /* 面板名称：告警卡片标题留空时用它（见后端 alerting.resolve_title_brand），
     这里只拿来当输入框的 placeholder，让人一眼看到「不填会是什么」 */
  const site = useSiteInfo();
  /* 标题预览：与后端同一口径 —— 填了用填的，留空用面板名称 */
  const titleBrand = String(feishu?.title || "").trim() || site.name;
  const [activeSection, setActiveSection] = useSectionSpy(
    sections.map((item) => item.id),
    { prefix: SECTION_PREFIX },
  );
  function goSection(id: string) {
    setActiveSection(id);
    document
      .getElementById(`${SECTION_PREFIX}${id}`)
      ?.scrollIntoView({ block: "start" });
  }

  // 目标下拉选项：宿主机取节点名；虚拟机只列运行中的（取值用 VMID，
  // 集群内唯一，避免同名虚拟机造成歧义），「全部」表示监控所有对象。
  const targetOptions = useMemo(() => {
    const all = [{ label: t("alerts.all"), value: "*" }];
    return {
      node: [
        ...all,
        ...(nodesQuery.data ?? []).map((n) => ({ label: n.node, value: n.node })),
      ],
      vm: [
        ...all,
        ...(vmsQuery.data ?? [])
          .filter((vm) => isRunning(vm.status) && !vm.template)
          .map((vm) => ({
            label: `${vm.name}（VMID ${vm.vmid}）`,
            value: String(vm.vmid),
          })),
      ],
    };
  }, [nodesQuery.data, vmsQuery.data, t]);

  useEffect(() => {
    if (!query.data) return;
    if (rules === null) setRules(query.data.rules ?? []);
    if (feishu === null) setFeishu(query.data.feishu ?? {});
    if (emailCfg === null) {
      setEmailCfg(query.data.email ?? { enabled: false, recipients: '' });
    }
    if (hook === null) {
      setHook(
        query.data.hook ?? {
          enabled: false,
          cooldown: 600,
          template: '',
          headers: '',
        },
      );
    }
  }, [query.data, rules, feishu, emailCfg, hook]);

  async function run(key: string, fn: () => Promise<unknown>, ok: string): Promise<boolean> {
    setBusy(key);
    setMsg(null);
    try {
      const note = await fn();
      await qc.invalidateQueries({ queryKey: ["alerts"] });
      setMsg({ tone: "success", text: toText(note, ok) });
      return true;
    } catch (err) {
      const detail = (err as any)?.response?.data?.detail;
      setMsg({ tone: "danger", text: detail ? String(detail) : String(err) });
      return false;
    } finally {
      setBusy("");
    }
  }

  async function saveFeishu() {
    if (!feishu) return;
    const ok = await run(
      "fs",
      () =>
        alertsApi.saveFeishu({
          ...feishu,
          webhook_clear: webhookClear,
          secret_clear: secretClear,
        }),
      t("alerts.notifySaved"),
    );
    if (!ok) return;
    setWebhookClear(false);
    setSecretClear(false);
    setFeishu((f) => (f ? { ...f, webhook: "", secret: "" } : f));
  }

  async function saveEmail() {
    if (!emailCfg) return;
    await run(
      "mail",
      () => alertsApi.saveEmail(emailCfg),
      t("alerts.emailSaved"),
    );
  }

  async function sendTest() {
    await run(
      "test",
      async () => {
        await alertsApi.test();
        return t("alerts.testPushed");
      },
      t("alerts.sent"),
    );
  }

  async function saveHook() {
    if (!hook) return;
    const ok = await run(
      "hook",
      () =>
        alertsApi.saveWebhook({
          ...hook,
          webhook_clear: hookWebhookClear,
          secret_clear: hookSecretClear,
        }),
      t("alerts.hookSaved"),
    );
    if (!ok) return;
    setHookWebhookClear(false);
    setHookSecretClear(false);
    // 保存成功后清空输入框：地址与密钥只在填写时上送，后端不会回显
    setHook((h) => (h ? { ...h, webhook: "", secret: "" } : h));
  }

  async function sendHookTest() {
    await run(
      "hooktest",
      async () => {
        await alertsApi.test("webhook");
        return t("alerts.testRequestSent");
      },
      t("alerts.sent"),
    );
  }

  /** 一键套用预设请求体（企业微信 / 钉钉 / Slack / 通用 JSON） */
  function applyHookPreset(key: string) {
    const preset = query.data?.hook_presets?.[key];
    if (!preset || !hook) return;
    setHook({ ...hook, template: preset.template, headers: preset.headers });
  }

  /* 历史列表直接用服务端给的数据。
     来源被静默（停推）的告警不会再进这张表 —— 后端在写入口就整条丢弃了
     （见 alerting.record），所以这里既不需要过滤，也不用再解释「隐藏了几条」：
     静默期间就是干净的零条。 */
  const records = query.data?.history ?? [];
  // 告警按用户隔离：通知通道永远是自己那一份，管理员额外能看到全部规则与历史
  const ownUsername = String(query.data?.own_username ?? "");
  const isAdmin = !!query.data?.is_admin;
  /* 邮件通道是否可用的两个前提：全局 SMTP 配好了、自己填了（或有）收件地址 */
  const mailReady = !!query.data?.mail_ready;
  const accountEmail = String(query.data?.account_email ?? "");
  /** 别人的规则：管理员可查看但只读（保存只会写回自己名下的规则） */
  const isForeign = (rule: AlertRule) =>
    isAdmin && !!rule.username && String(rule.username) !== ownUsername;
  const secretSet: boolean = !!query.data?.secret_set;
  const webhookSet: boolean = !!query.data?.webhook_set;
  const webhookMasked: string = String(query.data?.webhook_masked ?? "");
  /* 通用 Webhook 的状态（与飞书那组各算各的：两个通道互相独立） */
  const hookSet: boolean = !!query.data?.hook_set;
  const hookMasked: string = String(query.data?.hook_masked ?? "");
  const hookSecretSet: boolean = !!query.data?.hook_secret_set;
  const recoveryCount = records.filter((r) => r.kind === "recovery").length;
  const alarmCount = records.length - recoveryCount;
  const failCount = records.filter((r) => r.result !== "sent").length;

  /* 「正在告警」与「历史条数」是两个数，混着看必然误会（「50 条待处理」里有
     一大半是早就恢复了的旧记录）。所以副标题把两者并列写出来：前者是还没解决
     的对象数（首页待办同口径，已排除静默来源），后者是这段时间发生过多少事。 */
  const activeAlarms = query.data?.active ?? [];
  const activeTargets = new Set(
    activeAlarms.map((a) => String(a.target || "")).filter(Boolean),
  );
  const historySubtitle = [
    activeTargets.size > 0 ? t("alerts.activeObjects", { n: activeTargets.size }) : "",
    records.length > 0 ? t("alerts.totalRecords", { n: records.length }) : "",
    records.length > 0 ? t("alerts.alarmCount", { n: alarmCount }) : "",
    records.length > 0 ? t("alerts.recoveryCount", { n: recoveryCount }) : "",
    failCount > 0 ? t("alerts.failedCount", { n: failCount }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  async function clearHistory() {
    const ok = await run(
      "clear",
      async () => (await alertsApi.clearHistory()).detail,
      t("alerts.historyCleared"),
    );
    if (ok) setClearHistoryOpen(false);
  }

  function patch(index: number, next: Partial<AlertRule>) {
    setRules((list) => (list ? list.map((r, i) => (i === index ? { ...r, ...next } : r)) : list));
  }

  /**
   * 「目标」下拉的选项。历史规则里的目标可能已经不在当前列表中
   * （虚拟机被关机 / 删除），此时补一条「已不在列表」的选项，
   * 避免下拉框静默变成空白导致规则看起来无故失效。
   */
  function targetSelectOptions(rule: AlertRule) {
    const list = targetOptions[rule.target_type === "vm" ? "vm" : "node"];
    if (list.some((o) => o.value === rule.target)) return list;
    return [{ label: t("alerts.notInList", { name: rule.target }), value: rule.target }, ...list];
  }

  /* ---- 推送来源开关（全局，管理员）----
     直接读查询结果，不另开一份本地 state：开关是「点一下立即生效」的动作，
     本地副本只会多出一份可能与服务端不一致的真相。 */
  const notifySources = query.data?.notify_sources ?? [];
  const notifyEnabled = query.data?.notify_enabled ?? {};
  const mutedSources = notifySources.filter(
    (item) => notifyEnabled[item.id] === false,
  );

  async function toggleNotifySource(id: string, next: boolean) {
    const label = notifySources.find((item) => item.id === id)?.label ?? id;
    setBusy(`notify:${id}`);
    setMsg(null);
    try {
      await alertsApi.saveNotifySources({ [id]: next });
      await qc.invalidateQueries({ queryKey: ["alerts"] });
      setMsg({
        tone: "success",
        text: next
          ? t("alerts.notifyResumed", { label })
          : t("alerts.notifyMuted", { label }),
      });
    } catch (err) {
      const detail = (err as any)?.response?.data?.detail;
      setMsg({ tone: "danger", text: detail ? String(detail) : String(err) });
    } finally {
      setBusy("");
    }
  }

  return (
    <PageShell
      title={t("alerts.title")}
      subtitle={t("alerts.subtitle")}
      actions={
        <>
          {/* 导出走服务端流式 CSV：本页只展示最近 80 条，导出取全量历史。
              归属隔离与页面一致 —— 普通用户只会导出自己名下的告警。 */}
          <Button
            variant="secondary"
            icon={<IconDownload size={15} />}
            onClick={() => window.open(exportUrl("alerts"), "_blank")}
            title={t("alerts.exportTitle")}
          >
            {t("alerts.exportHistory")}
          </Button>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => void query.refetch()}
          >
            {t("common.refresh")}
          </Button>
          <Button
            variant="primary"
            icon={<IconAlert size={15} />}
            loading={busy === "check"}
            onClick={() =>
              void run(
                "check",
                async () => {
                  const r = await alertsApi.check();
                  return t("alerts.checkDoneCount", { n: r.count });
                },
                t("alerts.checkDone"),
              )
            }
          >
            {t("alerts.checkNow")}
          </Button>
        </>
      }
    >
      {msg ? (
        <Notice
          tone={msg.tone === "danger" ? "danger" : "success"}
          title={msg.tone === "danger" ? t("common.opFailed") : t("alerts.opSuccess")}
        >
          {msg.text}
        </Notice>
      ) : null}

      {/* 停推是最危险的静默失败：出事了却没人收到通知。所以在页面顶端持续提醒，
          而不是只让开关自己显示成灰色 —— 那张卡可能在屏幕外。
          措辞要说全「也不记录」：否则用户会以为历史里还能翻到，实际上这些告警
          连库都不会进（见 alerting.record），事后是真的查不到。 */}
      {mutedSources.length > 0 ? (
        <Notice tone="warning" title={t("alerts.partialMuted")}>
          {t("alerts.mutedNotice", {
            sources: mutedSources.map((item) => item.label).join("、"),
          })}
        </Notice>
      ) : null}

      {/* 区块导航：点一下跳到对应分区，滚动时高亮当前所在分区（见 useSectionSpy） */}
      <nav className="page-index" aria-label={t("alerts.pageAria")}>
        {sections.map((item, index) => (
          <Fragment key={item.id}>
            {/* 分组之间一道竖线：吸顶条只有一行高，再挂分组标题会把它撑成两行 */}
            {index > 0 && sections[index - 1].group !== item.group ? (
              <span className="page-index-sep" aria-hidden="true" />
            ) : null}
            <a
              href={`#${SECTION_PREFIX}${item.id}`}
              className={`page-index-item${
                item.id === activeSection ? " is-active" : ""
              }`}
              aria-current={item.id === activeSection ? "true" : undefined}
              title={groupDesc[item.group]}
              onClick={(event) => {
                /* 当页跳转：别让浏览器把它当成换页 */
                event.preventDefault();
                goSection(item.id);
              }}
            >
              {item.icon}
              {item.label}
            </a>
          </Fragment>
        ))}
      </nav>

      <header className="page-section-head">
        <h2 className="page-section-title">{t("alerts.groupChannels")}</h2>
        <p className="page-section-desc">{groupDesc.channels}</p>
      </header>

      {/* 推送来源开关：管「发不发」，与下面几张通道卡（管「往哪发」）正交 */}
      <Card className="page-block" id={`${SECTION_PREFIX}notify`}>
        <CardHeader
          title={t("alerts.notifyTitle")}
          subtitle={t("alerts.notifySubtitle")}
          icon={<IconBell size={16} />}
        />
        <div className="grid grid-auto-320">
          {notifySources.map((item) => {
            const on = notifyEnabled[item.id] !== false;
            return (
              <Switch
                key={item.id}
                checked={on}
                disabled={!isAdmin || busy === `notify:${item.id}`}
                onChange={(value) => void toggleNotifySource(item.id, value)}
                label={item.label}
                hint={
                  on
                    ? item.description
                    : t("alerts.mutedSuffix", { desc: item.description })
                }
              />
            );
          })}
        </div>
        {!isAdmin ? (
          <Notice tone="info" title={t("alerts.readonly")}>
            {t("alerts.readonlyNotice")}
          </Notice>
        ) : null}
      </Card>

      {/* ---- 通知渠道 ----
          飞书机器人与通用 Webhook 是同一件事（把告警推到某个地方）的两种投递
          方式，所以配置放在一张卡片里。

          但它们在**机制上仍是两条独立通道**：飞书发的是官方交互式卡片、签名放在
          请求体里，走飞书自己的算法；通用 Webhook 发的是用户自定义模板、签名走
          X-Panel-Signature 头。合成「类型二选一」的单一渠道会丢掉「两处同时推送」
          的能力 —— 所以合并的是配置界面，不是投递链路。两个都开就都发。 */}
      <Card className="page-block" id={`${SECTION_PREFIX}channels`}>
        <CardHeader
          title={t("alerts.channelsTitle")}
          subtitle={t("alerts.channelsSubtitle")}
          icon={<IconAlert size={16} />}
        />

        <div className="alc-ch alc-ch--first">
          <span className="alc-ch-name">
            <IconChat size={15} />
            {t("alerts.feishuBot")}
          </span>
          {/* 只在被关掉时才亮出来：常态下挂一个「已启用」是纯噪音。
              注意飞书这条通道目前没有界面开关（enabled 默认 true），
              这里如实反映后端状态，为将来补开关留好位置。 */}
          {feishu && !feishu.enabled ? (
            <Badge variant="warning" size="sm" dot>
              {t("alerts.disabled")}
            </Badge>
          ) : null}
          <Badge variant={webhookSet ? "success" : "neutral"} size="sm" dot>
            <span className="flex items-center gap-4">
              <IconKey size={12} />
              {webhookSet ? t("alerts.webhookSaved") : t("alerts.webhookUnset")}
            </span>
          </Badge>
          <Badge variant={secretSet ? "success" : "neutral"} size="sm" dot>
            <span className="flex items-center gap-4">
              <IconKey size={12} />
              {secretSet ? t("alerts.signatureSet") : t("alerts.signatureUnset")}
            </span>
          </Badge>
          <div className="alc-ch-actions">
            <Button
              variant="ghost"
              size="sm"
              loading={busy === "test"}
              onClick={() => void sendTest()}
            >
              {t("alerts.sendTest")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy === "fs"}
              disabled={feishu === null}
              onClick={() => void saveFeishu()}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>

        {feishu ? (
          <div className="form-grid">
            <div className="field">
              <label className="field-label">{t("alerts.feishuWebhookLabel")}</label>
              <div className="input-wrap">
                <input
                  className="input"
                  value={feishu.webhook || ""}
                  placeholder={
                    webhookSet
                      ? t("alerts.keepAddress")
                      : "https://open.feishu.cn/open-apis/bot/v2/hook/..."
                  }
                  onChange={(e) => {
                    setWebhookClear(false);
                    setFeishu({ ...feishu, webhook: e.target.value });
                  }}
                />
                {webhookSet && !webhookClear ? (
                  <span className="input-suffix">
                    <IconButton
                      label={t("alerts.clearWebhook")}
                      variant="danger"
                      onClick={() => {
                        setWebhookClear(true);
                        setFeishu({ ...feishu, webhook: "" });
                      }}
                    >
                      <IconTrash size={14} />
                    </IconButton>
                  </span>
                ) : null}
              </div>
              <div className="field-message">
                {webhookClear ? (
                  <span className="text-danger">{t("alerts.clearWebhookWarn")}</span>
                ) : webhookSet ? (
                  <>
                    {t("alerts.storedCurrent")}
                    <span className="mono">{webhookMasked}</span>
                  </>
                ) : (
                  t("alerts.feishuWebhookHint")
                )}
              </div>
            </div>
            <div className="field">
              <label className="field-label">{t("alerts.secretLabel")}</label>
              <div className="input-wrap">
                <input
                  className="input"
                  type="password"
                  value={feishu.secret || ""}
                  placeholder={
                    secretSet ? t("alerts.secretPlaceholderSet") : t("alerts.secretPlaceholderFeishu")
                  }
                  onChange={(e) => {
                    setSecretClear(false);
                    setFeishu({ ...feishu, secret: e.target.value });
                  }}
                />
                {secretSet && !secretClear ? (
                  <span className="input-suffix">
                    <IconButton
                      label={t("alerts.clearSecret")}
                      variant="danger"
                      onClick={() => {
                        setSecretClear(true);
                        setFeishu({ ...feishu, secret: "" });
                      }}
                    >
                      <IconTrash size={14} />
                    </IconButton>
                  </span>
                ) : null}
              </div>
              <div className="field-message">
                {secretClear
                  ? t("alerts.clearSecretWarn")
                  : secretSet
                    ? t("alerts.secretHidden")
                    : t("alerts.secretFeishuHint")}
              </div>
            </div>
            <div className="field">
              <label className="field-label">{t("alerts.cooldownLabel")}</label>
              <div className="input-wrap">
                <input
                  className="input"
                  type="number"
                  value={feishu.cooldown || 600}
                  onChange={(e) =>
                    setFeishu({ ...feishu, cooldown: Number(e.target.value) })
                  }
                />
              </div>
            </div>
            {/* 卡片大标题默认写死产品名，这里让用户换成自己的叫法 */}
            <div className="field">
              <label className="field-label">{t("alerts.titleLabel")}</label>
              <div className="input-wrap">
                <input
                  className="input"
                  value={feishu.title || ""}
                  placeholder={site.name}
                  maxLength={32}
                  autoComplete="off"
                  onChange={(e) =>
                    setFeishu({ ...feishu, title: e.target.value })
                  }
                />
              </div>
              <div className="field-message">
                {t("alerts.titleHint", { brand: titleBrand })}
              </div>
            </div>
          </div>
        ) : (
          <div className="skeleton skeleton-text" />
        )}
        {/* ---- 通用 Webhook：一个通道覆盖企业微信 / 钉钉 / Slack / 自建接收端 ----
            这些渠道的差异只在请求体形状上，用「模板 + 占位符」表达即可，不必为
            每家写一遍发送代码。签名是面板自己的约定，见下面说明。 */}
        <div className="alc-ch">
          <span className="alc-ch-name">
            <IconPlug size={15} />
            {t("alerts.hookName")}
          </span>
          {hook && !hook.enabled ? (
            <Badge variant="warning" size="sm" dot>
              {t("alerts.disabled")}
            </Badge>
          ) : null}
          <Badge variant={hookSet ? "success" : "neutral"} size="sm" dot>
            <span className="flex items-center gap-4">
              <IconKey size={12} />
              {hookSet ? t("alerts.hookAddressSaved") : t("alerts.hookAddressUnset")}
            </span>
          </Badge>
          <Badge variant={hookSecretSet ? "success" : "neutral"} size="sm" dot>
            <span className="flex items-center gap-4">
              <IconKey size={12} />
              {hookSecretSet ? t("alerts.signatureSet") : t("alerts.signatureUnset")}
            </span>
          </Badge>
          <div className="alc-ch-actions">
            <Button
              variant="ghost"
              size="sm"
              loading={busy === "hooktest"}
              disabled={!hook?.enabled}
              onClick={() => void sendHookTest()}
            >
              {t("alerts.sendTest")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy === "hook"}
              disabled={hook === null}
              onClick={() => void saveHook()}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>

        {hook ? (
          <>
            <div className="form-grid">
              <div className="field">
                <label className="field-label">{t("alerts.hookAddressLabel")}</label>
                <div className="input-wrap">
                  <input
                    className="input"
                    value={hook.webhook || ""}
                    placeholder={
                      hookSet
                        ? t("alerts.keepAddress")
                        : "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
                    }
                    onChange={(e) => {
                      setHookWebhookClear(false);
                      setHook({ ...hook, webhook: e.target.value });
                    }}
                  />
                  {hookSet && !hookWebhookClear ? (
                    <span className="input-suffix">
                      <IconButton
                        label={t("alerts.clearHookAddress")}
                        variant="danger"
                        onClick={() => {
                          setHookWebhookClear(true);
                          setHook({ ...hook, webhook: "" });
                        }}
                      >
                        <IconTrash size={14} />
                      </IconButton>
                    </span>
                  ) : null}
                </div>
                <div className="field-message">
                  {hookWebhookClear ? (
                    <span className="text-danger">{t("alerts.clearHookAddressWarn")}</span>
                  ) : hookSet ? (
                    <>
                      {t("alerts.storedCurrent")}
                      <span className="mono">{hookMasked}</span>
                    </>
                  ) : (
                    t("alerts.hookAddressHint")
                  )}
                </div>
              </div>

              <div className="field">
                <label className="field-label">{t("alerts.secretLabel")}</label>
                <div className="input-wrap">
                  <input
                    className="input"
                    type="password"
                    value={hook.secret || ""}
                    placeholder={
                      hookSecretSet
                        ? t("alerts.secretPlaceholderSet")
                        : t("alerts.secretPlaceholderHook")
                    }
                    onChange={(e) => {
                      setHookSecretClear(false);
                      setHook({ ...hook, secret: e.target.value });
                    }}
                  />
                  {hookSecretSet && !hookSecretClear ? (
                    <span className="input-suffix">
                      <IconButton
                        label={t("alerts.clearSecret")}
                        variant="danger"
                        onClick={() => {
                          setHookSecretClear(true);
                          setHook({ ...hook, secret: "" });
                        }}
                      >
                        <IconTrash size={14} />
                      </IconButton>
                    </span>
                  ) : null}
                </div>
                <div className="field-message">
                  {hookSecretClear ? (
                    t("alerts.clearSecretWarn")
                  ) : hookSecretSet ? (
                    t("alerts.secretHidden")
                  ) : (
                    t("alerts.hookSignatureHint")
                  )}
                </div>
              </div>

              <div className="field">
                <label className="field-label">{t("alerts.cooldownLabel")}</label>
                <div className="input-wrap">
                  <input
                    className="input"
                    type="number"
                    value={hook.cooldown || 600}
                    onChange={(e) =>
                      setHook({ ...hook, cooldown: Number(e.target.value) })
                    }
                  />
                </div>
              </div>
            </div>

            <div className="mt-16">
              <Switch
                checked={hook.enabled}
                onChange={(v) => setHook({ ...hook, enabled: v })}
                label={t("alerts.enableHook")}
                hint={t("alerts.enableHookHint")}
              />
            </div>

            <div className="mt-16">
              <div className="flex items-center gap-8 flex-wrap">
                <span className="fs-sm fw-500">{t("alerts.templateLabel")}</span>
                {Object.entries(query.data?.hook_presets ?? {}).map(([key, preset]) => (
                  <Button
                    key={key}
                    variant="secondary"
                    size="sm"
                    onClick={() => applyHookPreset(key)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <div className="mt-8">
                <Textarea
                  value={hook.template}
                  rows={4}
                  mono
                  placeholder='{"msgtype":"markdown","markdown":{"content":"**{{title}}**\n{{text}}"}}'
                  onChange={(e) => setHook({ ...hook, template: e.target.value })}
                />
              </div>
              <div className="field-message">
                <div>{t("alerts.templateHint1")}</div>
                <div className="mt-4">
                  {t("alerts.placeholders")}
                  {(
                    query.data?.hook_placeholders ?? [
                      "title",
                      "text",
                      "level",
                      "target",
                      "metric",
                      "value",
                      "threshold",
                      "time",
                    ]
                  ).map((name) => (
                    <span key={name} className="mono fs-xs" style={{ marginRight: 8 }}>
                      {`{{${name}}}`}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-16">
              <Field
                label={t("alerts.extraHeaders")}
                hint={t("alerts.extraHeadersHint")}
              >
                <Textarea
                  value={hook.headers}
                  rows={2}
                  mono
                  placeholder='{"Authorization": "Bearer ..."}'
                  onChange={(e) => setHook({ ...hook, headers: e.target.value })}
                />
              </Field>
            </div>

            <div className="mt-16">
              <Notice tone="info" title={t("alerts.aboutSignature")}>
                {t("alerts.sigIntro")}
                <strong>{t("alerts.sigDingtalkStrong")}</strong>
                {t("alerts.sigOutro")}
              </Notice>
            </div>
          </>
        ) : (
          <div className="skeleton skeleton-text" />
        )}
      </Card>

      {/* ---- 邮件通道：与飞书并列的第二条通知路径，收件人按用户各自配置 ---- */}
      <Card className="page-block" id={`${SECTION_PREFIX}email`}>
        <CardHeader
          title={t("alerts.emailTitle")}
          subtitle={t("alerts.emailSubtitle")}
          icon={<IconBell size={16} />}
          actions={
            <>
              <Badge
                variant={mailReady ? "success" : "warning"}
                dot
                size="sm"
              >
                {mailReady ? t("alerts.smtpReady") : t("alerts.smtpUnset")}
              </Badge>
              <Button
                variant="primary"
                size="sm"
                icon={<IconSave size={14} />}
                loading={busy === "mail"}
                disabled={!emailCfg}
                onClick={() => void saveEmail()}
              >
                {t("common.save")}
              </Button>
            </>
          }
        />

        {!mailReady ? (
          <div className="mb-16">
            <Notice tone="warning" title={t("alerts.smtpMissingTitle")}>
              {t("alerts.smtpMissingBody")}
            </Notice>
          </div>
        ) : null}

        {emailCfg ? (
          <div className="flex flex-col gap-16">
            <Switch
              checked={emailCfg.enabled}
              onChange={(v) => setEmailCfg({ ...emailCfg, enabled: v })}
              label={t("alerts.enableEmail")}
              hint={t("alerts.enableEmailHint")}
            />
            <Field
              label={t("alerts.recipientsLabel")}
              hint={
                accountEmail
                  ? t("alerts.recipientsHintAccount", { email: accountEmail })
                  : t("alerts.recipientsHintNoAccount")
              }
            >
              <Input
                value={emailCfg.recipients}
                onChange={(e) =>
                  setEmailCfg({ ...emailCfg, recipients: e.target.value })
                }
                placeholder={t("alerts.recipientsPlaceholder")}
                mono
              />
            </Field>
          </div>
        ) : (
          <div className="skeleton skeleton-text" />
        )}
      </Card>

      <header className="page-section-head">
        <h2 className="page-section-title">{t("alerts.groupRecords")}</h2>
        <p className="page-section-desc">{groupDesc.records}</p>
      </header>

      <Card className="page-block" id={`${SECTION_PREFIX}rules`}>
        <CardHeader
          title={t("alerts.rulesTitle")}
          subtitle={
            isAdmin ? t("alerts.rulesSubtitleAdmin") : t("alerts.rulesSubtitleUser")
          }
          icon={<IconAlert size={16} />}
          actions={
            <>
              <Button
                variant="ghost"
                size="sm"
                icon={<IconPlus size={14} />}
                onClick={() => setRules([...(rules ?? []), newRule()])}
              >
                {t("alerts.addRule")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<IconSave size={14} />}
                loading={busy === "rules"}
                disabled={rules === null}
                onClick={() =>
                  rules &&
                  void run(
                    "rules",
                    async () => {
                      const res = await alertsApi.saveRules(rules);
                      // 后端会按 id 去重、认领归属，用返回结果刷新本地列表，
                      // 否则保存后界面仍显示旧数据（含历史重复项）
                      setRules(res.rules ?? []);
                    },
                    t("alerts.rulesSaved"),
                  )
                }
              >
                {t("alerts.saveRules")}
              </Button>
            </>
          }
        />
        {rules && rules.length > 0 ? (
          <div className="table-container">
            <table className="table table-dense">
              <thead>
                <tr>
                  {isAdmin ? <th>{t("alerts.colOwner")}</th> : null}
                  <th>{t("alerts.colRuleName")}</th>
                  <th>{t("alerts.colTargetType")}</th>
                  <th>{t("alerts.colTarget")}</th>
                  <th>{t("alerts.colMetric")}</th>
                  <th>{t("alerts.colThreshold")}</th>
                  <th>{t("alerts.colEnabled")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rules.map((r, i) => {
                  const readonly = isForeign(r);
                  return (
                  <tr key={r.id}>
                    {isAdmin ? (
                      <td>
                        <Badge variant={readonly ? "neutral" : "success"} size="sm">
                          {r.username || ownUsername || "-"}
                        </Badge>
                      </td>
                    ) : null}
                    <td>
                      <div className="input-wrap">
                        <input
                          className="input"
                          value={r.name}
                          disabled={readonly}
                          onChange={(e) => patch(i, { name: e.target.value })}
                        />
                      </div>
                    </td>
                    <td>
                      <select
                        className="select"
                        value={r.target_type}
                        disabled={readonly}
                        onChange={(e) =>
                          // 切换对象类型后原目标不再适用，重置为「全部」
                          patch(i, { target_type: e.target.value, target: "*" })
                        }
                      >
                        <option value="node">{t("alerts.targetNode")}</option>
                        <option value="vm">{t("alerts.targetVm")}</option>
                      </select>
                    </td>
                    <td>
                      <select
                        className="select"
                        value={r.target}
                        disabled={readonly}
                        onChange={(e) => patch(i, { target: e.target.value })}
                      >
                        {targetSelectOptions(r).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="select"
                        value={r.metric}
                        disabled={readonly}
                        onChange={(e) => patch(i, { metric: e.target.value })}
                      >
                        {metrics.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {isStateMetric(r.metric) ? (
                        /* 状态型指标不看阈值：这里给一句语义说明，
                           而不是一个填了也没有任何作用的数字框 */
                        <span className="fs-xs text-muted">{t("alerts.stateAlarm")}</span>
                      ) : (
                        <div className="input-wrap">
                          <input
                            className="input"
                            type="number"
                            value={r.threshold}
                            disabled={readonly}
                            onChange={(e) => patch(i, { threshold: Number(e.target.value) })}
                          />
                        </div>
                      )}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        disabled={readonly}
                        onChange={(e) => patch(i, { enabled: e.target.checked })}
                      />
                    </td>
                    <td>
                      <IconButton
                        label={readonly ? t("alerts.deleteRuleReadonly") : t("alerts.deleteRule")}
                        variant="danger"
                        disabled={readonly}
                        onClick={() => setRules(rules.filter((_, k) => k !== i))}
                      >
                        <IconTrash size={15} />
                      </IconButton>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-secondary fs-sm">{t("alerts.rulesEmpty")}</div>
        )}
      </Card>

      <Card className="page-block" id={`${SECTION_PREFIX}history`}>
        <CardHeader
          title={t("alerts.historyTitle")}
          subtitle={historySubtitle || undefined}
          icon={<IconAlert size={16} />}
          actions={
            <Button
              variant="danger"
              size="sm"
              icon={<IconTrash size={14} />}
              loading={busy === "clear"}
              disabled={records.length === 0}
              onClick={() => setClearHistoryOpen(true)}
            >
              {t("alerts.clearHistory")}
            </Button>
          }
        />

        {records.length > 0 ? (
          <div className="alert-grid">
            {records.map((r: any) => {
              const sent = r.result === "sent";
              /* 静默记录已在 records 里被滤掉，这里只剩两种投递状态：送达 / 发送失败 */
              const state = sent ? "sent" : "failed";
              const isRecovery = r.kind === "recovery";
              const meta = metricMap[r.metric] ?? { label: r.metric, icon: <IconAlert size={14} /> };
              const value = Number(r.value ?? 0);
              const threshold = Number(r.threshold ?? 0);
              const pct = Math.min(100, Math.max(0, value));
              /* 与全站同一套分档（见 utils/format 的 usageColor） */
              const fillColor = usageColor(value);
              const targetLabel =
                (r.target_type === "node"
                  ? t("alerts.targetNodePrefix")
                  : t("alerts.targetVmPrefix")) + (r.target ?? "");
              const badgeText = sent
                ? isRecovery
                  ? t("alerts.badgeRecovered")
                  : t("alerts.badgeSent")
                : isRecovery
                  ? t("alerts.badgeRecoveryFailed")
                  : t("alerts.badgeSendFailed");
              const badgeVariant = sent
                ? isRecovery
                  ? "info"
                  : "success"
                : isRecovery
                  ? "warning"
                  : "danger";
              return (
                <div className={`alert-card alert-${state}`} key={r.id}>
                  <span className="alert-card-stripe" aria-hidden="true" />
                  <div className="alert-card-body">
                    <div className="alert-card-top">
                      <span className={`alert-card-icon is-${state}`}>
                        {sent ? <IconCheck size={15} /> : <IconClose size={15} />}
                      </span>
                      <span className="alert-card-title">{r.rule_name ?? t("alerts.fallbackAlarm")}</span>
                      <Badge variant={badgeVariant} size="sm" dot>
                        {badgeText}
                      </Badge>
                      {isAdmin && r.username ? (
                        <Badge variant="neutral" size="sm">
                          {r.username}
                        </Badge>
                      ) : null}
                    </div>

                    <div className="alert-card-meta">
                      <span className="alert-card-target">
                        <span className="alert-card-metric-icon">{meta.icon}</span>
                        {meta.label}
                        <span className="text-muted">·</span>
                        {targetLabel}
                      </span>
                      <span className="alert-card-time">
                        <IconClock size={12} />
                        {formatRelative(r.ts)}
                      </span>
                    </div>

                    {STATE_METRICS.has(String(r.metric)) ? (
                      /* 状态型记录没有百分比：画进度条只会是一根 0% 的空槽，
                         直接陈述结果更清楚 */
                      <div className="alert-card-metric-val">
                        <span className="fw-600">
                          {isRecovery ? t("alerts.recoveredOk") : t("alerts.stateAbnormal")}
                        </span>
                      </div>
                    ) : (
                      <div className="alert-card-metric">
                        <div className="alert-card-bar">
                          <span
                            className="alert-card-bar-fill"
                            style={{ width: `${pct}%`, background: fillColor }}
                          />
                          <span
                            className="alert-card-bar-threshold"
                            style={{ left: `${Math.min(100, threshold)}%` }}
                            title={t("alerts.threshold", { n: threshold })}
                          />
                        </div>
                        <div className="alert-card-metric-val">
                          <span className="mono fw-600">{value}%</span>
                          <span className="text-muted"> {t("alerts.threshold", { n: threshold })}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-secondary fs-sm">{t("alerts.historyEmpty")}</div>
        )}
      </Card>

      <ConfirmDialog
        open={clearHistoryOpen}
        danger
        title={t("alerts.clearTitle")}
        confirmText={t("alerts.clearConfirm")}
        message={t("alerts.clearMessage", { n: records.length })}
        onCancel={() => setClearHistoryOpen(false)}
        onConfirm={clearHistory}
      />
    </PageShell>
  );
}
