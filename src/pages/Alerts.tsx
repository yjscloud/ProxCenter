import { useEffect, useMemo, useState } from "react";
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
  Table,
  sortRows,
  type Column,
  type SortState,
} from "../components/ui/Table";
import {
  IconAlert,
  IconBell,
  IconPlus,
  IconTrash,
  IconRefresh,
  IconSave,
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
  IconMail,
} from "../components/Icons";
import { useToast } from "../hooks/useToast";
import { useRefreshInterval } from "../hooks/useRefreshInterval";
import { useSiteInfo } from "../hooks/useSiteInfo";
import { PagerBar, usePaged } from "../hooks/usePaged";
import { tStatic, useT, type MessageKey, type TFunc } from "../i18n";
import { formatDateTime, formatRelative, usageColor } from "../utils/format";
import { isRunning } from "../utils/status";
import type {
  AlertEmailConfig,
  AlertRecord,
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

/**
 * **内置来源自建**、历史里会出现、但**不该出现在规则下拉里**的指标。
 *
 * 刻意与 :func:`metricOptions` 分开：那份是规则编辑器的可选项，而这些指标在
 * :func:`app.alerting.evaluate` 里根本不参与判定（额度预警由
 * :mod:`app.quotaalert` 单独算）。混进去的话，用户配出来的规则会在保存时被
 * ``normalise_rule`` 悄悄改回 cpu —— 界面上看不出任何异常，规则却永远不按
 * 额度判定。
 */
const INTERNAL_METRIC_LABELS: Record<string, MessageKey> = {
  quota: "alerts.metric.quota",
};

const isStateMetric = (metric: string) => STATE_METRICS.has(metric);

/**
 * 投递状态的四态：结果（送达 / 失败）× 类别（告警 / 恢复）。
 *
 * 排序也用它 —— 按「该不该先管」排：发送失败 > 恢复通知失败 > 新告警 > 已恢复。
 * 按文案字母排会把「已发送」顶到最前，恰好是最不需要先看的那批。
 *
 * 静默来源的记录在写入口就被整条丢掉了（见 alerting.record），所以这里只剩这四态。
 */
function deliveryMeta(r: AlertRecord, t: TFunc) {
  const sent = r.result === "sent";
  const isRecovery = r.kind === "recovery";
  if (sent) {
    return isRecovery
      ? { variant: "info" as const, label: t("alerts.badgeRecovered"), rank: 3 }
      : { variant: "success" as const, label: t("alerts.badgeSent"), rank: 2 };
  }
  return isRecovery
    ? { variant: "warning" as const, label: t("alerts.badgeRecoveryFailed"), rank: 1 }
    : { variant: "danger" as const, label: t("alerts.badgeSendFailed"), rank: 0 };
}

/* ---------------------------------------------------------------------------
   区块锚点
   ---------------------------------------------------------------------------
   本页不挂顶部吸顶的区块条（layout.css 的 .page-index），正文按分组
   （「推送与通道」「规则与记录」）铺开往下排即可。

   各 .page-block 仍保留 id（前缀见 SECTION_PREFIX），外部链接可以直接跳到某一段。
   --------------------------------------------------------------------------- */

const SECTION_PREFIX = "alert-";

/** 分组键：与下面 section.group 对应，文案在组件内取词 */
type SectionGroup = "channels" | "records";

function newRule(targetType: "node" | "vm" = "node"): AlertRule {
  return {
    // 同一毫秒内连续新增两条会撞 id，加随机后缀避免被后端按 id 合并
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: tStatic("alerts.newRuleName"),
    target_type: targetType,
    target: "*",
    metric: "cpu",
    threshold: 80,
    enabled: true,
  };
}

export function Alerts() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();

  /* 分组说明与指标定义：文案随语言走，所以在组件内构造 */
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

  /* 轮询间隔跟「设置 → 面板设置 → 数据刷新间隔」走（见 useRefreshInterval） */
  const refresh = useRefreshInterval();
  const query = useQuery({
    queryKey: ["alerts"],
    queryFn: alertsApi.get,
    refetchInterval: refresh,
    retry: false,
  });

  /* 「告警按用户隔离，管理员额外能看到全部」—— 这个判断要早于下面的节点查询，
     所以放在这里。 */
  const isAdmin = !!query.data?.is_admin;
  /* 节点清单只给管理员拉：「告警对象」里的「宿主机」那一档只对管理员开放
     （普通用户的下拉里根本没有它），所以没必要替他请求一次注定用不上的列表。 */
  const nodesQuery = useQuery({
    queryKey: ["nodes"],
    queryFn: nodesApi.list,
    staleTime: 60_000,
    enabled: isAdmin,
  });
  /* 管理员也可能读不到 —— PVE 全掉线时就是。这时要说一句，否则「宿主机」那一档
     下面只剩一个「全部」，看起来像功能坏了。 */
  const hostListUnavailable = isAdmin && nodesQuery.isError;

  const vmsQuery = useQuery({
    queryKey: ["vms", "all"],
    queryFn: () => vmsApi.list(),
    refetchInterval: refresh,
  });

  /* 面板名称：告警卡片标题留空时用它（见后端 alerting.resolve_title_brand），
     这里只拿来当输入框的 placeholder，让人一眼看到「不填会是什么」 */
  const site = useSiteInfo();
  /* 标题预览：与后端同一口径 —— 填了用填的，留空用面板名称 */
  const titleBrand = String(feishu?.title || "").trim() || site.name;

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
      setEmailCfg(
        query.data.email ?? {
          enabled: false,
          recipients: '',
          interval: 1800,
          max_repeats: 3,
        },
      );
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

  /**
   * 跑一次保存 / 测试类的操作，只报「成没成」。
   *
   * 这一层是**动作的反馈**，不是结果展示：后端返回的往往是配置对象、统计数字、
   * 一串布尔，把它们塞进提示里，用户看到的就是「保存成功：{"enabled":true,…}」——
   * 除了添堵没有别的用处。成功就报成功（带上「哪个设置保存了」，见 ok 文案），
   * 失败才把原因留在页面顶端那条内联提示里：那是唯一能拿到的诊断线索。
   *
   * 提示走 toast 而不只是顶部那条内联提示：告警页很长，邮件通道那张卡在页面
   * 下半截，用户点完保存人还停在原处，写在顶部的提示在屏幕之外 —— 看起来就是
   * 「点了保存，什么也没发生」。
   */
  async function run(key: string, fn: () => Promise<unknown>, ok: string): Promise<boolean> {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["alerts"] });
      toast.success(ok);
      return true;
    } catch (err) {
      const detail = (err as any)?.response?.data?.detail;
      setMsg({
        tone: "danger",
        text: detail ? String(detail) : t("common.opFailed"),
      });
      toast.error(t("common.opFailed"));
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
  // （isAdmin 定义在上面节点查询之前，那份查询要用它）
  const ownUsername = String(query.data?.own_username ?? "");
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

  /* 告警历史的列宽。

     这里必须**每一列都给死宽度**，一个都不能漏。原因在 .table-resizable：
     它给全站表格加了 `table-layout: fixed` —— 定宽布局下浏览器严格按声明的宽度
     排，多出来的横向空间只会被「唯一没声明宽度的那一列」独吞。

     之前把「数值」列留成无宽（想让那根条形吃掉剩余宽度），结果它一个人吃了
     三百多像素，格子里的内容却只占左边两百多 —— 右侧空出一大片，比原来还难看。

     定宽布局有两条互补的规则（实测过）：
       * 声明宽度之和小于容器 → 各列**按比例放大**填满容器，右侧不留洞；
       * 之和大于容器 → 表格溢出，`.table-container` 出现横向滚动条。
     所以下面的和（935）刻意压在常见容器宽度（1000~1250）**之下**，让它走第一条路。
     宽屏上多出来的那部分由「数值」列里那根条形吸收（见 .alert-hist-bar 的
     max-width），而不是变成空白。

     数字按中文字宽估的：12px 字号下汉字约 12px/字，等宽数字约 7px/字，
     再加上 table-dense 每格左右各 10px 内边距。 */
  const histColumns = useMemo<Array<Column<AlertRecord>>>(
    () => [
      {
        key: "time",
        header: t("alerts.colTime"),
        width: 115,
        sortable: true,
        sortValue: (r) => Number(r.ts ?? 0),
        render: (r) => (
          /* 相对时间读起来快（「3 小时前」比一串日期省眼睛），但要核对具体是哪一刻
             就得有绝对时间 —— 挂在 title 上，两种读法都留着 */
          <span className="alert-hist-time" title={formatDateTime(r.ts)}>
            <IconClock size={12} aria-hidden="true" />
            {formatRelative(r.ts)}
          </span>
        ),
      },
      {
        key: "status",
        header: t("alerts.colStatus"),
        width: 120,
        sortable: true,
        sortValue: (r) => deliveryMeta(r, t).rank,
        render: (r) => {
          const meta = deliveryMeta(r, t);
          return (
            <Badge variant={meta.variant} size="sm" dot>
              {meta.label}
            </Badge>
          );
        },
      },
      {
        key: "rule",
        header: t("alerts.colRule"),
        width: 215,
        sortable: true,
        sortValue: (r) => r.rule_name || "",
        render: (r) => (
          /* detail（投递详情 / 失败原因）后端一直有、卡片时代却从没渲染过。
             放进 title：不占列宽，也不至于被埋没 —— 而「发送失败」恰恰是最需要
             看到原因的那一格。 */
          <span className="alert-hist-rule" title={r.detail || undefined}>
            <span className="fw-500 truncate">{r.rule_name || t("alerts.fallbackAlarm")}</span>
            {isAdmin && r.username ? (
              <Badge variant="neutral" size="sm">
                {r.username}
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        key: "object",
        header: t("alerts.colObject"),
        width: 175,
        sortable: true,
        sortValue: (r) => `${r.target_type}:${r.target ?? ""}`,
        render: (r) => (
          <span className="truncate">
            {r.target_type === "node"
              ? t("alerts.targetNodePrefix")
              : t("alerts.targetVmPrefix")}
            {r.target ?? ""}
          </span>
        ),
      },
      {
        key: "metric",
        header: t("alerts.colMetric"),
        width: 150,
        sortable: true,
        sortValue: (r) => r.metric,
        render: (r) => {
          /* 指标列要同时认「规则可选的指标」和「内置来源自建的指标」。
             后者不能塞进 metricOptions —— 那是规则编辑器的可选项，而这些指标
             在资源告警里根本不参与判定（额度预警是 app.quotaalert 单独算的），
             挂上去用户配一条会静默失效：normalise_rule 悄悄把它改回 cpu，
             界面上看不出任何异常，规则却永远不按额度判。 */
          const meta =
            metricMap[r.metric] ??
            (INTERNAL_METRIC_LABELS[r.metric]
              ? {
                  label: t(INTERNAL_METRIC_LABELS[r.metric]),
                  icon: <IconAlert size={14} />,
                }
              : { label: r.metric, icon: <IconAlert size={14} /> });
          return (
            <span className="alert-hist-metric">
              <span className="alert-hist-metric-icon" aria-hidden="true">
                {meta.icon}
              </span>
              {meta.label}
            </span>
          );
        },
      },
      {
        key: "value",
        header: t("alerts.colValue"),
        /* 条形 + 16px 间距 + 约 30px 数值 + 约 58px 阈值文案 + 20px 内边距 */
        width: 215,
        sortable: true,
        sortValue: (r) => Number(r.value ?? 0),
        render: (r) => {
          const value = Number(r.value ?? 0);
          const threshold = Number(r.threshold ?? 0);
          const pct = Math.min(100, Math.max(0, value));
          /* 状态型记录没有百分比：画条只会是一根 0% 的空槽，直接陈述结果更清楚 */
          if (isStateMetric(String(r.metric))) {
            const recovered = r.kind === "recovery";
            return (
              <span
                className="fw-600"
                style={{
                  color: recovered ? "var(--success)" : "var(--danger)",
                }}
              >
                {recovered ? t("alerts.recoveredOk") : t("alerts.stateAbnormal")}
              </span>
            );
          }
          return (
            <span className="alert-hist-value">
              <span
                className="alert-hist-bar"
                title={t("alerts.threshold", { n: threshold })}
              >
                {/* 与全站同一套分档（见 utils/format 的 usageColor） */}
                <span
                  className="alert-hist-bar-fill"
                  style={{ width: `${pct}%`, background: usageColor(value) }}
                />
                <span
                  className="alert-hist-bar-threshold"
                  style={{ left: `${Math.min(100, threshold)}%` }}
                />
              </span>
              <span className="alert-hist-num">{value}%</span>
              <span className="alert-hist-thr">
                {t("alerts.threshold", { n: threshold })}
              </span>
            </span>
          );
        },
      },
    ],
    [isAdmin, metricMap, t],
  );

  /* ---- 告警历史：表格 + 排序 + 分页 ----
     原来这里是几十张卡片堆成网格。卡片要一屏放得下才划算，可告警恰恰是「越堆越多」
     的数据 —— 八十条卡片会把页面拉得极长，要找某一条只能一路滚到底。

     表格解决的是另一件事：**横向扫**。「哪台机器反复在告警」「哪类指标最常触发」
     只有把若干行并排才看得出来。排序 + 每页条数则是不让「翻到第 6 页」本身
     成为负担。

     排序必须在**整份**数据上做完再切页（顺序反了排的只是当前页 —— 第 2 页里时间
     最新的那条永远排不到最前，翻页时看着像坏了）。规则与表格内部共用同一个 sortRows。 */
  const [histSort, setHistSort] = useState<SortState | null>({
    key: "time",
    direction: "desc",
  });
  const sortedRecords = useMemo(
    () => sortRows(records as AlertRecord[], histColumns, histSort),
    [records, histColumns, histSort],
  );
  /* 归属作用域一变（管理员 ↔ 普通用户）就回第一页；条数不够时的越界由 hook 自己夹住 */
  const histPage = usePaged(sortedRecords, `${isAdmin}`);

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
            loading={query.isFetching}
            onClick={() => {
              /* 这一页除了告警列表，还拿节点与虚拟机当规则目标 —— 只刷列表的话，
                 那两个下拉会停在旧值（原先也漏了 loading，点了看不到反馈） */
              void query.refetch();
              void qc.invalidateQueries({ queryKey: ["nodes"] });
              void qc.invalidateQueries({ queryKey: ["vms"] });
            }}
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
          飞书机器人、通用 Webhook 与邮件是同一件事（把告警推到某个地方）的三种
          投递方式，所以配置放在一张卡片里，各占一行标题行。

          但它们在**机制上仍是三条独立通道**：飞书发的是官方交互式卡片、签名放在
          请求体里，走飞书自己的算法；通用 Webhook 发的是用户自定义模板、签名走
          X-Panel-Signature 头；邮件则走管理员在「设置 → 邮件通知」里配的 SMTP。
          合成「类型二选一」的单一渠道会丢掉「多处同时推送」的能力 —— 所以合并的
          是配置界面，不是投递链路。三个都开就都发。 */}
      {/* alc-channels 是这一卡的样式作用域：渠道内的字段间距、说明行高
          都比全局松一档，见 components.css 的「告警通知渠道」一节 */}
      <Card className="page-block alc-channels" id={`${SECTION_PREFIX}channels`}>
        <CardHeader
          title={t("alerts.channelsTitle")}
          subtitle={t("alerts.channelsSubtitle")}
          icon={<IconAlert size={16} />}
        />

        {/* 标题行：左边「名字 + 状态徽章」，右边操作按钮（见 .alc-ch 系列样式）。
            名字与徽章包在 .alc-ch-id 里作为一个整体 —— 窄屏放不下时让按钮
            换行，而不是把徽章从名字旁边拆走。 */}
        <div className="alc-ch alc-ch--first">
          <div className="alc-ch-id">
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
          </div>
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
          <div className="alc-ch-id">
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
          </div>
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
              {/* 12px 而不是 8px：上面那排是模板按钮，textarea 贴太近会看着像
                  按钮组的一部分，而不是「点完按钮后在这里改内容」 */}
              <div className="mt-12">
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
        {/* ---- 邮件：第三条投递路径。收件人按用户各自配置（留空 = 用账号邮箱），
               重复提醒的节奏也各配一份 ---- */}
        <div className="alc-ch">
          <div className="alc-ch-id">
            <span className="alc-ch-name">
              <IconMail size={15} />
              {t("alerts.emailTitle")}
            </span>
            <Badge variant={mailReady ? "success" : "warning"} size="sm" dot>
              {mailReady ? t("alerts.smtpReady") : t("alerts.smtpUnset")}
            </Badge>
            {/* 通道被关掉时在这一行就说清楚：开关在下面几行，而「这条通道现在
                是开是关」属于行本身的信息（飞书 / 通用 Webhook 的行也是这个写法，
                只是它们的状态来自各自的 enabled 字段） */}
            {emailCfg && !emailCfg.enabled ? (
              <Badge variant="warning" size="sm" dot>
                {t("alerts.disabled")}
              </Badge>
            ) : null}
          </div>
          <div className="alc-ch-actions">
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
          </div>
        </div>

        {/* 原来「邮件通道」那张卡片标题栏里的副标题搬到这里。合并之后整块只剩
            标题行，但「这个邮箱会收到什么」仍然得讲清楚 —— 除了告警与恢复，下发
            机器（配置、IP、口令）与重装结果这些非告警邮件也走它。 */}
        <div className="field-message alc-mail-desc mt-16">
          {t("alerts.emailSubtitle")}
        </div>

        {/* mt-16：邮件这一段的每一块都紧跟在渠道行（或说明）后面，.alc-ch 系列
            样式只给随后的 .form-grid 留了间距，这里自己补上，否则 Notice 会贴在
            渠道行上 */}
        {!mailReady ? (
          <div className="mb-16 mt-16">
            <Notice tone="warning" title={t("alerts.smtpMissingTitle")}>
              {t("alerts.smtpMissingBody")}
            </Notice>
          </div>
        ) : null}

        {emailCfg ? (
          <div className="mt-16 flex flex-col gap-16">
            <Switch
              checked={emailCfg.enabled}
              onChange={(v) => setEmailCfg({ ...emailCfg, enabled: v })}
              label={t("alerts.enableEmail")}
              hint={t("alerts.enableEmailHint")}
            />
            {/* 地址、间隔、次数放在同一行：这三项合起来才是「这封邮件发给谁、
                隔多久再发、最多发几次」的一份完整设定，分成三行既占高度，又让
                它们看着像互不相干的三个设置。
                宽度见 components.css 的 .alc-mail-fields：地址那格吃掉剩余宽度
                （要装下若干个邮箱），两个数字格封顶 200px。整行铺满卡片、不留
                宽度上限 —— 上限会把卡片右半边空出来，比数字框略宽更难看。

                注：重复提醒的节奏是邮件独有的 —— 以前只能蹭飞书的冷却，
                同一台机器持续高负载会一直重发。 */}
            <div className="alc-mail-fields">
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
              <Field
                label={t("alerts.mailIntervalLabel")}
                hint={t("alerts.mailIntervalHint")}
              >
                <Input
                  type="number"
                  min={0}
                  value={emailCfg.interval}
                  onChange={(e) =>
                    setEmailCfg({
                      ...emailCfg,
                      interval: Number(e.target.value) || 0,
                    })
                  }
                />
              </Field>
              <Field
                label={t("alerts.mailMaxRepeatsLabel")}
                hint={t("alerts.mailMaxRepeatsHint")}
              >
                <Input
                  type="number"
                  min={0}
                  value={emailCfg.max_repeats}
                  onChange={(e) =>
                    setEmailCfg({
                      ...emailCfg,
                      max_repeats: Number(e.target.value) || 0,
                    })
                  }
                />
              </Field>
            </div>
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
                /* 普通用户没有「宿主机」这一档，就以「虚拟机」起步；管理员仍按
                   原来的默认（宿主机），只是列表读不到时也退回「虚拟机」，免得
                   先撞一次空下拉 */
                onClick={() =>
                  setRules([
                    ...(rules ?? []),
                    newRule(isAdmin && !hostListUnavailable ? "node" : "vm"),
                  ])
                }
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
        {/* 宿主机列表读不到（PVE 连不上）时，「宿主机」这一档选不出具体主机。
            原先只是静默空着，看起来像功能坏了；这里把原因写明。 */}
        {hostListUnavailable ? (
          <Notice tone="info" title={t("alerts.nodesUnavailableTitle")}>
            {t("alerts.nodesUnavailable")}
          </Notice>
        ) : null}
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
                        {/* 「宿主机」是集群基础设施的监控，只对管理员开放：普通
                            用户的下拉里不出现这一档。历史遗留的 node 规则仍要如实
                            显示（补一个禁用的当前项），不能让它悄悄变成「虚拟机」
                            而误导人。 */}
                        {isAdmin || r.target_type === "node" ? (
                          <option value="node" disabled={!isAdmin}>
                            {t("alerts.targetNode")}
                          </option>
                        ) : null}
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

        <Table<AlertRecord>
          caption={t("alerts.historyTitle")}
          columns={histColumns}
          rows={histPage.rows}
          rowKey={(r) => r.id}
          dense
          sort={histSort}
          onSortChange={setHistSort}
          emptyTitle={t("alerts.historyEmpty")}
          rowTitle={(r) => r.detail ?? ""}
        />
        {/* 分页条只在真有记录时出现：空列表上那个「每页 N 条」下拉会让人以为
            底下还有东西没露出来 */}
        {records.length > 0 ? <PagerBar pager={histPage} /> : null}
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
