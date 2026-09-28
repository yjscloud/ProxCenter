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
import { formatRelative } from "../utils/format";
import { isRunning } from "../utils/status";
import type {
  AlertEmailConfig,
  AlertRule,
  AlertWebhookConfig,
} from "../api/types";

const METRICS = [
  { value: "cpu", label: "CPU 使用率", icon: <IconCpu size={14} /> },
  { value: "mem", label: "内存使用率", icon: <IconMemory size={14} /> },
  { value: "disk", label: "磁盘使用率", icon: <IconDisk size={14} /> },
  { value: "offline", label: "离线", icon: <IconPower size={14} /> },
  { value: "backup", label: "备份失败", icon: <IconBackup size={14} /> },
];
const METRIC_MAP = Object.fromEntries(METRICS.map((m) => [m.value, m]));

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

const SECTIONS = [
  { id: "notify", group: "推送与通道", label: "告警推送开关", icon: <IconBell size={15} /> },
  { id: "channels", group: "推送与通道", label: "告警通知渠道", icon: <IconChat size={15} /> },
  { id: "email", group: "推送与通道", label: "告警通知（邮件）", icon: <IconMail size={15} /> },
  { id: "rules", group: "规则与记录", label: "告警规则", icon: <IconFilter size={15} /> },
  { id: "history", group: "规则与记录", label: "告警历史", icon: <IconClock size={15} /> },
];

/** 分组标题右侧的作用范围说明 */
const GROUP_DESC: Record<string, string> = {
  推送与通道: "往哪儿发、发不发 —— 飞书群机器人、通用 Webhook、邮件",
  规则与记录: "什么情况算告警，以及已经发出去的那些",
};

