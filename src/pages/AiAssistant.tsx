/* ==========================================================================
   ProxCenter — AI 排查助手

   把平台已有的巡检结果（安全体检 / 阈值告警 / 登录分析 / 备份核对）交给
   大模型做归因与排序，回答的问题是「先修哪一条」。

   L1 阶段刻意保持**只读**：AI 不连目标主机、不执行任何命令，读的全是平台
   已经采集好的结构化数据。所以它做的是「解读」而不是「诊断」——命名也照这个
   来，免得用户以为 AI 会自己动手把问题修掉。

   每条结论都带 source_ref（指回原始检查项）：这是对付幻觉最有效的手段 ——
   用户可以自己核对，而不是只能选择信或不信。页脚也常驻一句同样的提醒。
   ========================================================================== */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { aiApi, exportUrl, usersApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { PageShell } from '../components/Layout';
import { RichText } from '../components/RichText';
import { Card, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Field, Input, SegmentedControl, Select, Switch } from '../components/ui/Input';
import { EmptyState, ErrorState, Notice } from '../components/ui/EmptyState';
import { Table } from '../components/ui/Table';
import type { Column } from '../components/ui/Table';
import { Skeleton, Spinner } from '../components/ui/Spinner';
import { Modal } from '../components/ui/Modal';
import { RemediationDialog } from '../components/RemediationDialog';
import { ApprovalCard, type ApprovalRequest } from '../components/AiApprovalCard';
import { AiTerminal } from '../components/AiTerminal';
import { AiUsageModal } from '../components/AiUsageModal';
import {
  IconActivity,
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconDownload,
  IconInfo,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconSparkle,
  IconStop,
  IconTrash,
} from '../components/Icons';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { formatDateTime } from '../utils/format';
import { useT, type MessageKey, type TFunc } from '../i18n';
import type {
  AiChatMessage,
  AiChatStreamEvent,
  AiConfig,
  AiConversation,
  AiConversationDetail,
  AiFinding,
  AiPlaybook,
  AiPreset,
  AiProvider,
  AiResult,
  AiSession,
  AiSeverity,
  BadgeVariant,
} from '../api/types';

/** 报告卡的元信息：判断「这份结论值不值信」的参照（模型、耗时、开销、工具数） */
interface ReportMeta {
  model?: string;
  ms?: number;
  tokens?: number;
  tools?: number;
  hostLabel?: string;
  /** 主机 id：报告里「处置」按钮要用它去加固，不能拿展示名顶替 */
  hostId?: string;
  at?: number;
}

/** 把落库的报告 JSON 解析回结构；坏了就当没有，别让一段脏数据崩掉整页 */
function parseReport(raw?: string | null): AiResult | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AiResult;
    return parsed && Array.isArray(parsed.findings) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 结论出处 → 平台里对应的功能页。
 *
 * 每条结论都带 source_ref（baseline:xxx / alerting:yyy / tool:host_disk_usage…）。
 * 之前只对 baseline 前缀给出「照做」按钮，别的出处就只剩一段文字、用户还得自己
 * 去菜单里找。这里把出处直接翻译成一个可点的入口 —— 看完建议顺手就能跳过去核实。
 */
const TOOL_ROUTES: Record<string, { to: string; labelKey: MessageKey }> = {
  host_listening_ports: { to: '/ports', labelKey: 'ai.gotoPorts' },
  host_socket_summary: { to: '/ports', labelKey: 'ai.gotoPorts' },
  host_recent_logins: { to: '/host-audit', labelKey: 'ai.gotoHostAudit' },
  host_disk_usage: { to: '/storages', labelKey: 'ai.gotoStorages' },
  host_block_devices: { to: '/storages', labelKey: 'ai.gotoStorages' },
  get_baseline_report: { to: '/security-baseline', labelKey: 'ai.gotoBaseline' },
  get_ssh_failures: { to: '/ssh-security', labelKey: 'ai.gotoSsh' },
  get_alert_history: { to: '/alerts', labelKey: 'ai.gotoAlerts' },
  get_metrics_history: { to: '/dashboard', labelKey: 'ai.gotoMetrics' },
  get_recent_changes: { to: '/tasks', labelKey: 'ai.gotoTasks' },
  get_related_resources: { to: '/nodes', labelKey: 'ai.gotoNodes' },
};

function sourceRoute(ref: string): { to: string; labelKey: MessageKey } | null {
  const [scheme, rest = ''] = ref.split(':', 2);
  switch (scheme) {
    case 'baseline':
      return { to: '/security-baseline', labelKey: 'ai.gotoBaseline' };
    case 'alert':
    case 'alerting':
      return { to: '/alerts', labelKey: 'ai.gotoAlerts' };
    case 'ssh':
    case 'login':
      return { to: '/ssh-security', labelKey: 'ai.gotoSsh' };
    case 'backup':
    case 'backups':
      return { to: '/backups', labelKey: 'ai.gotoBackups' };
    case 'metrics':
      return { to: '/dashboard', labelKey: 'ai.gotoMetrics' };
    case 'tool':
      return TOOL_ROUTES[rest] ?? null;
    default:
      return null;
  }
}

/** 严重程度 → 徽标配色。high 用 danger，别吝啬红色：这一档就是要让人停下来看 */
const SEVERITY_BADGE: Record<AiSeverity, BadgeVariant> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

function severityLabel(t: TFunc, severity: AiSeverity): string {
  return t(`ai.severity.${severity}` as MessageKey);
}

/* 控制台（终端 / 过程 + 对话）的总高由样式表里的 .ai-console 决定：跟着视口走，
   两张卡片用 flex 撑满、内部滚动区吸收剩余 —— 这样底部天然对齐，不依赖魔法
   数字。这里只负责挂上那几个类名。见 styles/layout.css 的「AI 排查助手」一节。 */

function confidenceLabel(t: TFunc, value: string): string {
  const key = `ai.confidence.${value}`;
  return ['high', 'medium', 'low'].includes(value)
    ? t(key as MessageKey)
    : value;
}

/** 配置面板里正在编辑的一条模型；api_key 为空表示「不改动已存的密钥」 */
interface ProviderDraft {
  id: string;
  name: string;
  kind: 'external' | 'internal';
  base_url: string;
  model: string;
  api_key: string;
  api_key_set: boolean;
  enabled: boolean;
  /** 平台共享项对普通用户只读 */
  readonly?: boolean;
  /** 授权给哪些人（所有者决定；被授权者能用，但改不了） */
  granted?: string[];
  /** 当前挂着的厂商预设名，用来展示该厂商的常用模型候选 */
  presetName?: string;
}

function toDraft(item: AiProvider): ProviderDraft {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    base_url: item.base_url,
    model: item.model,
    api_key: '',
    api_key_set: item.api_key_set,
    enabled: item.enabled,
    readonly: item.readonly ?? false,
    granted: item.granted ?? [],
    presetName: '',
  };
}

function emptyDraft(): ProviderDraft {
  return {
    id: '',
    name: '',
    kind: 'external',
    base_url: '',
    model: '',
    api_key: '',
    api_key_set: false,
    enabled: true,
    presetName: '',
  };
}