function newRule(): AlertRule {
  return {
    // 同一毫秒内连续新增两条会撞 id，加随机后缀避免被后端按 id 合并
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "新告警规则",
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
  const qc = useQueryClient();
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
    SECTIONS.map((item) => item.id),
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
    const all = [{ label: "全部", value: "*" }];
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
  }, [nodesQuery.data, vmsQuery.data]);

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
      "通知配置已保存",
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
      "告警邮件设置已保存",
    );
  }

  async function sendTest() {
    await run(
      "test",
      async () => {
        await alertsApi.test();
        return "测试卡片已推送，请到飞书群确认";
      },
      "已发送",
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
      "通用 Webhook 配置已保存",
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
        return "测试请求已发出，请到接收端确认是否收到";
      },
      "已发送",
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

  async function clearHistory() {
    const ok = await run(
      "clear",
      async () => (await alertsApi.clearHistory()).detail,
      "告警历史已清除",
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
    return [{ label: `${rule.target}（已不在列表）`, value: rule.target }, ...list];
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
          ? `已恢复推送：${label}`
          : `已停止推送：${label}（巡检照常，命中也不记入告警历史）`,
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
      title="监控告警"
      subtitle="宿主机与虚拟机的 CPU / 内存 / 磁盘超过阈值时，通过飞书 / 邮件 / 通用 Webhook 发送告警"
      actions={
        <>
          {/* 导出走服务端流式 CSV：本页只展示最近 80 条，导出取全量历史。
              归属隔离与页面一致 —— 普通用户只会导出自己名下的告警。 */}
          <Button
            variant="secondary"
            icon={<IconDownload size={15} />}
            onClick={() => window.open(exportUrl("alerts"), "_blank")}
            title="导出全部告警历史（不受本页 80 条限制）"
          >
            导出历史
          </Button>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => void query.refetch()}
          >
            刷新
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
                  return "检测完成，命中 " + r.count + " 条";
                },
                "检测完成",
              )
            }
          >
            立即检测
          </Button>
        </>
      }
    >
      {msg ? (
        <Notice
          tone={msg.tone === "danger" ? "danger" : "success"}
          title={msg.tone === "danger" ? "操作失败" : "操作成功"}
        >
          {msg.text}
        </Notice>
      ) : null}

      {/* 停推是最危险的静默失败：出事了却没人收到通知。所以在页面顶端持续提醒，
          而不是只让开关自己显示成灰色 —— 那张卡可能在屏幕外。
          措辞要说全「也不记录」：否则用户会以为历史里还能翻到，实际上这些告警
          连库都不会进（见 alerting.record），事后是真的查不到。 */}
      {mutedSources.length > 0 ? (
        <Notice tone="warning" title="部分告警已停止推送">
          {mutedSources.map((item) => item.label).join("、")}
          ：这些来源的告警当前既不会发出，也不会记入告警历史（工作台待办里同样不会出现）。
          到下方「告警推送开关」可恢复。
        </Notice>
      ) : null}

      {/* 区块导航：点一下跳到对应分区，滚动时高亮当前所在分区（见 useSectionSpy） */}
      <nav className="page-index" aria-label="告警页分区">
        {SECTIONS.map((item, index) => (
          <Fragment key={item.id}>
            {/* 分组之间一道竖线：吸顶条只有一行高，再挂分组标题会把它撑成两行 */}
            {index > 0 && SECTIONS[index - 1].group !== item.group ? (
              <span className="page-index-sep" aria-hidden="true" />
            ) : null}
            <a
              href={`#${SECTION_PREFIX}${item.id}`}
              className={`page-index-item${
                item.id === activeSection ? " is-active" : ""
              }`}
              aria-current={item.id === activeSection ? "true" : undefined}
              title={GROUP_DESC[item.group]}
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
        <h2 className="page-section-title">推送与通道</h2>
        <p className="page-section-desc">{GROUP_DESC["推送与通道"]}</p>
      </header>

      {/* 推送来源开关：管「发不发」，与下面几张通道卡（管「往哪发」）正交 */}
      <Card className="page-block" id={`${SECTION_PREFIX}notify`}>
        <CardHeader
          title="告警推送开关"
          subtitle="按来源决定是否发送告警。关掉之后该来源的巡检照常运行，但命中的告警整条丢弃：飞书 / 邮件 / 通用 Webhook 与站内消息都不再发出，也不会写进告警历史与工作台待办"
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
                    : `已停止推送 · ${item.description}`
                }
              />
            );
          })}
        </div>
        {!isAdmin ? (
          <Notice tone="info" title="只读">
            这些开关是全局设置（影响所有用户会收到的告警），只有管理员可以修改。
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
          title="告警通知渠道"
          subtitle="告警与恢复通知通过下面已启用的渠道发出；两个渠道互相独立，可以只开一个，也可以都开"
          icon={<IconAlert size={16} />}
        />

        <div className="alc-ch alc-ch--first">
          <span className="alc-ch-name">
            <IconChat size={15} />
            飞书机器人
          </span>
          {/* 只在被关掉时才亮出来：常态下挂一个「已启用」是纯噪音。
              注意飞书这条通道目前没有界面开关（enabled 默认 true），
              这里如实反映后端状态，为将来补开关留好位置。 */}
          {feishu && !feishu.enabled ? (
            <Badge variant="warning" size="sm" dot>
              已停用
            </Badge>
          ) : null}
          <Badge variant={webhookSet ? "success" : "neutral"} size="sm" dot>
            <span className="flex items-center gap-4">
              <IconKey size={12} />
              {webhookSet ? "Webhook 已加密保存" : "未配置 Webhook"}
            </span>
          </Badge>
          <Badge variant={secretSet ? "success" : "neutral"} size="sm" dot>
            <span className="flex items-center gap-4">
              <IconKey size={12} />
              {secretSet ? "签名已配置" : "未配置签名"}
            </span>
          </Badge>
          <div className="alc-ch-actions">
            <Button
              variant="ghost"
              size="sm"
              loading={busy === "test"}
              onClick={() => void sendTest()}
            >
              发送测试
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy === "fs"}
              disabled={feishu === null}
              onClick={() => void saveFeishu()}
            >
              保存
            </Button>
          </div>
        </div>

        {feishu ? (
          <div className="form-grid">
            <div className="field">
              <label className="field-label">机器人 Webhook 地址</label>
              <div className="input-wrap">
                <input
                  className="input"
                  value={feishu.webhook || ""}
                  placeholder={
                    webhookSet
                      ? "留空表示不修改当前地址"
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
                      label="清除 Webhook"
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
                  <span className="text-danger">保存后将清除该 Webhook，告警不再推送。</span>
                ) : webhookSet ? (
                  <>
                    已加密存储，当前地址：
                    <span className="mono">{webhookMasked}</span>
                  </>
                ) : (
                  "粘贴飞书群机器人的 Webhook 地址，保存后自动加密存储。"
                )}
              </div>
            </div>
            <div className="field">
              <label className="field-label">签名密钥（选填）</label>
              <div className="input-wrap">
                <input
                  className="input"
                  type="password"
                  value={feishu.secret || ""}
                  placeholder={secretSet ? "已加密保存，留空表示不修改" : "机器人开启签名校验时填写"}
                  onChange={(e) => {
                    setSecretClear(false);
                    setFeishu({ ...feishu, secret: e.target.value });
                  }}
                />
                {secretSet && !secretClear ? (
                  <span className="input-suffix">
                    <IconButton
                      label="清除签名密钥"
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
                  ? "保存后将清除签名密钥。"
                  : secretSet
                    ? "密钥已加密存储，出于安全考虑不会回显。"
                    : "仅在机器人开启「签名校验」时需要填写。"}
              </div>
            </div>
            <div className="field">
              <label className="field-label">冷却时间（秒）</label>
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
              <label className="field-label">告警标题</label>
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
                飞书卡片大标题里的名字，例如「🔴 {titleBrand} 资源告警」。
                留空则用「设置 → 站点信息」里的面板名称。
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
            通用 Webhook
          </span>
          {hook && !hook.enabled ? (
            <Badge variant="warning" size="sm" dot>
              已停用
            </Badge>
          ) : null}
          <Badge variant={hookSet ? "success" : "neutral"} size="sm" dot>
            <span className="flex items-center gap-4">
              <IconKey size={12} />
              {hookSet ? "地址已加密保存" : "未配置地址"}
            </span>
          </Badge>
          <Badge variant={hookSecretSet ? "success" : "neutral"} size="sm" dot>
            <span className="flex items-center gap-4">
              <IconKey size={12} />
              {hookSecretSet ? "签名已配置" : "未配置签名"}
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
              发送测试
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy === "hook"}
              disabled={hook === null}
              onClick={() => void saveHook()}
            >
              保存
            </Button>
          </div>
        </div>

        {hook ? (
          <>
            <div className="form-grid">
              <div className="field">
                <label className="field-label">Webhook 地址</label>
                <div className="input-wrap">
                  <input
                    className="input"
                    value={hook.webhook || ""}
                    placeholder={
                      hookSet
                        ? "留空表示不修改当前地址"
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
                        label="清除 Webhook 地址"
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
                    <span className="text-danger">
                      保存后将清除该地址，告警不再推送到这条通道。
                    </span>
                  ) : hookSet ? (
                    <>
                      已加密存储，当前地址：
                      <span className="mono">{hookMasked}</span>
                    </>
                  ) : (
                    "粘贴接收端地址（企业微信 / 钉钉 / Slack 的机器人 Webhook，或自建服务）。"
                  )}
                </div>
              </div>

              <div className="field">
                <label className="field-label">签名密钥（选填）</label>
                <div className="input-wrap">
                  <input
                    className="input"
                    type="password"
                    value={hook.secret || ""}
                    placeholder={
                      hookSecretSet ? "已加密保存，留空表示不修改" : "接收端校验签名时填写"
                    }
                    onChange={(e) => {
                      setHookSecretClear(false);
                      setHook({ ...hook, secret: e.target.value });
                    }}
                  />
                  {hookSecretSet && !hookSecretClear ? (
                    <span className="input-suffix">
                      <IconButton
                        label="清除签名密钥"
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
                    "保存后将清除签名密钥。"
                  ) : hookSecretSet ? (
                    "密钥已加密存储，出于安全考虑不会回显。"
                  ) : (
                    "填了密钥才会带签名头：X-Panel-Timestamp 与 X-Panel-Signature（sha256=HMAC-SHA256(密钥, 时间戳\\n请求体)）。"
                  )}
                </div>
              </div>

              <div className="field">
                <label className="field-label">冷却时间（秒）</label>
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
                label="启用通用 Webhook"
                hint="默认关闭：配好地址并确认接收端能收到测试消息后再打开"
              />
            </div>

            <div className="mt-16">
              <div className="flex items-center gap-8 flex-wrap">
                <span className="fs-sm fw-500">请求体模板</span>
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
                <div>
                  留空则用内置默认体。点上面的按钮可一键套用各渠道的模板；
                  模板必须是合法 JSON，占位符会按 JSON 字符串规则转义后填入。
                </div>
                <div className="mt-4">
                  可用占位符：
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
                label="额外请求头（选填）"
                hint='JSON 对象，如 {"Authorization":"Bearer xxx"}；用于渠道特有的鉴权头'
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
              <Notice tone="info" title="关于签名">
                签名是面板自己的约定，不是各家渠道的原生签名 —— 自建接收端照上面
                的方式算一遍 HMAC 再比对即可（建议同时校验时间戳在可接受窗口内，
                否则抓到一次请求就能重放）。企业微信 / Slack 不需要签名；
                <strong>钉钉开启「加签」后要求把 sign 放进 URL 查询参数</strong>
                ，那不是请求体模板能表达的，需要在钉钉侧关掉加签或自行中转。
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
          title="告警通知（邮件）"
          subtitle="告警与恢复通知发到你的邮箱；发信用的是管理员在「设置 → 邮件通知」里配的 SMTP"
          icon={<IconBell size={16} />}
          actions={
            <>
              <Badge
                variant={mailReady ? "success" : "warning"}
                dot
                size="sm"
              >
                {mailReady ? "SMTP 已就绪" : "SMTP 未配置"}
              </Badge>
              <Button
                variant="primary"
                size="sm"
                icon={<IconSave size={14} />}
                loading={busy === "mail"}
                disabled={!emailCfg}
                onClick={() => void saveEmail()}
              >
                保存
              </Button>
            </>
          }
        />

        {!mailReady ? (
          <div className="mb-16">
            <Notice tone="warning" title="全局 SMTP 尚未配置">
              邮件通道需要管理员先在「设置 → 邮件通知」里填写 SMTP 服务器。
              在配好之前，这里即使打开开关也发不出邮件。
            </Notice>
          </div>
        ) : null}

        {emailCfg ? (
          <div className="flex flex-col gap-16">
            <Switch
              checked={emailCfg.enabled}
              onChange={(v) => setEmailCfg({ ...emailCfg, enabled: v })}
              label="启用邮件通知"
              hint="与飞书通道相互独立，可以只开其中一个，也可以两个都开"
            />
            <Field
              label="收件地址"
              hint={
                accountEmail
                  ? `留空则发到你的账号邮箱：${accountEmail}`
                  : "留空且账号未填邮箱时不会投递，建议直接填写收件地址"
              }
            >
              <Input
                value={emailCfg.recipients}
                onChange={(e) =>
                  setEmailCfg({ ...emailCfg, recipients: e.target.value })
                }
                placeholder="多个地址用英文逗号分隔"
                mono
              />
            </Field>
          </div>
        ) : (
          <div className="skeleton skeleton-text" />
        )}
      </Card>

      <header className="page-section-head">
        <h2 className="page-section-title">规则与记录</h2>
        <p className="page-section-desc">{GROUP_DESC["规则与记录"]}</p>
      </header>

      <Card className="page-block" id={`${SECTION_PREFIX}rules`}>
        <CardHeader
          title="告警规则"
          subtitle={
            isAdmin
              ? "规则按用户隔离，管理员可见全部；他人的规则只读，保存只会更新自己的"
              : "规则归属你自己，告警只推送到你配置的飞书机器人；目标选「全部」表示监控所有对象"
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
                添加规则
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
                    "规则已保存",
                  )
                }
              >
                保存规则
              </Button>
            </>
          }
        />
        {rules && rules.length > 0 ? (
          <div className="table-container">
            <table className="table table-dense">
              <thead>
                <tr>
                  {isAdmin ? <th>归属</th> : null}
                  <th>规则名称</th>
                  <th>对象</th>
                  <th>目标</th>
                  <th>指标</th>
                  <th>阈值(%)</th>
                  <th>启用</th>
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
                        <option value="node">宿主机</option>
                        <option value="vm">虚拟机</option>
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
                        {METRICS.map((m) => (
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
                        <span className="fs-xs text-muted">状态异常即告警</span>
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
                        label={readonly ? "他人的规则，不能删除" : "删除规则"}
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
          <div className="text-secondary fs-sm">还没有告警规则，点击右上角「添加规则」新增。</div>
        )}
      </Card>

      <Card className="page-block" id={`${SECTION_PREFIX}history`}>
        <CardHeader
          title="告警历史"
          subtitle={
            records.length > 0
              ? `共 ${records.length} 条 · 告警 ${alarmCount} · 恢复 ${recoveryCount}` +
                (failCount > 0 ? ` · 发送失败 ${failCount}` : "")
              : undefined
          }
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
              清除历史
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
              const meta = METRIC_MAP[r.metric] ?? { label: r.metric, icon: <IconAlert size={14} /> };
              const value = Number(r.value ?? 0);
              const threshold = Number(r.threshold ?? 0);
              const pct = Math.min(100, Math.max(0, value));
              const fillColor =
                value >= 85 ? "var(--usage-high)" : value >= 65 ? "var(--usage-mid)" : "var(--usage-low)";
              const targetLabel =
                (r.target_type === "node" ? "宿主机 " : "虚拟机 ") + (r.target ?? "");
              const badgeText = sent
                ? isRecovery
                  ? "已恢复"
                  : "已发送"
                : isRecovery
                  ? "恢复通知失败"
                  : "发送失败";
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
                      <span className="alert-card-title">{r.rule_name ?? "告警"}</span>
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
                          {isRecovery ? "已恢复正常" : "状态异常"}
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
                            title={`阈值 ${threshold}%`}
                          />
                        </div>
                        <div className="alert-card-metric-val">
                          <span className="mono fw-600">{value}%</span>
                          <span className="text-muted"> 阈值 {threshold}%</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-secondary fs-sm">暂无告警记录。</div>
        )}
      </Card>

      <ConfirmDialog
        open={clearHistoryOpen}
        danger
        title="清除告警历史"
        confirmText="清除"
        message={`将清空告警历史：列表中的 ${records.length} 条，以及更早版本留下、已不再展示的静默记录。此操作不可撤销。正在告警中的对象不受影响，指标恢复时仍会推送恢复通知。`}
        onCancel={() => setClearHistoryOpen(false)}
        onConfirm={clearHistory}
      />
    </PageShell>
  );
}