export function AiAssistant() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { isAdmin, hasPermission } = useAuth();

  const [tab, setTab] = useState<'inspect' | 'records'>('inspect');
  /**
   * 左栏放什么：默认是**终端**（那台被纳管服务器的实况窗口），需要看结构化的
   * 过程流水时切到「执行过程」。默认给终端是因为用户要回答的第一个问题通常是
   * 「这台机器现在什么情况」，而不是「AI 调了几次工具」。
   */
  const [leftTab, setLeftTab] = useState<'terminal' | 'activity'>('terminal');
  const [hostId, setHostId] = useState('');
  const [modelId, setModelId] = useState('');
  /**
   * 是否授权 AI 在目标主机执行只读命令。
   *
   * 默认关闭，且**只有两种**情况会被打开：用户手动勾选，或打开一条明确的
   * 历史会话时恢复它上次的选择。新建会话 / 切换主机一律回到关闭 —— 换了机器
   * 或开了新对话，就是一次全新的授权，不沿用旧的值。
   */
  const [allowExec, setAllowExec] = useState(false);
  /** 待用户批准的写命令：AI 提议后本轮挂起，等对话流里的审批卡拍板 */
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在跑那一轮的过程事件（左栏）。历史轮次从会话消息里重建 */
  const [events, setEvents] = useState<AiChatStreamEvent[]>([]);
  const [errorText, setErrorText] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  /** 终止本轮用。断开连接后后端也会停下（request.is_disconnected），不白烧 token */
  const abortRef = useRef<AbortController | null>(null);

  // ---- 会话：把「一次性排查」升级成可追问的线程 ----
  const [convId, setConvId] = useState('');
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  /** 当前会话的全部消息（服务端权威）。context / tool 行不直接渲染 */
  const [transcript, setTranscript] = useState<AiChatMessage[]>([]);
  /** 首轮体检产出的报告；「仅解读」也会写这里 */
  const [report, setReport] = useState<AiResult | null>(null);
  const [reportMeta, setReportMeta] = useState<ReportMeta | null>(null);
  /** 重新体检时把上一份报告的 findings 留作差异基线 */
  const [prevFindings, setPrevFindings] = useState<AiFinding[] | null>(null);
  const [draft, setDraft] = useState('');
  /** 正在流式到达的回复文本（打字机）。收尾时被权威的 assistant 消息替换 */
  const [streaming, setStreaming] = useState('');
  /** 差异基线要从 ref 同步取 —— setState 是异步的，闭包里的旧值不准 */
  const reportRef = useRef<AiResult | null>(null);
  useEffect(() => {
    reportRef.current = report;
  }, [report]);
  /** 从记录页跳进来时置位：切主机后不要再去抢「最近一条会话」，保留用户点开的那条 */
  const skipAutoSelectRef = useRef(false);
  /** 地址栏参数（`?host=&question=&preset=`）：从别的页面带题跳进来时用 */
  const [searchParams, setSearchParams] = useSearchParams();
  /** 带参进入只消费一次 —— 刷新/回退不该把同一个问题再问一遍 */
  const entryConsumedRef = useRef(false);
  /** 带预案跳进来时，等主机选中之后再跑（setHostId 是异步的） */
  const [pendingPreset, setPendingPreset] = useState('');
  /**
   * 带题进来、却找不到它对应的受管主机（来源页那个对象没登记过）。
   *
   * 这种时候**绝不能**沿用「默认选第一台」：问题问的是 A，AI 却去查 B ——
   * 它答得越自信越危险，用户会照着对一台不相干的机器动手。宁可多问一句。
   */
  const [needsHost, setNeedsHost] = useState(false);
  /** 流式文本的写入缓冲：token 很密，逐个 setState 会触发几百次渲染 */
  const streamBufRef = useRef('');
  const streamTimerRef = useRef<number | null>(null);

  /** 把流式增量写进缓冲，按 ~70ms 的节奏刷到界面 —— 打字机不必逐字渲染。 */
  function pushToken(text: string) {
    streamBufRef.current += text;
    if (streamTimerRef.current != null) return;
    streamTimerRef.current = window.setTimeout(() => {
      streamTimerRef.current = null;
      setStreaming(streamBufRef.current);
    }, 70);
  }

  /** 清空流式缓冲并取消未落地的刷新（reset 与收尾都走这里）。 */
  function resetStream() {
    streamBufRef.current = '';
    if (streamTimerRef.current != null) {
      window.clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    setStreaming('');
  }

  // 组件卸载时别留着定时器
  useEffect(
    () => () => {
      if (streamTimerRef.current != null) window.clearTimeout(streamTimerRef.current);
    },
    [],
  );

  const targetsQuery = useQuery({ queryKey: ['ai', 'targets'], queryFn: aiApi.targets });
  const status = targetsQuery.data?.status;
  // 模型清单对所有用户可见（不含密钥），用来渲染顶部的「已接入」状态条与模型选择
  const modelsQuery = useQuery({ queryKey: ['ai', 'models'], queryFn: aiApi.models });

  // 「已接入几个模型」不再单独占一条状态条：下拉里已经列全了，那是同一份信息的
  // 第二种说法。标注来历的活也搬到选项文字里，省掉一层视觉噪音。
  const modelOptions = useMemo(
    () =>
      (modelsQuery.data?.models ?? []).map((item) => ({
        label:
          (item.model ? `${item.name} · ${item.model}` : item.name) +
          (item.granted ? ` · ${t('ai.grantBadge')}` : ''),
        value: item.id,
      })),
    [modelsQuery.data, t],
  );
  /** 默认跟随管理员设的「当前使用」；用户临时改选只影响这一次排查 */
  const activeModelId = modelsQuery.data?.active_id || '';
  const currentModelId = modelId || activeModelId;

  const hostOptions = useMemo(
    () =>
      (targetsQuery.data?.hosts ?? []).map((host) => ({
        label: host.name || host.id,
        value: host.id,
      })),
    [targetsQuery.data],
  );

  /** 带占位项的选择项：``value=''`` 那一项必须存在 —— 原生 select 在没有
      匹配项时会显示第一台主机，状态里其实还是空，那样等于骗用户已经选好了。 */
  const hostSelectOptions = useMemo(
    () => [{ label: t('ai.selectHostPlaceholder'), value: '' }, ...hostOptions],
    [hostOptions, t],
  );

  /**
   * 目标主机**只由用户指定**，没有默认项。
   *
   * AI 是要登录到这台机器上读日志、跑命令的，「默认选中第一台」等于替用户
   * 决定把哪台机器交出去 —— 而它答得越自信，就越可能被人照着对一台不相干的
   * 机器动手。宁可多一次点击。
   */

  // 对话流里要把「排查哪台、用哪个模型」写成一句人话，所以把内部 id 翻成标签
  const selectedHostLabel =
    hostOptions.find((item) => item.value === hostId)?.label || hostId || '-';
  const selectedModelLabel =
    modelOptions.find((item) => item.value === currentModelId)?.label || currentModelId || '-';

  /**
   * 排障预案（可插拔）。
   *
   * 清单来自后端 `aiplaybooks.py` —— 加一套新套路只需要改那个文件，这个页面
   * 不用动。预案给的是**起点**：不想用模板的人照样可以直接打字。
   */
  const playbooksQuery = useQuery({
    queryKey: ['ai', 'playbooks'],
    queryFn: aiApi.playbooks,
    staleTime: 10 * 60_000,
  });
  const playbooks: AiPlaybook[] = playbooksQuery.data?.items ?? [];

  // 左栏在「没有实时事件」时展示本次会话已执行过的操作（回看用）。
  // command 一并带上：回看历史时用户最想核对的就是「AI 当时在他机器上敲了什么」，
  // 只列工具名（host_read_log）等于没说。
  const toolHistory = useMemo(
    () =>
      transcript
        .filter((item) => item.role === 'tool')
        .map((item) => ({
          tool: item.tool_name || 'tool',
          ok: Boolean(item.ok),
          command: item.command || '',
        })),
    [transcript],
  );

  /** 把会话详情的各字段摊进状态（对话、报告、元信息）。 */
  function applyDetail(detail: AiConversationDetail, restoreExec = true) {
    setConvId(detail.conversation.id);
    setTranscript(detail.messages);
    setReport(parseReport(detail.conversation.report));
    // 恢复这条会话上次的授权选择，别让刷新悄悄把「上机执行」关掉。
    // 但「切主机后自动接续最近一条会话」不算用户主动打开它 —— 那种情况传
    // restoreExec=false：刚选完主机就是一次全新的授权，不该沿用旧会话的开关。
    setAllowExec(restoreExec ? Boolean(detail.conversation.allow_exec) : false);
    const session = detail.session;
    setReportMeta(
      session
        ? {
            model: session.model,
            ms: session.duration_ms,
            tokens: session.total_tokens,
            tools: session.tool_calls,
            hostLabel: detail.conversation.host_name,
            hostId: detail.conversation.host_id,
            at: session.created,
          }
        : null,
    );
  }

  async function loadConversation(
    id: string,
    switchHost = false,
    restoreExec = true,
  ) {
    try {
      const detail = await aiApi.conversation(id);
      // 从记录页跳进来时，会话可能属于另一台主机：先把选择器同步过去，
      // 并标记「别再自动抢最近一条」，否则刚打开就被覆盖掉。
      if (
        switchHost &&
        detail.conversation.host_id &&
        detail.conversation.host_id !== hostId
      ) {
        skipAutoSelectRef.current = true;
        setHostId(detail.conversation.host_id);
      }
      applyDetail(detail, restoreExec);
      setEvents([]);
      setErrorText('');
      setPrevFindings(null);
    } catch (err) {
      toast.error(t('ai.failed'), errorMessage(err));
    }
  }

  /** 记录页点「在对话中打开」：切回排查页并载入那条会话。 */
  function openConversationFromRecords(id: string) {
    setTab('inspect');
    void loadConversation(id, true);
  }

  async function fetchConversations(targetHost: string): Promise<AiConversation[]> {
    try {
      const data = await aiApi.conversations({ host_id: targetHost, limit: 20 });
      setConversations(data.items);
      return data.items;
    } catch {
      return [];
    }
  }

  // 切主机：拉这台机器的会话；当前会话若不属于它，就自动接着最近的一次对话 ——
  // 这也是「刷新后恢复」的落地方式，默认回到最近一条，不用手动找。
  useEffect(() => {
    if (!hostId) return;
    let cancelled = false;
    void (async () => {
      const items = await fetchConversations(hostId);
      if (cancelled) return;
      if (skipAutoSelectRef.current) {
        // 从记录页跳进来的：刚载入的那条会话要保持打开，不去抢最近一条
        skipAutoSelectRef.current = false;
        return;
      }
      if (convId && items.some((item) => item.id === convId)) return;
      setConvId('');
      setTranscript([]);
      setReport(null);
      setReportMeta(null);
      setPrevFindings(null);
      setEvents([]);
      setErrorText('');
      // 换了一台主机就是一次全新的授权：默认关闭，不沿用上一台留下的开关。
      setAllowExec(false);
      // 自动接续最近一条会话只为「接着聊」，**不**恢复它的上机执行授权 ——
      // 否则用户刚选完主机，开关就自己亮起来，看起来像默认授权了。
      if (items.length > 0) void loadConversation(items[0].id, false, false);
    })();
    return () => {
      cancelled = true;
    };
    // 只在切主机时重跑；convId 只用于「当前会话是否属于这台机器」的判断
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  /**
   * 从别处带参跳进来（VM / 节点 / 告警 / 基线页的「问 AI」）：
   * `?host=` 选主机、`?question=` 预填问题、`?preset=` 直接跑某个预案。
   *
   * 消费完立刻把参数从地址栏抹掉（replace）—— 否则用户刷新页面，同一个问题会被
   * 再问一遍，而他还以为自己只是刷新了一下。
   */
  useEffect(() => {
    if (entryConsumedRef.current) return;
    const host = searchParams.get('host') ?? '';
    const question = searchParams.get('question') ?? '';
    const preset = searchParams.get('preset') ?? '';
    if (!host && !question && !preset) return;
    // 等主机清单到手再落 hostId，否则会被「默认选第一台」的回退盖掉
    if (targetsQuery.isLoading) return;
    entryConsumedRef.current = true;
    setSearchParams({}, { replace: true });

    if (host) {
      // 来源页给的主机**不一定**是助手的合法目标：最典型的是「面板本机」
      // （id=local）—— 它不在助手的候选清单里（见后端 ai.ai_targets）。
      // 这种情况不能硬把 id 塞进选择框：那个 id 连不出去，用户只会收到
      // 一句「找不到这台主机」，而且选择框还会空着。与「找不到受管主机」
      // 走同一条路 —— 让用户自己确认要查哪台，别替他猜。
      if (hostOptions.some((item) => item.value === host)) {
        if (host !== hostId) {
          // 带着新问题进来：别让「自动接上最近一条会话」把它抢走
          skipAutoSelectRef.current = true;
          setHostId(host);
        }
        newConversation();
      } else {
        setNeedsHost(true);
        setHostId('');
        newConversation();
      }
    } else if (question || preset) {
      // 来源页那个对象没找到对应的受管主机。清空选择交给用户确认 ——
      // 沿用默认的第一台会让 AI 去查另一台机器，而问题问的根本不是它。
      setNeedsHost(true);
      setHostId('');
      newConversation();
    }
    if (question) setDraft(question);
    if (preset) setPendingPreset(preset);
    // 只在首次带参进入时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, targetsQuery.isLoading]);

  // 预案要等主机就绪才能跑（hostId 可能正是上面刚设的，setState 还没生效）
  useEffect(() => {
    if (!pendingPreset || !hostId) return;
    const key = pendingPreset;
    setPendingPreset('');
    runPlaybook(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPreset, hostId]);

  /**
   * 一轮的公共骨架：清过程事件 → 跑 → 统一收尾。
   *
   * ``base`` 是本次开跑前的旧报告，成功后作为「重新体检」的差异基线。
   */
  async function execute(
    work: (controller: AbortController, base: AiResult | null) => Promise<void>,
  ) {
    const base = reportRef.current;
    setBusy(true);
    setEvents([]);
    resetStream();
    setErrorText('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await work(controller, base);
    } catch (err) {
      // 自己按的终止不是故障 —— 别报成失败吓人
      if (controller.signal.aborted) {
        toast.info(t('ai.abortedTitle'), t('ai.abortedHint'));
      } else {
        const message = errorMessage(err);
        setErrorText(message);
        toast.error(t('ai.failed'), message);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      // 抛异常时也要收掉流式缓冲，否则会留一段半截的「打字中」气泡
      resetStream();
    }
  }

  /** 一轮结束后把服务端的最新状态拉回来（屏上的乐观消息被权威消息替换）。 */
  async function refreshAfterTurn(conversationId: string) {
    try {
      const detail = await aiApi.conversation(conversationId);
      applyDetail(detail);
    } catch {
      /* 拉不到就保留屏上的乐观消息 */
    }
    void fetchConversations(hostId);
    // 这一轮已经落库，用量统计跟着变 —— 不刷新的话卡片还停在上一轮的数字上
    void qc.invalidateQueries({ queryKey: ['ai', 'usage'] });
  }

  /**
   * 在一条会话里跑一轮。
   *
   * ``mode`` 决定形态：``chat`` 是自由对话（默认），``inspect`` 是体检模板
   * （采集证据 + 产出报告，text 可留空）。
   */
  async function streamTurn(
    conversationId: string,
    text: string,
    controller: AbortController,
    mode: 'chat' | 'inspect',
    preset = '',
  ) {
    await aiApi.sendMessageStream(
      conversationId,
      text,
      (event) => {
        // token / token_reset 是文本流控制：进对话气泡，不进左栏的过程流水
        if (event.type === 'token') {
          pushToken(event.text);
          return;
        }
        if (event.type === 'token_reset') {
          // 新的一段流式文本开始：丢掉上一段的缓冲，避免「前言」粘进最终回答
          resetStream();
          return;
        }
        // 左栏「排查过程」只收过程类事件：assistant / report / approval / aborted
        // 各有去处（对话气泡、报告卡、审批卡），混进来只会撑大数组、让
        // ActivityPane 的「有没有内容」判断失准 —— 它们在 TimelineRow 里并不渲染。
        if (
          event.type === 'stage' ||
          event.type === 'thinking' ||
          event.type === 'tool_start' ||
          event.type === 'tool_done' ||
          event.type === 'error'
        ) {
          setEvents((list) => [...list, event]);
        }
        if (event.type === 'assistant') {
          // 收尾：权威文本落地，流式缓冲功成身退
          resetStream();
          setTranscript((list) => [
            ...list,
            {
              id: event.message_id,
              conversation_id: conversationId,
              seq: Number.MAX_SAFE_INTEGER,
              role: 'assistant',
              content: event.content,
              created: Math.floor(Date.now() / 1000),
            },
          ]);
        } else if (event.type === 'report') {
          setReport(event.report);
        } else if (event.type === 'approval') {
          // 写命令先落在这里：内联审批卡给用户看，本轮在后端挂着等
          setApproval(event);
        } else if (event.type === 'done') {
          resetStream();
          void refreshAfterTurn(conversationId);
        } else if (event.type === 'error') {
          resetStream();
          setErrorText(event.message);
          toast.error(t('ai.failed'), event.message);
        } else if (event.type === 'aborted') {
          resetStream();
          toast.info(t('ai.abortedTitle'), t('ai.abortedHint'));
          void refreshAfterTurn(conversationId);
        }
      },
      controller.signal,
      currentModelId || undefined,
      allowExec,
      mode,
      preset,
    );
  }

  /**
   * 体检：新建一条会话并按模板跑一轮「采集 + 报告」。
   *
   * 这是一个**动作**，不是进入对话的门槛 —— 想直接问问题，在输入框里说就行。
   */
  function startInspection(withText = '') {
    if (!hostId || busy) return;
    void execute(async (controller, base) => {
      setPrevFindings(base?.findings ?? null);
      const conv = await aiApi.createConversation({
        host_id: hostId,
        provider_id: currentModelId || undefined,
        allow_exec: allowExec || undefined,
      });
      setConvId(conv.id);
      setTranscript([]);
      setReport(null);
      setReportMeta(null);
      // 立刻刷新列表：会话已落库，选单里要马上能看到它，别等这一轮跑完
      void fetchConversations(hostId);
      await streamTurn(conv.id, withText, controller, 'inspect');
      void fetchConversations(hostId);
    });
  }

  /**
   * 发送一条对话消息。
   *
   * 还没有会话就先开一条 —— **默认走自由对话**，不再顺手做一次体检：
   * 用户问「nginx 为什么 502」，要的是对这个问题的直接回答，而不是一份体检
   * 报告的摘要。需要完整体检时，他会去点那个按钮。
   */
  /** 乐观追加一条用户气泡（服务端落库后会被权威消息替换）。 */
  function pushUserBubble(conversationId: string, content: string) {
    setTranscript((list) => [
      ...list,
      {
        id: 'local-' + Date.now(),
        conversation_id: conversationId,
        seq: Number.MAX_SAFE_INTEGER,
        role: 'user',
        content,
        created: Math.floor(Date.now() / 1000),
      },
    ]);
  }

  /** 取当前会话；没有就新开一条（新会话的前几轮状态一并清干净）。 */
  async function ensureConversation(): Promise<string> {
    if (convId) return convId;
    const conv = await aiApi.createConversation({
      host_id: hostId,
      provider_id: currentModelId || undefined,
      allow_exec: allowExec || undefined,
    });
    setConvId(conv.id);
    setTranscript([]);
    setReport(null);
    setReportMeta(null);
    setPrevFindings(null);
    // 立刻刷新列表：会话已落库，选单里要马上能看到它
    void fetchConversations(hostId);
    return conv.id;
  }

  function sendMessage() {
    const text = draft.trim();
    if (!text || busy || !hostId) return;
    setDraft('');
    void execute(async (controller) => {
      const target = await ensureConversation();
      pushUserBubble(target, text);
      await streamTurn(target, text, controller, 'chat');
    });
  }

  /**
   * 跑一个预案。
   *
   * 前端只给 key：预案的**指令**和**落库用的短标题**由后端分开处理（见
   * `aiplaybooks.py`）—— 这样加一套新套路不用改这个页面，聊天记录里也不会
   * 出现几十行的操作说明。
   */
  function runPlaybook(key: string) {
    if (!key || busy || !hostId) return;
    void execute(async (controller) => {
      const target = await ensureConversation();
      // 乐观气泡用预案标题，与后端落库的那条消息一致
      const item = playbooks.find((p) => p.key === key);
      pushUserBubble(target, item?.title || key);
      await streamTurn(target, '', controller, 'chat', key);
    });
  }

  function newConversation() {
    setConvId('');
    setTranscript([]);
    setReport(null);
    setReportMeta(null);
    setPrevFindings(null);
    setEvents([]);
    setErrorText('');
    // 新会话默认不授权上机执行：上一条会话开过不等于这条也要开。
    setAllowExec(false);
  }

  function stop() {
    // 正卡在写命令审批上时，必须先把它按「拒绝」收口：后端此刻挂在等待里，
    // 只断开流并不会让它醒 —— 用户之后（或卡片倒计时到点）仍可能把这条命令
    // 放行。先发一次拒绝，再断开 SSE。
    if (approval) {
      void aiApi.approve(approval.approval_id, false).catch(() => {});
      setApproval(null);
    }
    abortRef.current?.abort();
  }

  /**
   * 只解读、不调工具（L1 通路）。
   *
   * 留这个入口是因为「模型不支持 function calling」是常见情况 —— 内网跑的小模型
   * 尤其如此。它出的是一份一次性摘要，不进入会话线程。
   */
  function quickRun() {
    if (!hostId) return;
    void execute(async (_controller, base) => {
      const data = await aiApi.inspect(hostId, currentModelId);
      setPrevFindings(base?.findings ?? null);
      setConvId('');
      setTranscript([]);
      setReport(data.result);
      setReportMeta({
        model: data.model,
        ms: data.timing?.total_ms,
        tokens: data.usage?.total_tokens,
        tools: data.tool_calls?.length ?? 0,
        hostLabel: data.host_name,
        hostId: data.host_id,
        at: data.generated_at,
      });
      toast.success(
        t('ai.doneTitle'),
        t('ai.doneDetail', { n: data.result.findings.length }),
      );
    });
  }

  const ready = Boolean(status?.ready);
  // 有没有「授权上机执行」的权限：没有就不显示那个开关（不给点不动的控件）
  const canExec = hasPermission('ai.exec');
  // 远程终端是**另一道门**：能看 AI 的结论，不等于能亲手在这台机器上敲命令
  const canTerminal = hasPermission('ai.terminal');

  return (
    <PageShell
      title={
        <span className="flex items-center gap-8">
          <IconSparkle size={20} />
          {t('ai.title')}
        </span>
      }
      subtitle={t('ai.subtitle')}
      actions={
        /* 三个入口都是「打开一个弹窗看看」，彼此没有主次 —— 所以统一用
           secondary。混用 ghost 会让有底有框的那个（我的模型）看起来像主操作，
           其实它只是同一排里的一个入口。（项目里页面级 actions 也都是 secondary，
           见 Backups / Certificates / AuditLog。） */
        <div className="flex items-center gap-8">
          {/* 先说清楚能干什么，再让人动手：这是个会登录到他服务器上执行命令
              的功能，用户有权在按按钮之前知道边界在哪 */}
          <Button
            variant="secondary"
            icon={<IconInfo size={15} />}
            onClick={() => setCapabilitiesOpen(true)}
          >
            {t('ai.capabilities')}
          </Button>
          <Button
            variant="secondary"
            icon={<IconSettings size={15} />}
            onClick={() => setSettingsOpen(true)}
          >
            {isAdmin ? t('ai.settings') : t('ai.myModels')}
          </Button>
          {/* 用量排在这一组的最后：前两个是「动手之前该知道的」（能力边界、
              用哪个模型），用量是「事后回看」的，顺序上也该靠后 */}
          <Button
            variant="secondary"
            icon={<IconActivity size={15} />}
            onClick={() => setUsageOpen(true)}
          >
            {t('ai.usage.open')}
          </Button>
        </div>
      }
    >
      {targetsQuery.isError ? (
        <ErrorState
          title={t('ai.failed')}
          message={errorMessage(targetsQuery.error)}
          onRetry={() => void targetsQuery.refetch()}
        />
      ) : null}

      <SegmentedControl
        value={tab}
        onChange={setTab}
        options={[
          { label: t('ai.tabInspect'), value: 'inspect' },
          { label: t('ai.tabRecords'), value: 'records' },
        ]}
        ariaLabel={t('ai.title')}
      />

      {tab === 'records' ? (
        <RecordsPanel
          hosts={hostOptions}
          onOpenConversation={openConversationFromRecords}
        />
      ) : (
        <>
          {!targetsQuery.isError && !targetsQuery.isLoading && !ready ? (
            /* 严格隔离下「没得用」有两种成因，提示必须分开：管理员是平台没配，
               普通用户是自己没配 —— 后者给他一个入口自己配，别让他去找管理员。 */
            <Notice
              tone={isAdmin ? 'warning' : 'info'}
              title={isAdmin ? t('ai.notConfigured') : t('ai.noMyModel')}
            >
              {isAdmin ? t('ai.notConfiguredHint') : t('ai.noMyModelHint')}
              <div className="mt-8">
                <Button
                  variant="primary"
                  icon={<IconSettings size={15} />}
                  onClick={() => setSettingsOpen(true)}
                >
                  {isAdmin ? t('ai.configureNow') : t('ai.myModels')}
                </Button>
              </div>
            </Notice>
          ) : null}

          {/* 目标主机必须由用户自己选：AI 会登录到这台机器上执行命令，替他顶一台
              上去等于擅自决定动哪台机器。没选之前入口全关着（按钮 disabled、
              终端不开），这里把原因说清楚，而不是让人对着一排灰按钮猜。 */}
          {!hostId && !targetsQuery.isLoading ? (
            hostOptions.length === 0 ? (
              <Notice tone="info" title={t('ai.noHostTitle')}>
                {t('ai.noHostHint')}
              </Notice>
            ) : (
              <Notice
                tone="warning"
                title={needsHost ? t('ai.needsHostTitle') : t('ai.pickHostTitle')}
              >
                {needsHost ? t('ai.needsHostHint') : t('ai.pickHostHint')}
              </Notice>
            )
          ) : null}

          <Card>
            {/* 左选择、右操作：主操作放最右（视线与操作的终点），次要操作降为
                ghost 小按钮靠左 —— 两个实心按钮并排会让人分不清该点哪个。 */}
            <div className="flex items-end justify-between gap-12 flex-wrap">
              <div
                className="flex items-end gap-12 flex-wrap"
                style={{ flex: '1 1 460px' }}
              >
                <div style={{ flex: '1 1 190px', minWidth: 170 }}>
                  <Field label={t('ai.selectHost')}>
                    <Select
                      value={hostId}
                      onChange={(e) => setHostId(e.target.value)}
                      options={hostSelectOptions}
                      disabled={busy || hostOptions.length === 0}
                    />
                  </Field>
                </div>
                {/* 排查因题而异：读个负载用快模型就够，真定位故障才值得上强
                    模型。所以这里选的是「这一次用哪个」，不改管理员设的默认。 */}
                <div style={{ flex: '1 1 220px', minWidth: 190 }}>
                  <Field label={t('ai.selectModel')} hint={t('ai.selectModelHint')}>
                    <Select
                      value={currentModelId}
                      onChange={(e) => setModelId(e.target.value)}
                      options={modelOptions}
                      disabled={busy || modelOptions.length === 0}
                    />
                  </Field>
                </div>
              </div>
              <div className="flex items-center gap-8">
                {/* 排查中藏起「仅解读」：它中断不了正在跑的那次，留着只会误点 */}
                {busy ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!ready || !hostId}
                    onClick={() => void quickRun()}
                    title={t('ai.quickHint')}
                  >
                    {t('ai.quickInspect')}
                  </Button>
                )}
                <Button
                  variant="primary"
                  icon={<IconSparkle size={15} />}
                  loading={busy}
                  disabled={!ready || !hostId || busy}
                  onClick={() => startInspection()}
                  title={t('ai.startHint')}
                >
                  {busy ? t('ai.running') : t('ai.start')}
                </Button>
                {/* 一次排查十几秒到一分钟，中途发现选错主机/模型时能停，
                    比等它跑完再重来省事得多 */}
                {busy ? (
                  <Button
                    variant="danger"
                    icon={<IconStop size={15} />}
                    onClick={stop}
                  >
                    {t('ai.stop')}
                  </Button>
                ) : null}
              </div>
            </div>

            {/* 授权上机执行：一次排查一次授权、不记住 —— 让「允许它动我的机器」
                始终是一个当场做出的决定，而不是某天顺手勾过就一直生效 */}
            {canExec ? (
              <div
                style={{
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: '1px solid var(--border-muted)',
                }}
              >
                <Switch
                  checked={allowExec}
                  onChange={setAllowExec}
                  label={t('ai.allowExec')}
                  hint={t('ai.allowExecHint')}
                  disabled={busy}
                />
                {/* 「写操作也要你点头」单独用警示色说一遍：它藏在上面那段灰字里
                    很容易被略过，而这一条恰恰是用户勾选前最该确认的事。 */}
                <div className="ai-warn-note">
                  <IconAlert size={14} />
                  <span>{t('ai.allowExecWarn')}</span>
                </div>
              </div>
            ) : null}
          </Card>

          {/* 控制台：左「终端 / 执行过程」、右「对话与授权」。
              左栏默认是终端 —— 那台被纳管服务器的实况窗口：用户自己敲的命令，
              以及 AI 这一轮执行的每条命令与输出，都落在同一个画面里。要看结构
              化的过程流水（哪一步、耗了多久）就切到「执行过程」。
              右栏是对话与逐条授权，两边并排，「它在做什么」和「要不要批准」
              就在同一屏里。 */}
          {/* 「连的是哪台机器」由终端卡片自己那行说明负责，不在这里重复一遍 ——
              同一个句子同时出现在工具栏和卡片里，读起来像出了两次错。 */}
          <SegmentedControl
            value={leftTab}
            onChange={setLeftTab}
            options={[
              { label: t('ai.terminalTitle'), value: 'terminal' },
              { label: t('ai.progressTitle'), value: 'activity' },
            ]}
            ariaLabel={t('ai.terminalTitle')}
          />
          <div className="grid grid-2 ai-console">
            {/* 两个页签**都保持挂载**，只切换显隐：终端一旦卸载就等于断开 SSH，
                切去看一眼「执行过程」再切回来会变成一条新连接 —— 当前目录、
                环境变量、跑着的进程全丢，而且隐藏期间 AI 的镜像输出也收不到了。
                隐藏时容器尺寸为 0，终端自己会跳过尺寸计算；切回来时再对齐一次
                （见 AiTerminal 的 visible 处理）。 */}
            <div>
              <div
                className={`ai-console-pane${leftTab === 'terminal' ? '' : ' is-hidden'}`}
              >
                <AiTerminal
                  hostId={hostId}
                  hostName={selectedHostLabel}
                  canUse={canTerminal}
                  visible={leftTab === 'terminal'}
                  fill
                />
              </div>
              <div
                className={`ai-console-pane${leftTab === 'activity' ? '' : ' is-hidden'}`}
              >
                <ActivityPane events={events} busy={busy} history={toolHistory} />
              </div>
            </div>
            <ChatPane
              conversations={conversations}
              convId={convId}
              onSelectConversation={(id) => void loadConversation(id)}
              onNewConversation={newConversation}
              hostLabel={selectedHostLabel}
              modelLabel={selectedModelLabel}
              hasHost={Boolean(hostId)}
              transcript={transcript}
              busy={busy}
              approval={approval}
              onApprovalDone={() => setApproval(null)}
              draft={draft}
              onDraftChange={setDraft}
              onSend={sendMessage}
              canSend={ready && Boolean(hostId) && !busy && !approval}
              streaming={streaming}
              playbooks={playbooks}
              onRunPlaybook={runPlaybook}
            />
          </div>

          {errorText ? (
            <Notice tone="danger" title={t('ai.failed')}>
              {errorText}
            </Notice>
          ) : null}

          {report ? (
            <ReportCard
              report={report}
              meta={reportMeta}
              previousFindings={prevFindings}
              onRerun={startInspection}
            />
          ) : null}

          {report ? <Notice tone="info">{t('ai.disclaimer')}</Notice> : null}
        </>
      )}

      <CapabilitiesModal
        open={capabilitiesOpen}
        onClose={() => setCapabilitiesOpen(false)}
      />

      {/* 用量明细：入口是标题栏那组按钮里的「Token 消耗」 */}
      <AiUsageModal open={usageOpen} onClose={() => setUsageOpen(false)} />

      {/* 配置面板对所有人开放：管理员配全平台的，普通用户配自己的 ——
          界面里平台共享项会置灰，看得见在用哪个，但改不了。 */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: ['ai'] });
        }}
      />
    </PageShell>
  );
}

/* ------------------------------------------------------------------ 执行过程 */

/**
 * 实时展示 Agent 在做什么（左栏「执行过程」页签）。
 *
 * 左栏默认是终端 —— 那里看的是**命令与输出**；这一页看的是**步骤与耗时**：
 * 第几轮分析、调了哪个工具、成没成、花了多久。两者回答的是不同的问题，
 * 所以都在，而不是二选一：终端贴原始输出，这里给结构化的过程。
 *
 * 两种数据来源：本轮在跑时看实时事件；翻看历史会话时没有事件可放，就从会话消息
 * 里把「执行过的工具」重建出来 —— 否则切回去会是一片空白，还以为没跑过。
 */
function ActivityPane({
  events,
  busy,
  history,
}: {
  events: AiChatStreamEvent[];
  busy: boolean;
  /** 历史会话里执行过的工具与命令（回看用；有实时事件时忽略） */
  history: Array<{ tool: string; ok: boolean; command: string }>;
}) {
  const t = useT();
  const rows = events.filter((event) => event.type !== 'done');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [rows.length, history.length]);

  const empty = rows.length === 0 && history.length === 0;

  return (
    <Card>
      <CardHeader
        title={t('ai.progressTitle')}
        subtitle={
          busy
            ? t('ai.runningHint')
            : rows.length > 0
              ? t('ai.progressDone')
              : history.length > 0
                ? t('ai.progressHistory')
                : t('ai.progressIdle')
        }
        actions={busy ? <Spinner size={14} /> : undefined}
      />
      <div className="flex flex-col gap-6 ai-console-scroll">
        {empty ? (
          <span className="fs-sm text-muted">{t('ai.progressEmpty')}</span>
        ) : rows.length > 0 ? (
          rows.map((event, index) => <TimelineRow key={index} event={event} />)
        ) : (
          history.map((item, index) => (
            <TimelineLine
              key={index}
              icon={item.ok ? <IconCheck size={13} /> : <IconAlert size={13} />}
              text={t('ai.toolHistoryLine', {
                mark: item.ok ? '✓' : '✕',
                tool: item.tool,
              })}
              detail={item.command}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ 对话栏 */

/**
 * 控制台右栏：对话 + 授权。
 *
 * 对话内容来自**服务端会话**（``ai_messages``）：首轮体检产出一份报告，之后可以
 * 继续追问。刷新或换设备都能接着聊 —— 这也是把它落库、而不是只留前端的理由。
 * 授权卡片内嵌在对话流里：授权本身就是对话中的一个动作。
 */
function ChatPane({
  conversations,
  convId,
  onSelectConversation,
  onNewConversation,
  hostLabel,
  modelLabel,
  /** 有没有选目标主机。没选时预案入口一并锁住 —— 点下去没反应比没有入口更困惑 */
  hasHost,
  transcript,
  busy,
  approval,
  onApprovalDone,
  draft,
  onDraftChange,
  onSend,
  canSend,
  streaming,
  playbooks,
  onRunPlaybook,
}: {
  conversations: AiConversation[];
  convId: string;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  hostLabel: string;
  modelLabel: string;
  /** 是否已选定目标主机 */
  hasHost: boolean;
  transcript: AiChatMessage[];
  busy: boolean;
  approval: ApprovalRequest | null;
  onApprovalDone: (approved: boolean) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  canSend: boolean;
  /** 正在流式到达的回复文本（打字机）；收尾后为空 */
  streaming: string;
  /** 排障预案：空会话时铺成快捷入口，对话中收进标题栏的选单 */
  playbooks: AiPlaybook[];
  onRunPlaybook: (key: string) => void;
}) {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 只渲染「人说的话」：context 是喂给模型的 [数据] 段，tool 行在左栏展示
  const bubbles = transcript.filter(
    (item) => item.role === 'user' || item.role === 'assistant',
  );
  const started = Boolean(convId) || bubbles.length > 0;
  const lastIsAssistant = bubbles[bubbles.length - 1]?.role === 'assistant';

  // 新消息总落在底部：自动滚到底，省得手动追（流式增长时也要跟着走）
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [bubbles.length, approval, busy, streaming.length]);

  return (
    <Card>
      <CardHeader
        title={t('ai.chatTitle')}
        subtitle={t('ai.chatSubtitle')}
        actions={
          <div className="flex items-center gap-8">
            {/* 预案在任何时候都够得着（不只是空会话）：聊到一半想换套路是常事。
                value 固定为空 —— 它是个「动作选单」，选完就回到占位文案 */}
            {playbooks.length > 0 ? (
              <Select
                value=""
                onChange={(e) => {
                  const key = e.target.value;
                  if (key) onRunPlaybook(key);
                }}
                options={[
                  { label: t('ai.playbookPick'), value: '' },
                  ...playbooks.map((item) => ({
                    label: item.title,
                    value: item.key,
                  })),
                ]}
                disabled={busy || !hasHost}
                aria-label={t('ai.playbookPick')}
                title={t('ai.playbookPickHint')}
              />
            ) : null}
            {conversations.length > 0 ? (
              <Select
                value={convId}
                onChange={(e) => onSelectConversation(e.target.value)}
                options={conversations.map((item) => ({
                  value: item.id,
                  label: `${item.host_name} · ${formatDateTime(item.updated)}`,
                }))}
                aria-label={t('ai.chatHistory')}
                title={t('ai.chatHistory')}
              />
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              icon={<IconPlus size={14} />}
              onClick={onNewConversation}
              disabled={busy}
              title={t('ai.chatNewHint')}
            >
              {t('ai.chatNew')}
            </Button>
          </div>
        }
      />
      <div ref={bodyRef} className="flex flex-col gap-8 ai-console-scroll">
        {!started ? (
          <>
            <ChatBubble role="assistant">{t('ai.chatIntro')}</ChatBubble>
            {/* 先说清楚问的是哪台机器 —— 自由对话直接在这台上查。
                没选主机时不说：那时这句话只能显示成一个「-」，等于什么都没说 */}
            {hasHost ? (
              <div className="fs-xs text-muted">
                {t('ai.chatTarget', { host: hostLabel })}
              </div>
            ) : null}
            {/* 排障预案：点一下就按这套套路查。给的是**起点**，不是流程 ——
                不想用模板的人照样可以直接在下面打字 */}
            {playbooks.length > 0 && !busy ? (
              <div className="flex items-center gap-6 flex-wrap">
                {playbooks.map((item) => (
                  <Button
                    key={item.key}
                    variant="secondary"
                    size="sm"
                    title={item.hint}
                    disabled={!hasHost}
                    onClick={() => onRunPlaybook(item.key)}
                  >
                    {item.title}
                  </Button>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <>
            {/* 首轮没有用户消息（体检是自动发起的），补一句让对话读起来完整 */}
            {bubbles[0]?.role !== 'user' ? (
              <ChatBubble role="user">
                {t('ai.chatUserRequest', { host: hostLabel, model: modelLabel })}
              </ChatBubble>
            ) : null}

            {bubbles.map((item) =>
              item.role === 'user' ? (
                <ChatBubble key={item.id} role="user">
                  {item.content}
                </ChatBubble>
              ) : (
                // 模型的回答带 Markdown 记号（`**加粗**`、列表、行内命令），交给
                // RichText 排版。用户自己打的文字保持纯文本 —— 他要的是原样显示，
                // 不是被解释一遍
                <ChatBubble key={item.id} role="assistant">
                  <RichText text={item.content} />
                </ChatBubble>
              ),
            )}

            {/* 流式增量优先：它比「分析中…」更具体，逐字长出来的感觉也更好 */}
            {streaming ? (
              <ChatBubble role="assistant">
                <RichText text={streaming} />
              </ChatBubble>
            ) : busy && !approval && !lastIsAssistant ? (
              <ChatBubble role="assistant" pending>
                {t('ai.chatWorking')}
              </ChatBubble>
            ) : null}

            {/* 等待审批时不显示「分析中」—— 它其实停在等你拍板 */}

            {approval ? (
              <ApprovalCard request={approval} onDone={onApprovalDone} />
            ) : null}
          </>
        )}
      </div>

      <div className="flex items-center gap-8" style={{ marginTop: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder={t('ai.chatPlaceholder')}
            disabled={busy}
            onKeyDown={(e) => {
              // 回车发送；Shift+Enter 留给多行习惯
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (canSend && draft.trim()) onSend();
              }
            }}
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={onSend}
          loading={busy}
          disabled={!canSend || !draft.trim()}
        >
          {t('ai.chatSend')}
        </Button>
      </div>
    </Card>
  );
}

/** 对话气泡。用户侧靠右、AI 侧靠左，配色区分角色 */
function ChatBubble({
  role,
  children,
  pending = false,
}: {
  role: 'user' | 'assistant';
  children: ReactNode;
  pending?: boolean;
}) {
  const isUser = role === 'user';
  return (
    <div
      className="flex"
      style={{ justifyContent: isUser ? 'flex-end' : 'flex-start' }}
    >
      <div
        className="fs-sm"
        style={{
          maxWidth: '92%',
          padding: '8px 10px',
          borderRadius: 8,
          lineHeight: 1.7,
          background: isUser ? 'var(--accent-dim)' : 'var(--bg-elevated)',
          border: `1px solid ${isUser ? 'var(--accent-border)' : 'var(--border-muted)'}`,
        }}
      >
        {pending ? (
          <span className="flex items-center gap-6 text-muted">
            <Spinner size={12} />
            {children}
          </span>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function TimelineRow({ event }: { event: AiChatStreamEvent }) {
  const t = useT();

  if (event.type === 'stage') {
    return (
      <TimelineLine
        icon={<IconRefresh size={13} />}
        text={event.stage === 'queued' ? t('ai.stageQueued') : t('ai.stageCollect')}
      />
    );
  }
  if (event.type === 'thinking') {
    return (
      <TimelineLine
        icon={<IconSparkle size={13} />}
        text={t('ai.stepN', { n: event.step, max: event.max_steps })}
      />
    );
  }
  if (event.type === 'tool_start') {
    return (
      <TimelineLine
        icon={<IconSearch size={13} />}
        text={t('ai.toolStart', {
          tool: event.tool,
          // 有命令原文时不再重复参数：`journalctl -u sshd -n 60` 已经把
          // 「unit=sshd、lines=60」说清楚了，两个都显示只是噪音。
          // 内部工具（读报表/指标）没有命令，这时参数才是唯一的线索。
          args: event.command ? '' : formatArgs(event.args),
        })}
        detail={event.command}
      />
    );
  }
  if (event.type === 'tool_done') {
    return (
      <TimelineLine
        icon={event.ok ? <IconCheck size={13} /> : <IconAlert size={13} />}
        text={t('ai.toolDone', {
          tool: event.tool,
          mark: event.ok ? '✓' : '✕',
          ms: event.elapsed_ms ?? 0,
        })}
      />
    );
  }
  if (event.type === 'error') {
    return <TimelineLine icon={<IconAlert size={13} />} text={event.message} />;
  }
  return null;
}

/**
 * 过程时间线的一行。
 *
 * ``detail`` 放**命令原文**（见 :func:`CommandLine`）：工具名与参数说的是「调了
 * 什么」，命令说的才是「往这台机器里敲了什么」—— 后者才是用户要核对的东西。
 */
function TimelineLine({
  icon,
  text,
  detail,
}: {
  icon: ReactNode;
  text: string;
  detail?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-8 fs-sm">
        <span className="text-muted">{icon}</span>
        {/* min-width: 0 让长文本能正常折行，而不是把这一行撑宽 */}
        <span style={{ minWidth: 0 }}>{text}</span>
      </div>
      {detail ? <CommandLine command={detail} /> : null}
    </div>
  );
}

/** 一条命令的原文。等宽 + 单行横向滚动：长命令折行会把时间线搅成一团。 */
function CommandLine({ command }: { command: string }) {
  return (
    <code className="ai-command" title={command}>
      {command}
    </code>
  );
}

/** 参数压成一行展示；工具参数都很短（一个路径 / 一个单元名），不必展开 JSON */
function formatArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args || {}).map(([key, value]) => `${key}=${String(value)}`);
  return parts.length > 0 ? '（' + parts.join('、') + '）' : '';
}

/* ------------------------------------------------------------------ 结果区 */

/** 排序列：严重的在前。人打开这份报告是想先知道「有没有要紧事」 */
const SEVERITY_ORDER: Record<AiSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * 单条发现，可折叠。
 *
 * 折起来的理由很实在：一份排查常常有五六条发现，全展开就是一堵墙，用户的
 * 注意力被平均分配到「提示」和「严重」上 —— 而这两者的紧迫程度根本不是一回事。
 * 默认只展开严重的，其余收成一行标题，扫一眼就知道有没有事、要不要点开。
 */
function FindingRow({ finding, hostId }: { finding: AiFinding; hostId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  // 默认展开「紧急」项：那一档就是要让人当场看到证据，多一步点击都可能被跳过；
  // 其余收起，避免一整墙把注意力平均分给「提示」和「紧急」。
  const [open, setOpen] = useState(finding.severity === 'high');
  // 待处置的动作：点「处置」后填好，交给弹窗去预览 / 执行
  const [pending, setPending] = useState<{
    action: string;
    params: Record<string, unknown>;
  } | null>(null);

  // 没有详情就不给按钮：点了没反应比没有按钮更让人困惑
  const hasDetails =
    Boolean(finding.phenomenon) ||
    finding.evidence.length > 0 ||
    finding.source_ref.length > 0;

  // 只有结论指回了具体检查项（baseline:<key>）才谈得上「照这条建议去修」，
  // 且本人得有加固权限 —— 否则给了按钮也点不动，反而更困惑
  const baselineKeys = finding.source_ref
    .filter((ref) => ref.startsWith('baseline:'))
    .map((ref) => ref.slice('baseline:'.length));
  const canRemediate = baselineKeys.length > 0 && hasPermission('baseline.manage');

  // 结论出处能映射到某个功能页时，给一个直达入口（去重：同一页只留一个）
  const links = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ to: string; labelKey: MessageKey }> = [];
    for (const ref of finding.source_ref) {
      const hit = sourceRoute(ref);
      if (!hit || seen.has(hit.to)) continue;
      seen.add(hit.to);
      out.push(hit);
    }
    return out;
  }, [finding.source_ref]);

  return (
    <div style={{ padding: '12px 0' }}>
      <div className="flex items-center justify-between gap-12 flex-wrap">
        <div className="flex items-center gap-8" style={{ minWidth: 0 }}>
          <Badge
            variant={SEVERITY_BADGE[finding.severity] ?? 'neutral'}
            size="sm"
            dot
          >
            {severityLabel(t, finding.severity)}
          </Badge>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{finding.title}</span>
        </div>
        {/* 默认只给「有什么问题 + 该怎么办」，现象与证据收在按钮后面 ——
            不是每个人都想看命令输出，但每个人都得知道下一步做什么 */}
        {hasDetails ? (
          <Button
            variant="ghost"
            size="sm"
            icon={
              open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />
            }
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
          >
            {open ? t('ai.hideDetails') : t('ai.viewDetails')}
          </Button>
        ) : null}
      </div>

      {/* 建议常驻：排查最有用的产出就是「怎么办」，藏进折叠里等于没给 */}
      {finding.suggestion ? (
        <div className="mt-8 fs-sm" style={{ lineHeight: 1.7 }}>
          <span className="fs-xs text-muted" style={{ marginRight: 6 }}>
            {t('ai.suggestion')}
          </span>
          {finding.suggestion}
        </div>
      ) : null}

      {/* 行动区：能一键修的给「处置」，能定位的给「跳转」——
          AI 说该怎么办，用户点一下就能到达，别让人自己去菜单里翻 */}
      {canRemediate || links.length > 0 ? (
        <div className="flex items-center gap-8 flex-wrap" style={{ marginTop: 8 }}>
          {canRemediate ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                setPending({
                  action: 'baseline_hardening',
                  params: { host_id: hostId, keys: baselineKeys },
                })
              }
            >
              {t('ai.remediation.action')}
            </Button>
          ) : null}
          {links.length > 0 ? (
            <>
              <span className="fs-xs text-muted">{t('ai.gotoLabel')}</span>
              {links.map((link) => (
                <Button
                  key={link.to}
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate(link.to)}
                >
                  {t(link.labelKey)}
                </Button>
              ))}
            </>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <div className="flex flex-col gap-12" style={{ marginTop: 10 }}>
          {finding.phenomenon ? (
            <div style={{ lineHeight: 1.75 }}>{finding.phenomenon}</div>
          ) : null}

          {finding.evidence.length > 0 ? (
            <div>
              <div className="fs-xs text-muted">{t('ai.evidence')}</div>
              {/* 证据多半是命令输出：必须等宽 + 保留换行，
                  否则数字列对不齐，df -h 那种表根本读不成 */}
              <div
                className="mono fs-xs"
                style={{
                  marginTop: 4,
                  padding: '8px 10px',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-muted)',
                  borderRadius: 6,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 240,
                  overflow: 'auto',
                  lineHeight: 1.6,
                }}
              >
                {finding.evidence.join('\n')}
              </div>
            </div>
          ) : null}

          {finding.source_ref.length > 0 ? (
            <div className="flex items-center gap-8 flex-wrap fs-xs text-muted">
              {finding.source_ref.map((ref, index) => (
                <span key={index}>{ref}</span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {pending ? (
        <RemediationDialog
          action={pending.action}
          params={pending.params}
          onClose={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * 报告卡（控制台下方，全宽）。
 *
 * 首轮体检的产出落在这里：几个紧急、几个待改进、总体判断、逐条发现。
 * 与对话栏的分工是「对话讲过程、报告讲结论」—— 追问不必把整份报告重读一遍，
 * 而报告本身要能当一份可核对的文档看。
 */
function ReportCard({
  report,
  meta,
  previousFindings,
  onRerun,
}: {
  report: AiResult;
  /** 模型 / 耗时 / token / 工具数等元信息 */
  meta: ReportMeta | null;
  /** 上一次报告的发现；用来做「重新体检」的差异对比 */
  previousFindings: AiFinding[] | null;
  onRerun: () => void;
}) {
  const t = useT();

  const counts = useMemo(() => {
    const acc: Record<AiSeverity, number> = { high: 0, medium: 0, low: 0 };
    for (const item of report.findings) {
      acc[item.severity] = (acc[item.severity] ?? 0) + 1;
    }
    return acc;
  }, [report.findings]);

  const ordered = useMemo(
    () =>
      [...report.findings].sort(
        (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
      ),
    [report.findings],
  );

  // 与上一次报告对比：按标题（去空格、忽略大小写）算新增 / 消除。
  // 回答的是「修完之后好点没有」—— 这是重新体检的意义。
  const diff = useMemo(() => {
    if (!previousFindings) return null;
    const norm = (s: string) => s.trim().toLowerCase();
    const cur = new Set(report.findings.map((f) => norm(f.title)));
    const old = new Set(previousFindings.map((f) => norm(f.title)));
    let added = 0;
    let resolved = 0;
    for (const key of cur) if (!old.has(key)) added += 1;
    for (const key of old) if (!cur.has(key)) resolved += 1;
    return { added, resolved };
  }, [previousFindings, report.findings]);

  return (
    <>
      <Card>
        <CardHeader
          title={t('ai.summaryTitle')}
          subtitle={
            meta?.hostLabel
              ? `${meta.hostLabel}${meta.at ? ' · ' + formatDateTime(meta.at) : ''}`
              : undefined
          }
          actions={
            <div className="flex items-center gap-8">
              <Badge variant="neutral" size="sm">
                {t('ai.confidence')}：{confidenceLabel(t, report.confidence)}
              </Badge>
              {/* 重新体检 = 新开一条会话重跑一遍；这次与上次的发现逐条对比 */}
              <Button
                variant="ghost"
                size="sm"
                icon={<IconRefresh size={14} />}
                onClick={onRerun}
              >
                {t('ai.reinspect')}
              </Button>
            </div>
          }
        />
        {/* 先看规模：几个紧急、几个待改进 —— 比一上来读一整段话快得多 */}
        <div className="flex items-center gap-16 flex-wrap">
          {(['high', 'medium', 'low'] as AiSeverity[]).map((level) =>
            counts[level] ? (
              <span key={level} className="flex items-center gap-6">
                <Badge variant={SEVERITY_BADGE[level]} size="sm" dot>
                  {severityLabel(t, level)}
                </Badge>
                <span style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>
                  {counts[level]}
                </span>
              </span>
            ) : null,
          )}
        </div>

        {/* 差异：修完之后问题少了没有，一眼就能看出来 */}
        {diff ? (
          <div className="mt-12 flex items-center gap-8 flex-wrap fs-sm">
            <span className="text-muted">{t('ai.diffTitle')}</span>
            {diff.added > 0 ? (
              <Badge variant="warning" size="sm">
                {t('ai.diffAdded', { n: diff.added })}
              </Badge>
            ) : null}
            {diff.resolved > 0 ? (
              <Badge variant="success" size="sm">
                {t('ai.diffResolved', { n: diff.resolved })}
              </Badge>
            ) : null}
            {diff.added === 0 && diff.resolved === 0 ? (
              <Badge variant="neutral" size="sm">
                {t('ai.diffSame')}
              </Badge>
            ) : null}
          </div>
        ) : null}

        {/* 结论同样走 RichText：它也是模型写的散文，可能带 **加粗** 与行内命令 */}
        <div className="mt-12" style={{ fontSize: 15, lineHeight: 1.75 }}>
          <RichText text={report.summary} />
        </div>

        {/* 元信息摊成一行：模型、耗时、开销。这些是判断「这份结论值不值信」的
            参照，不该缩在角落里当脚注 */}
        {meta ? (
          <div className="mt-12 flex items-center gap-12 flex-wrap fs-xs text-muted">
            {meta.model ? (
              <span>{t('ai.metaModel', { model: meta.model })}</span>
            ) : null}
            {meta.ms != null ? (
              <span>{t('ai.metaTime', { ms: meta.ms })}</span>
            ) : null}
            <span>{t('ai.metaTokens', { tokens: meta.tokens ?? '-' })}</span>
            {meta.tools ? <span>{t('ai.metaTools', { n: meta.tools })}</span> : null}
          </div>
        ) : null}
      </Card>

      {ordered.length === 0 ? (
        <Card>
          <EmptyState title={t('ai.noFindings')} />
        </Card>
      ) : (
        /* 全部收进一张卡：五六张卡竖着排，翻起来像在刷信息流，
           看不出「一共几条、哪条要紧」 */
        <Card>
          <CardHeader
            title={`${t('ai.findingsTitle')}（${ordered.length}）`}
            subtitle={t('ai.findingsHint')}
          />
          <div className="flex flex-col">
            {ordered.map((item, index) => (
              <FindingRow
                key={`${item.title}-${index}`}
                finding={item}
                hostId={meta?.hostId ?? ''}
              />
            ))}
          </div>
        </Card>
      )}

      {report.data_gaps.length > 0 ? (
        <Card>
          <CardHeader title={t('ai.dataGaps')} subtitle={t('ai.dataGapsHint')} />
          <ul className="desc-list" style={{ paddingLeft: 18 }}>
            {report.data_gaps.map((gap, i) => (
              <li key={i} className="desc-item fs-sm">
                {gap}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ 排查记录 */

const STATUS_BADGE: Record<string, BadgeVariant> = {
  done: 'success',
  failed: 'danger',
  running: 'warning',
};

const SESSION_STATUSES = ['done', 'failed', 'running'];

/** 状态词条只覆盖已知值；库里出现别的值时原样显示，别编一个不存在的词条键 */
function statusLabel(t: TFunc, status: string): string {
  return SESSION_STATUSES.includes(status)
    ? t(`ai.status.${status}` as MessageKey)
    : status || '-';
}

const PAGE_SIZE = 15;

/**
 * 工具调用明细（排查记录）。
 *
 * 这是整个 AI 功能里最该存在的一页：它回答的是「AI 到底在我机器上跑了什么」。
 * 结论可以不信，但过程必须能查 —— 少了这个，用户只能选择相信或拒绝；有了它，
 * 才能核对。数据来自 ai_sessions / ai_tool_calls 两张审计表，普通用户只看到
 * 自己的记录，管理员看全部。
 */
function RecordsPanel({
  hosts,
  onOpenConversation,
}: {
  hosts: Array<{ label: string; value: string }>;
  /** 这条记录属于某条会话时，允许跳回去继续对话 */
  onOpenConversation: (conversationId: string) => void;
}) {
  const t = useT();
  const [hostId, setHostId] = useState('');
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState('');
  /**
   * 两种视角：**运行记录**回答「AI 在我机器上跑了什么命令」（审计），
   * **会话**回答「我和它聊了哪些、结论是什么」（回顾）。同一批数据，两种问法。
   */
  const [view, setView] = useState<'runs' | 'conversations'>('runs');

  const sessionsQuery = useQuery({
    queryKey: ['ai', 'sessions', hostId, page],
    queryFn: () =>
      aiApi.sessions({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, host_id: hostId }),
  });

  const detailQuery = useQuery({
    queryKey: ['ai', 'session', openId],
    queryFn: () => aiApi.sessionDetail(openId),
    enabled: Boolean(openId),
  });

  const total = sessionsQuery.data?.total ?? 0;
  const rows = sessionsQuery.data?.items ?? [];
  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  // 这条记录所属的会话（一次性排查 / 旧记录为空）；非空时给一个「回去继续对话」的入口
  const detailConversationId = detailQuery.data?.session.conversation_id || '';

  // 落库的结论（summary + findings）。旧记录可能没有 —— 那时退化成只展示工具明细。
  const sessionResult = useMemo<AiResult | null>(() => {
    const raw = detailQuery.data?.session.result;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as AiResult;
      return parsed && Array.isArray(parsed.findings) ? parsed : null;
    } catch {
      return null;
    }
  }, [detailQuery.data]);

  const columns: Column<AiSession>[] = [
    {
      key: 'created',
      header: t('ai.recTime'),
      width: 170,
      render: (row) => formatDateTime(row.created),
    },
    {
      key: 'host',
      header: t('ai.recHost'),
      render: (row) => row.host_name || row.host_id || '-',
    },
    {
      key: 'model',
      header: t('ai.recModel'),
      render: (row) => row.model || row.provider || '-',
    },
    {
      key: 'status',
      header: t('ai.recStatus'),
      width: 110,
      render: (row) => (
        <Badge variant={STATUS_BADGE[row.status] ?? 'neutral'} size="sm">
          {statusLabel(t, row.status)}
        </Badge>
      ),
    },
    {
      key: 'steps',
      header: t('ai.recSteps'),
      width: 80,
      align: 'right',
      render: (row) => row.steps ?? 0,
    },
    {
      key: 'tools',
      header: t('ai.recTools'),
      width: 90,
      align: 'right',
      render: (row) => row.tool_calls ?? 0,
    },
    {
      key: 'tokens',
      header: t('ai.recTokens'),
      width: 100,
      align: 'right',
      render: (row) => row.total_tokens || '-',
    },
    {
      key: 'duration',
      header: t('ai.recDuration'),
      width: 110,
      align: 'right',
      render: (row) => (row.duration_ms ? `${row.duration_ms} ms` : '-'),
    },
  ];

  return (
    <>
      <Card>
        <SegmentedControl
          value={view}
          onChange={(next) => {
            setView(next);
            setPage(0);
            setOpenId('');
          }}
          options={[
            { label: t('ai.recViewRuns'), value: 'runs' },
            { label: t('ai.recViewConversations'), value: 'conversations' },
          ]}
          ariaLabel={t('ai.tabRecords')}
        />
        <div
          className="flex items-end justify-between gap-12 flex-wrap"
          style={{ marginTop: 12 }}
        >
          <div style={{ flex: '1 1 260px', maxWidth: 360 }}>
            <Field label={t('ai.recFilterHost')}>
              <Select
                value={hostId}
                onChange={(e) => {
                  setHostId(e.target.value);
                  setPage(0);
                  setOpenId('');
                }}
                options={[{ label: t('ai.recAllHosts'), value: '' }, ...hosts]}
              />
            </Field>
          </div>
          {/* 导出的是「运行记录」宽表，会话视角下没有对应物，就不显示 */}
          {view === 'runs' ? (
            <div className="flex items-center gap-12 flex-wrap">
              <span className="fs-sm text-muted">{t('ai.recTotal', { n: total })}</span>
              {/* 走 window.open 而不是取回来拼 Blob：附件下载交给浏览器接管，
                  不必把整张表读进内存；认证走 cookie，新标签页也带得上。 */}
              <Button
                variant="secondary"
                size="sm"
                icon={<IconDownload size={15} />}
                disabled={total === 0}
                onClick={() =>
                  window.open(exportUrl('ai', { host_id: hostId || undefined }), '_blank')
                }
                title={t('ai.recExportHint')}
              >
                {t('ai.recExport')}
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      {view === 'conversations' ? (
        <ConversationsPanel
          // 换主机就重挂：内部页码与展开项一起归零
          key={hostId}
          hostId={hostId}
          onOpenConversation={onOpenConversation}
        />
      ) : (
        <>
      

      <Card>
        {sessionsQuery.isError ? (
          <ErrorState
            title={t('ai.failed')}
            message={errorMessage(sessionsQuery.error)}
            onRetry={() => void sessionsQuery.refetch()}
          />
        ) : (
          <Table<AiSession>
            caption={t('ai.tabRecords')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={sessionsQuery.isLoading}
            emptyTitle={t('ai.recEmptyTitle')}
            emptyDescription={t('ai.recEmptyDesc')}
            onRowClick={(row) => setOpenId((prev) => (prev === row.id ? '' : row.id))}
            isRowSelected={(row) => row.id === openId}
            rowTitle={() => t('ai.recClickHint')}
          />
        )}

        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-end gap-8 mt-12">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              {t('ai.recPrev')}
            </Button>
            <span className="fs-sm text-muted">
              {page + 1} / {maxPage + 1}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= maxPage}
              onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
            >
              {t('ai.recNext')}
            </Button>
          </div>
        ) : null}
      </Card>

      {openId ? (
        <Card>
          <CardHeader
            title={t('ai.recDetail')}
            subtitle={t('ai.recDetailHint')}
            actions={
              <div className="flex items-center gap-8">
                {/* 这条记录属于某条会话时，给一个「回去接着聊」的入口 ——
                    记录只能看到「跑了什么」，接着聊才是看结论的入口 */}
                {detailConversationId ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<IconChevronRight size={14} />}
                    onClick={() => onOpenConversation(detailConversationId)}
                    title={t('ai.recOpenConversationHint')}
                  >
                    {t('ai.recOpenConversation')}
                  </Button>
                ) : null}
                <Button variant="ghost" size="sm" onClick={() => setOpenId('')}>
                  {t('ai.recClose')}
                </Button>
              </div>
            }
          />
          {detailQuery.isLoading ? (
            <div className="flex flex-col gap-8">
              <Skeleton height={16} width="40%" />
              <Skeleton height={14} />
              <Skeleton height={14} width="70%" />
            </div>
          ) : (
            <div className="flex flex-col gap-16">
              {/* 先给结论、再给过程：回看一次排查，最想知道的是「当时判断是什么」，
                  其次才是「它跑了哪些命令」。结论是落库的（ai_sessions.result）。 */}
              {sessionResult ? (
                <div className="flex flex-col gap-8">
                  <div className="fs-xs text-muted">{t('ai.recConclusion')}</div>
                  <div style={{ fontSize: 15, lineHeight: 1.75 }}>
                    {sessionResult.summary}
                  </div>
                  {sessionResult.findings.length > 0 ? (
                    <div className="flex flex-col gap-6">
                      {sessionResult.findings.map((item, index) => (
                        <div
                          key={`${item.title}-${index}`}
                          className="flex items-center gap-8 flex-wrap fs-sm"
                        >
                          <Badge
                            variant={SEVERITY_BADGE[item.severity] ?? 'neutral'}
                            size="sm"
                            dot
                          >
                            {severityLabel(t, item.severity)}
                          </Badge>
                          <span>{item.title}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {(detailQuery.data?.calls ?? []).length === 0 ? (
                // 有结论、只是没调工具时，不必占一整块空状态，一句话带过即可
                sessionResult ? (
                  <span className="fs-xs text-muted">{t('ai.recNoCalls')}</span>
                ) : (
                  <EmptyState title={t('ai.recNoCalls')} />
                )
              ) : (
                <div className="flex flex-col gap-12">
                  {(detailQuery.data?.calls ?? []).map((call) => (
                    <div key={call.id} className="flex flex-col gap-6">
                      <div className="flex items-center gap-8 fs-sm flex-wrap">
                        <Badge variant={call.ok ? 'success' : 'warning'} size="sm">
                          {call.ok ? '✓' : '✕'}
                        </Badge>
                        <span className="mono">{call.tool}</span>
                        <span className="text-muted">{call.args}</span>
                        {call.elapsed_ms ? (
                          <span className="fs-xs text-muted">{call.elapsed_ms} ms</span>
                        ) : null}
                      </div>
                      <pre
                        className="mono fs-xs"
                        style={{
                          whiteSpace: 'pre-wrap',
                          margin: 0,
                          maxHeight: 220,
                          overflow: 'auto',
                        }}
                      >
                        {call.output || '-'}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      ) : null}
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ 会话视角 */

/**
 * 记录页的「会话」视角：一条会话一行，展开看它聊了什么。
 *
 * 与「运行记录」的分工：那边是审计（AI 在你机器上跑过哪些命令），这边是回顾
 * （你问过什么、它答了什么、结论是什么）。同一条会话里的工具调用也是审计的一
 * 部分，所以展开后一并列出。
 */
function ConversationsPanel({
  hostId,
  onOpenConversation,
}: {
  hostId: string;
  onOpenConversation: (conversationId: string) => void;
}) {
  const t = useT();
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState('');

  const listQuery = useQuery({
    queryKey: ['ai', 'conversations', hostId, page],
    queryFn: () =>
      aiApi.conversations({
        host_id: hostId || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
  });

  const detailQuery = useQuery({
    queryKey: ['ai', 'conversation', openId],
    queryFn: () => aiApi.conversation(openId),
    enabled: Boolean(openId),
  });

  const total = listQuery.data?.total ?? 0;
  const rows = listQuery.data?.items ?? [];
  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  // context 是喂给模型的 [数据] 段，不是人说的话，不展示
  const messages = (detailQuery.data?.messages ?? []).filter(
    (item) => item.role !== 'context',
  );

  const columns: Column<AiConversation>[] = [
    {
      key: 'updated',
      header: t('ai.recTime'),
      width: 170,
      render: (row) => formatDateTime(row.updated),
    },
    {
      key: 'host',
      header: t('ai.recHost'),
      render: (row) => row.host_name || row.host_id || '-',
    },
    {
      key: 'provider',
      header: t('ai.recModel'),
      render: (row) => row.provider || '-',
    },
    {
      key: 'runs',
      header: t('ai.recConvRuns'),
      width: 90,
      align: 'right',
      render: (row) => row.runs ?? 0,
    },
    {
      key: 'report',
      header: t('ai.recConvReport'),
      width: 90,
      render: (row) =>
        row.report ? (
          <Badge variant="success" size="sm">
            {t('ai.recConvHasReport')}
          </Badge>
        ) : (
          <Badge variant="neutral" size="sm">
            {t('ai.recConvNoReport')}
          </Badge>
        ),
    },
  ];

  return (
    <>
      <Card>
        {listQuery.isError ? (
          <ErrorState
            title={t('ai.failed')}
            message={errorMessage(listQuery.error)}
            onRetry={() => void listQuery.refetch()}
          />
        ) : (
          <Table<AiConversation>
            caption={t('ai.recViewConversations')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={listQuery.isLoading}
            emptyTitle={t('ai.recConvEmptyTitle')}
            emptyDescription={t('ai.recConvEmptyDesc')}
            onRowClick={(row) => setOpenId((prev) => (prev === row.id ? '' : row.id))}
            isRowSelected={(row) => row.id === openId}
            rowTitle={() => t('ai.recClickHint')}
          />
        )}

        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-end gap-8 mt-12">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              {t('ai.recPrev')}
            </Button>
            <span className="fs-sm text-muted">
              {page + 1} / {maxPage + 1}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= maxPage}
              onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
            >
              {t('ai.recNext')}
            </Button>
          </div>
        ) : null}
      </Card>

      {openId ? (
        <Card>
          <CardHeader
            title={t('ai.recConvDetail')}
            subtitle={t('ai.recConvDetailHint')}
            actions={
              <div className="flex items-center gap-8">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconChevronRight size={14} />}
                  onClick={() => onOpenConversation(openId)}
                  title={t('ai.recOpenConversationHint')}
                >
                  {t('ai.recOpenConversation')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setOpenId('')}>
                  {t('ai.recClose')}
                </Button>
              </div>
            }
          />
          {detailQuery.isLoading ? (
            <div className="flex flex-col gap-8">
              <Skeleton height={16} width="40%" />
              <Skeleton height={14} />
              <Skeleton height={14} width="70%" />
            </div>
          ) : messages.length === 0 ? (
            <EmptyState title={t('ai.recConvEmptyMessages')} />
          ) : (
            <div className="flex flex-col gap-10">
              {messages.map((item) => (
                <div key={item.id} className="flex flex-col gap-4">
                  <span className="fs-xs text-muted">
                    {item.role === 'user'
                      ? t('ai.recRoleUser')
                      : item.role === 'tool'
                        ? t('ai.recRoleTool')
                        : t('ai.recRoleAssistant')}
                    {item.role === 'tool' && item.tool_name
                      ? ' · ' + item.tool_name
                      : ''}
                    {item.role === 'tool' ? (item.ok ? ' ✓' : ' ✕') : ''}
                  </span>
                  <div
                    className={item.role === 'tool' ? 'mono fs-xs' : 'fs-sm'}
                    style={{
                      lineHeight: 1.7,
                      whiteSpace: 'pre-wrap',
                      maxHeight: item.role === 'tool' ? 160 : undefined,
                      overflow: 'auto',
                    }}
                  >
                    {item.content || '-'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ 能力说明 */

/**
 * 「这个助手能做什么」。
 *
 * 这是个会**登录到用户服务器上执行命令**的功能。让人在按下按钮之前就知道边界，
 * 比把说明藏起来要好 —— 不清楚它能干什么时，人要么不敢用，要么误以为它什么都能干。
 *
 * 工具清单与命令白名单 / 黑名单都由后端从 aitools 实时生成
 * （/api/ai/capabilities），所以不会出现「文档说能做、代码其实做不了」这种
 * 最伤信任的情况 —— 用户判断「敢不敢把机器交给它」，靠的正是这些具体清单。
 */
function CapabilitiesModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const query = useQuery({
    queryKey: ['ai', 'capabilities'],
    queryFn: aiApi.capabilities,
    enabled: open,
  });

  const tools = query.data?.tools ?? [];
  const internal = tools.filter((item) => item.kind === 'internal');
  const host = tools.filter((item) => item.kind === 'host');
  const policy = query.data?.policy;

  /** 字符黑名单：换行没法直接显示成一个字符，换成词条说清楚，其余原样展示。 */
  const deniedMetachars = useMemo(() => {
    const out: string[] = [];
    for (const item of policy?.denied_metachars ?? []) {
      const label = item === '\n' || item === '\r' ? t('ai.policyMetacharNewline') : item;
      if (!out.includes(label)) out.push(label);
    }
    return out;
  }, [policy, t]);

  /**
   * 逐命令的参数限制：后端把「子命令白名单 / 参数黑名单 / 子串黑名单」分成三张表，
   * 这里按命令名并成一行一条 —— 按表分开列，用户得自己来回对照哪个限制属于谁。
   */
  const commandRules = useMemo(() => {
    if (!policy) return [];
    const names = new Set([
      ...Object.keys(policy.subcommand_allow),
      ...Object.keys(policy.token_deny),
      ...Object.keys(policy.substr_deny),
    ]);
    return [...names].sort().map((name) => ({
      name,
      allow: policy.subcommand_allow[name] ?? [],
      deny: policy.token_deny[name] ?? [],
      substr: policy.substr_deny[name] ?? [],
    }));
  }, [policy]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('ai.capabilities')}
      description={t('ai.capSubtitle')}
      size="lg"
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      {query.isLoading ? (
        <div className="flex flex-col gap-8">
          <Skeleton height={16} />
          <Skeleton height={16} width="80%" />
          <Skeleton height={16} width="60%" />
        </div>
      ) : (
        <div className="flex flex-col gap-16">
          <Notice tone="info">{t('ai.capIntro')}</Notice>

          <section className="flex flex-col gap-6">
            <strong className="fs-sm">
              {t('ai.capInternalTitle')}（{internal.length}）
            </strong>
            <span className="fs-sm text-muted">{t('ai.capInternalBody')}</span>
            {internal.map((item) => (
              <div key={item.name} className="flex flex-col gap-4">
                <span className="mono fs-sm">{item.name}</span>
                <span className="fs-xs text-muted">{item.description}</span>
              </div>
            ))}
          </section>

          <section className="flex flex-col gap-6">
            <strong className="fs-sm">
              {t('ai.capHostTitle')}（{host.length}）
            </strong>
            <span className="fs-sm text-muted">{t('ai.capHostBody')}</span>
            {host.map((item) => (
              <div key={item.name} className="flex flex-col gap-4">
                <span className="mono fs-sm">{item.name}</span>
                <span className="fs-xs text-muted">{item.description}</span>
              </div>
            ))}
          </section>

          {/* 白名单 / 黑名单：上面说的是「能做什么」，这里把「具体允许什么、
              一律拒绝什么」摊开。清单来自后端与执行时同一份规则，所以不会
              出现「说明页写得很安全、实际校验是另一套」的情况。 */}
          {policy ? (
            <section className="ai-policy">
              <strong className="fs-sm">{t('ai.policyTitle')}</strong>
              <span className="fs-xs text-muted">{t('ai.policyHint')}</span>

              <div className="ai-policy-block">
                <span className="ai-policy-label">
                  {t('ai.policyReadonlyTitle', { n: policy.readonly_commands.length })}
                </span>
                <span className="fs-xs text-muted">{t('ai.policyReadonlyHint')}</span>
                <div className="ai-chip-row">
                  {policy.readonly_commands.map((name) => (
                    <code key={name} className="ai-chip">
                      {name}
                    </code>
                  ))}
                </div>
              </div>

              <div className="ai-policy-block">
                <span className="ai-policy-label">{t('ai.policyMetacharTitle')}</span>
                <span className="fs-xs text-muted">{t('ai.policyMetacharHint')}</span>
                <div className="ai-chip-row">
                  {deniedMetachars.map((item) => (
                    <code key={item} className="ai-chip ai-chip-deny">
                      {item}
                    </code>
                  ))}
                </div>
              </div>

              {commandRules.length > 0 ? (
                <div className="ai-policy-block">
                  <span className="ai-policy-label">{t('ai.policyParamTitle')}</span>
                  {commandRules.map((rule) => (
                    <div key={rule.name} className="ai-policy-rule">
                      <code className="ai-chip">{rule.name}</code>
                      {rule.allow.length > 0 ? (
                        <span className="fs-xs text-muted">
                          {t('ai.policyParamSubAllow')}：{rule.allow.join(' / ')}
                        </span>
                      ) : null}
                      {rule.deny.length > 0 ? (
                        <span className="fs-xs text-danger">
                          {t('ai.policyParamTokenDeny')}：{rule.deny.join(' / ')}
                        </span>
                      ) : null}
                      {rule.substr.length > 0 ? (
                        <span className="fs-xs text-danger">
                          {t('ai.policyParamSubstrDeny')}：{rule.substr.join(' / ')}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="ai-policy-block">
                <span className="ai-policy-label">{t('ai.policyPathTitle')}</span>
                <div className="ai-chip-row">
                  <span className="fs-xs text-muted">{t('ai.policyPathDirs')}：</span>
                  {policy.allowed_dirs.map((item) => (
                    <code key={item} className="ai-chip">
                      {item}
                    </code>
                  ))}
                </div>
                <div className="ai-chip-row">
                  <span className="fs-xs text-muted">{t('ai.policyPathFiles')}：</span>
                  {policy.allowed_files.map((item) => (
                    <code key={item} className="ai-chip">
                      {item}
                    </code>
                  ))}
                </div>
                <span className="fs-xs text-danger">
                  {t('ai.policyPathForbidden')}：{policy.forbidden_hints.join(' / ')}
                </span>
              </div>

              <div className="ai-policy-block">
                <span className="ai-policy-label">{t('ai.policyWriteTitle')}</span>
                <span className="fs-xs text-muted">{t('ai.policyWriteHint')}</span>
                <div className="flex flex-col gap-4">
                  {policy.write_forbidden.map((item) => (
                    <span key={item} className="fs-xs text-danger">
                      · {item}
                    </span>
                  ))}
                </div>
                <span className="fs-xs text-muted">
                  {t('ai.policyWriteLimit', { n: policy.max_write_length })}
                </span>
              </div>

              <div className="ai-policy-block">
                <span className="ai-policy-label">{t('ai.policyImplTitle')}</span>
                <ol className="ai-policy-steps">
                  <li>{t('ai.policyImplTemplate')}</li>
                  <li>{t('ai.policyImplArgs')}</li>
                  <li>{t('ai.policyImplQuote')}</li>
                  <li>{t('ai.policyImplSudo')}</li>
                  <li>{t('ai.policyImplAudit')}</li>
                </ol>
                <span className="fs-xs text-muted">{t('ai.policyImplAccount')}</span>
              </div>
            </section>
          ) : null}

          <Notice tone="warning" title={t('ai.capLimitTitle')}>
            {t('ai.capLimitBody', {
              steps: query.data?.max_steps ?? 0,
              seconds: query.data?.timeout_seconds ?? 0,
            })}
          </Notice>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ 选人下拉 */

/**
 * 可搜索的**多选**下拉，用来挑授权给谁。
 *
 * 为什么不用现成的 ``Select``：它是原生 select，没法边打字边过滤。用户一多，
 * 在一个长列表里翻找某个名字是纯粹的体力活 —— 而授权这种操作，选错人的代价
 * 不小（等于把你的模型额度和数据访问交出去），所以给它一个搜索框是值得的。
 *
 * 选中后**不收起**，因为授权通常是连续勾几个人。
 */
function UserPicker({
  users,
  selected,
  onToggle,
  placeholder,
  emptyText,
}: {
  users: string[];
  selected: string[];
  onToggle: (name: string) => void;
  placeholder: string;
  emptyText: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 点外面或按 Esc 收起：浮层常驻会挡住下面的字段，也让人以为还在编辑
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const keyword = query.trim().toLowerCase();
  const matched = keyword
    ? users.filter((name) => name.toLowerCase().includes(keyword))
    : users;

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <Input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        aria-expanded={open}
        role="combobox"
      />
      {open ? (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 30,
            maxHeight: 208,
            overflowY: 'auto',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(16, 24, 40, 0.12)',
            padding: 4,
          }}
        >
          {matched.length === 0 ? (
            <div className="fs-xs text-muted" style={{ padding: '8px 10px' }}>
              {emptyText}
            </div>
          ) : (
            matched.map((name) => {
              const on = selected.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => onToggle(name)}
                  style={
                    {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '7px 10px',
                      border: 0,
                      borderRadius: 6,
                      background: on ? 'var(--bg-hover)' : 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      fontSize: 13,
                      cursor: 'pointer',
                      textAlign: 'left',
                    } as React.CSSProperties
                  }
                >
                  <span style={{ width: 14 }}>{on ? '✓' : ''}</span>
                  <span>{name}</span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ 配置面板 */

function SettingsModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { isAdmin } = useAuth();
  const configQuery = useQuery({
    queryKey: ['ai', 'config'],
    // 管理员读全平台配置；普通用户只读自己的（外加平台共享的只读项）。
    // 不是权限宽严的问题：别人配的模型背后是别人的 key，看得见就等于能用。
    queryFn: () => (isAdmin ? aiApi.config() : aiApi.myProviders()),
    enabled: open,
  });

  // 授权名单要挑人；只有管理员会用，普通用户不必拉这份列表
  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list(),
    enabled: open && isAdmin,
  });
  // 下拉要的是字符串列表；其余字段在这里用不上
  const userNames = useMemo(
    () => (usersQuery.data ?? []).map((item) => item.username),
    [usersQuery.data],
  );

  const [enabled, setEnabled] = useState(false);
  const [hours, setHours] = useState(24);
  /** 单次排查累计 token 上限：到顶直接收口，防止一次跑飞烧穿额度 */
  const [tokenBudget, setTokenBudget] = useState(60000);
  /** 回复字数上限的两个档位：自由对话 / 预案（跑完一整套排查）各一个 */
  const [replyCharsTerse, setReplyCharsTerse] = useState(150);
  const [replyCharsDeep, setReplyCharsDeep] = useState(400);
  const [drafts, setDrafts] = useState<ProviderDraft[]>([]);
  const [activeId, setActiveId] = useState('');
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState('');
  /** 连通性测试结果（模型 id → 通不通）。
   只有真测过才敢说「已接入」—— 没验证就标绿，等于骗人。 */
  const [testResults, setTestResults] = useState<Record<string, boolean>>({});

  const presets = useMemo(
    () => configQuery.data?.presets ?? [],
    [configQuery.data],
  );

  /** 厂商名 → 预设：用来展示该厂商的常用模型候选 */
  const presetByName = useMemo(() => {
    const map = new Map<string, AiPreset>();
    for (const item of presets) {
      if (item.name) map.set(item.name, item);
    }
    return map;
  }, [presets]);

  /** 选项带上分组前缀，否则「国内 / 国际 / 本地」在扁平列表里看不出来 */
  const presetOptions = useMemo(
    () =>
      presets.map((item) => ({
        value: item.name,
        label: item.custom
          ? t('ai.presetCustom')
          : `${t(`ai.group.${item.group}` as MessageKey)} · ${item.name}`,
      })),
    [presets, t],
  );

  // 每次打开都从服务端拉一份最新配置，避免拿着上一次的草稿改
  useEffect(() => {
    if (!open || !configQuery.data) return;
    const cfg: AiConfig = configQuery.data;
    setEnabled(cfg.enabled);
    setHours(cfg.hours ?? 24);
    setTokenBudget(cfg.token_budget ?? 60000);
    setReplyCharsTerse(cfg.reply_chars_terse ?? 150);
    setReplyCharsDeep(cfg.reply_chars_deep ?? 400);
    setDrafts((cfg.providers ?? []).map(toDraft));
    setActiveId(cfg.active_id ?? (cfg.providers?.[0]?.id ?? ''));
  }, [open, configQuery.data]);

  function patch(index: number, next: Partial<ProviderDraft>) {
    setDrafts((list) =>
      list.map((item, i) => (i === index ? { ...item, ...next } : item)),
    );
  }

  /**
   * 选中厂商后把「猜不出来」的字段一次填好。
   *
   * 模型名直接覆盖成第一个候选而不是保留旧值：换了厂商，旧模型名基本一定无效，
   * 留着反而会让人以为配好了却调不通。用户仍可手改。
   */
  function applyPreset(index: number, presetName: string) {
    const preset = presetByName.get(presetName);
    if (!preset) {
      patch(index, { presetName: '' });
      return;
    }
    patch(index, {
      presetName: preset.name,
      name: drafts[index]?.name?.trim() ? drafts[index].name : preset.name,
      kind: preset.kind,
      base_url: preset.base_url,
      model: preset.models[0] ?? '',
    });
  }

  const presetModelsOf = (draft: ProviderDraft): string[] =>
    draft.presetName ? presetByName.get(draft.presetName)?.models ?? [] : [];

  /** 勾选/取消一个被授权人。授权的是「用」的权限，不是「管」——对方改不了这条 */
  function toggleGrant(index: number, username: string) {
    setDrafts((list) =>
      list.map((item, i) => {
        if (i !== index) return item;
        const current = item.granted ?? [];
        return {
          ...item,
          granted: current.includes(username)
            ? current.filter((name) => name !== username)
            : [...current, username],
        };
      }),
    );
  }

  /** 必填项齐了没有。这只说明「填完了」，**不代表连得上** —— 连不连通由
      测试按钮说了算，测过的结果记在 testResults 里。 */
  const isConfigured = (item: ProviderDraft): boolean =>
    Boolean(
      item.name.trim() &&
        item.base_url.trim() &&
        item.model.trim() &&
        (item.api_key.trim() || item.api_key_set),
    );

  function addProvider() {
    setDrafts((list) => [...list, emptyDraft()]);
  }

  function removeProvider(index: number) {
    setDrafts((list) => list.filter((_, i) => i !== index));
  }

  async function test(index: number) {
    const draft = drafts[index];
    if (!draft.base_url || !draft.model) {
      toast.error(t('ai.fieldRequired'));
      return;
    }
    setTestingId(draft.id || `#${index}`);
    try {
      const reply = await aiApi.testProvider({ ...draft });
      setTestResults((prev) => ({ ...prev, [draft.id]: true }));
      // note：连得上，但有话要说（推理模型只输出了思考过程就被测试预算截断）。
      // 用 info 而不是 success —— 结论确实是「通了」，但得顺带说清为什么没看到
      // 正文，否则用户会以为测试没生效、又去折腾地址。
      if (reply.note) {
        toast.info(t('ai.testOk'), reply.note);
      } else {
        toast.success(t('ai.testOk'), reply.model || '');
      }
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [draft.id]: false }));
      toast.error(t('ai.testFailed'), errorMessage(err));
    } finally {
      setTestingId('');
    }
  }

  async function save() {
    const invalid = drafts.find(
      (item) => !item.name.trim() || !item.base_url.trim() || !item.model.trim(),
    );
    if (invalid) {
      toast.error(t('ai.fieldRequired'));
      return;
    }
    setSaving(true);
    try {
      const providers = drafts
        // 平台共享项对普通用户只读：不回传（后端也会忽略，这里是不让它出现在
        // 提交里，免得界面上看起来像"我改了"其实没生效）
        .filter((item) => isAdmin || !item.readonly)
        .map((item) => ({
          id: item.id,
          name: item.name,
          kind: item.kind,
          base_url: item.base_url,
          model: item.model,
          api_key: item.api_key,
          enabled: item.enabled,
          granted: item.granted ?? [],
        }));

      if (isAdmin) {
        await aiApi.saveConfig({
          enabled,
          hours,
          token_budget: tokenBudget,
          reply_chars_terse: replyCharsTerse,
          reply_chars_deep: replyCharsDeep,
          active_id: activeId,
          providers,
        });
      } else {
        // 个人只能提交自己的；归属由后端强制盖上，这里传什么都不作数。
        // 分析窗口与 token 上限一并提交：它们记在**这个人**名下（普通用户用的是
        // 自己的模型和自己的额度），不是改平台默认值
        await aiApi.saveMyProviders({
          providers,
          hours,
          token_budget: tokenBudget,
          reply_chars_terse: replyCharsTerse,
          reply_chars_deep: replyCharsDeep,
        });
      }
      toast.success(t('ai.saved'));
      onSaved();
      onClose();
    } catch (err) {
      toast.error(t('ai.saveFailed'), errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('ai.settingsTitle')}
      description={t('ai.settingsDesc')}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {t('ai.save')}
          </Button>
        </>
      }
    >
      {configQuery.isLoading ? (
        <div className="flex flex-col gap-8">
          <Skeleton height={18} width="35%" />
          <Skeleton height={14} />
          <Skeleton height={14} width="60%" />
        </div>
      ) : null}

      {!configQuery.isLoading ? (
        <>
          {/* 普通用户看到的是「我的模型」：平台共享项置灰，别人配的压根不出现 */}
          {!isAdmin ? <Notice tone="info">{t('ai.myModelsOnly')}</Notice> : null}

          <Switch
            checked={enabled}
            onChange={setEnabled}
            label={t('ai.enable')}
            hint={t('ai.enableHint')}
          />

          {/* 这几项决定「一次排查跑多大、回答写多长」：分析窗口是往回看多少数据，
              token 上限是最多烧多少额度，两个字数档是回答的字数上限。放在模型列表
              **上面** —— 它们管的是整次排查而不是某一个模型。而且普通用户用的是自己
              的模型、花自己的额度（见后端 visible_providers 的说明），这些数理应由他
              自己定，不必全平台共用一个值。 */}
          <div className="flex items-end gap-12 flex-wrap mt-16">
            <div style={{ maxWidth: 260, flex: '1 1 200px' }}>
              <Field label={t('ai.hours')} hint={t('ai.hoursHint')}>
                <Input
                  type="number"
                  min={1}
                  max={168}
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value) || 24)}
                />
              </Field>
            </div>
            <div style={{ maxWidth: 260, flex: '1 1 200px' }}>
              <Field label={t('ai.tokenBudget')} hint={t('ai.tokenBudgetHint')}>
                <Input
                  type="number"
                  min={4000}
                  max={100000000}
                  value={tokenBudget}
                  onChange={(e) => setTokenBudget(Number(e.target.value) || 60000)}
                />
              </Field>
            </div>
            <div style={{ maxWidth: 260, flex: '1 1 200px' }}>
              <Field label={t('ai.replyCharsTerse')} hint={t('ai.replyCharsTerseHint')}>
                <Input
                  type="number"
                  min={50}
                  max={5000}
                  value={replyCharsTerse}
                  onChange={(e) => setReplyCharsTerse(Number(e.target.value) || 150)}
                />
              </Field>
            </div>
            <div style={{ maxWidth: 260, flex: '1 1 200px' }}>
              <Field label={t('ai.replyCharsDeep')} hint={t('ai.replyCharsDeepHint')}>
                <Input
                  type="number"
                  min={50}
                  max={5000}
                  value={replyCharsDeep}
                  onChange={(e) => setReplyCharsDeep(Number(e.target.value) || 400)}
                />
              </Field>
            </div>
          </div>

          {drafts.map((draft, index) => (
            <Card key={draft.id || index}>
              <CardHeader
                title={draft.name || t('ai.provider')}
                actions={
                  <div className="flex items-center gap-8">
                    {/* 平台共享项：普通人看得见在用哪个，但改不了也删不掉 */}
                    {draft.readonly ? (
                      <Badge variant="neutral" size="sm">
                        {t('ai.sharedModel')}
                      </Badge>
                    ) : null}
                    {/* 「当前使用」不再标在卡片上：排查时随时能在下拉里换模型，
                        默认模型这个概念已经弱化。这里更该回答的是「这条配好了没、
                        连不连得上」，而不是「谁是默认」。 */}
                    <Badge
                      variant={
                        testResults[draft.id] === false
                          ? 'danger'
                          : isConfigured(draft)
                            ? 'success'
                            : 'warning'
                      }
                      size="sm"
                      title={t('ai.badgeHint')}
                    >
                      {testResults[draft.id] === false
                        ? t('ai.connectFailed')
                        : isConfigured(draft)
                          ? t('ai.connected')
                          : t('ai.incomplete')}
                    </Badge>
                    {draft.readonly ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconTrash size={14} />}
                        onClick={() => removeProvider(index)}
                        title={t('ai.removeProvider')}
                      />
                    )}
                  </div>
                }
              />
              {/* 先选厂商：Base URL 与常用模型名自动就位，管理员不用去翻文档 */}
              <Field label={t('ai.preset')} hint={t('ai.presetHint')}>
                <Select
                  value={draft.presetName ?? ''}
                  onChange={(e) => applyPreset(index, e.target.value)}
                  options={[
                    { label: t('ai.presetManual'), value: '' },
                    ...presetOptions,
                  ]}
                  disabled={Boolean(draft.readonly)}
                />
              </Field>

              <div className="form-grid-2">
                <Field label={t('ai.providerName')} hint={t('ai.providerNameHint')}>
                  <Input
                    value={draft.name}
                    onChange={(e) => patch(index, { name: e.target.value })}
                    placeholder="DeepSeek"
                    disabled={Boolean(draft.readonly)}
                  />
                </Field>
                <Field label={t('ai.providerKind')}>
                  <Select
                    value={draft.kind}
                    onChange={(e) =>
                      patch(index, { kind: e.target.value as ProviderDraft['kind'] })
                    }
                    options={[
                      { label: t('ai.kindExternal'), value: 'external' },
                      { label: t('ai.kindInternal'), value: 'internal' },
                    ]}
                    disabled={Boolean(draft.readonly)}
                  />
                </Field>
              </div>
              <Field label={t('ai.baseUrl')} hint={t('ai.baseUrlHint')}>
                <Input
                  value={draft.base_url}
                  onChange={(e) => patch(index, { base_url: e.target.value })}
                  placeholder="https://api.deepseek.com"
                  disabled={Boolean(draft.readonly)}
                />
              </Field>
              <div className="form-grid-2">
                <Field label={t('ai.model')} hint={t('ai.modelHint')}>
                  <Input
                    value={draft.model}
                    onChange={(e) => patch(index, { model: e.target.value })}
                    placeholder="deepseek-chat"
                    disabled={Boolean(draft.readonly)}
                  />
                </Field>
                <Field
                  label={t('ai.apiKey')}
                  hint={draft.api_key_set ? t('ai.apiKeyKeep') : t('ai.apiKeyHint')}
                >
                  <Input
                    type="password"
                    value={draft.api_key}
                    onChange={(e) => patch(index, { api_key: e.target.value })}
                    placeholder={t('ai.apiKeyPlaceholder')}
                    disabled={Boolean(draft.readonly)}
                  />
                </Field>
              </div>

              {/* 授权：把这条模型开放给指定的某几个人。
                  给的是「用」的权限，不是「管」—— 对方能选它排查，但改不了、
                  删不掉，也看不到密钥。只有管理员能操作这一项。 */}
              {isAdmin ? (
                <Field label={t('ai.grantTo')} hint={t('ai.grantHint')}>
                  <div className="flex flex-col gap-8">
                    {userNames.length === 0 ? (
                      <span className="fs-xs text-muted">
                        {t('ai.noOtherUsers')}
                      </span>
                    ) : (
                      <UserPicker
                        users={userNames}
                        selected={draft.granted ?? []}
                        onToggle={(name) => toggleGrant(index, name)}
                        placeholder={t('ai.searchUser')}
                        emptyText={t('ai.noMatchUser')}
                      />
                    )}
                    {/* 已选的单独列出来：下拉收起后仍看得见授权给了谁，
                        也方便点一下就撤掉 —— 撤销路径必须比授权更顺手 */}
                    {(draft.granted ?? []).length > 0 ? (
                      <div className="flex items-center gap-6 flex-wrap">
                        <span className="fs-xs text-muted">
                          {t('ai.grantedCount', {
                            n: (draft.granted ?? []).length,
                          })}
                        </span>
                        {(draft.granted ?? []).map((name) => (
                          <Button
                            key={name}
                            size="sm"
                            variant="ghost"
                            icon={<IconClose size={13} />}
                            onClick={() => toggleGrant(index, name)}
                            title={t('ai.revokeGrant', { name })}
                          >
                            {name}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </Field>
              ) : null}

              {/* 候选模型一键填入：敲错模型名是最常见的「配好了却调不通」 */}
              {presetModelsOf(draft).length > 0 ? (
                <div className="flex items-center gap-6 flex-wrap">
                  <span className="fs-xs text-muted">{t('ai.modelSuggest')}</span>
                  {presetModelsOf(draft).map((name) => (
                    <Button
                      key={name}
                      variant="ghost"
                      size="sm"
                      onClick={() => patch(index, { model: name })}
                    >
                      {name}
                    </Button>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center gap-12 flex-wrap">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconRefresh size={14} />}
                  loading={testingId === (draft.id || `#${index}`)}
                  onClick={() => void test(index)}
                >
                  {t('ai.test')}
                </Button>
                <Switch
                  checked={draft.enabled}
                  onChange={(v) => patch(index, { enabled: v })}
                  label={t('ai.provider')}
                />
              </div>
            </Card>
          ))}

          <div className="flex items-center gap-12 flex-wrap mt-12">
            <Button
              variant="secondary"
              icon={<IconPlus size={15} />}
              onClick={addProvider}
            >
              {t('ai.addProvider')}
            </Button>
          </div>

          <div className="mt-16">
            <Notice tone="info">{t('ai.readonlyTip')}</Notice>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
