/* ==========================================================================
   产品官网 — 内容模型
   ==========================================================================

   这里是官网**唯一的文案来源**：改文案只动这一个文件，组件层不含任何硬编码
   条目。拆出来的原因是官网正文全部由「能力域 × 条目」构成，若与组件混在
   一起，任何一次文案微调都要在几百行 JSX 里找位置。

   口径约定（改动前请读一遍）：
     · 能力分组与 Sidebar.tsx 的 NAV_SECTIONS 逐项对齐 —— 官网说「有这个
       页面」，控制台里就必须真有，否则官网就成了谎话；
     · 每条能力的描述只写「用户能做成什么」，不写「用了什么技术」；
     · 条目数由代码自动汇总（见 CAPABILITY_TOTAL），页面上的数字不手写，
       避免加了条目忘了改数字。
   ========================================================================== */

import type { ReactNode } from 'react';
import type { Lang, MessageKey } from '../../i18n';
import {
  IconActivity,
  IconAlert,
  IconAudit,
  IconBackup,
  IconBell,
  IconBox,
  IconChat,
  IconCheck,
  IconClock,
  IconCloud,
  IconConsole,
  IconCpu,
  IconDashboard,
  IconDisk,
  IconDownload,
  IconGrip,
  IconInfo,
  IconKey,
  IconLayers,
  IconLayout,
  IconLock,
  IconNetwork,
  IconPlug,
  IconRestart,
  IconSearch,
  IconServer,
  IconSettings,
  IconShield,
  IconSnapshot,
  IconStorage,
  IconTasks,
  IconTemplate,
  IconTerminal,
  IconUsers,
  IconVm,
} from '../../components/Icons';

/* ---------------------------------------------------------------------------
   站点静态配置
   品牌名 / 副标题 / 版权来自服务端站点信息（useSiteInfo），这里只放路径。
   --------------------------------------------------------------------------- */

export const SITE = {
  /** 未登录时的控制台入口 */
  consolePath: '/login',
  /** 已登录时的控制台入口 */
  consolePathAuthed: '/dashboard',
  /** 后端自动生成的接口文档 */
  docsPath: '/api/docs',
};

/* ---------------------------------------------------------------------------
   能力域
   --------------------------------------------------------------------------- */

/**
 * 双语展示值：`[中文界面用的文案, 英文界面用的文案]`。
 *
 * 官网正文（能力域、条目、场景、步骤…）量大且成结构，不适合塞进 i18n 词条表
 * —— 词条表只放界面文案。这里就地写双语，由下面的 `localizeXxx(lang)` 按语言
 * 解引用成普通字符串，组件消费点因此不必到处写三元表达式。
 *
 * 特例：`Domain.en`（眉题）与 `Domain.name` 互为对方语言，所以它的元组是
 * `[英文, 中文]` —— 中文界面显示英文眉题，英文界面显示中文对照。
 */
export type Bi = readonly [zh: string, en: string];

/** 按语言取值：zh-CN 取第 0 项，其余取第 1 项 */
export function pick(bi: Bi, lang: Lang): string {
  return lang === 'zh-CN' ? bi[0] : bi[1];
}

export interface Capability {
  name: Bi;
  desc: Bi;
  icon: ReactNode;
}

export interface Domain {
  id: string;
  /** 中文名，与侧边栏分组标题一致 */
  name: Bi;
  /** 眉题：与 name 互为对方语言，只用于排版层次 */
  en: Bi;
  icon: ReactNode;
  /** 一句话说明这一域解决什么问题 */
  summary: Bi;
  items: Capability[];
}

export const DOMAINS: Domain[] = [
  {
    id: 'overview',
    name: ['总览', 'Overview'],
    en: ['Overview', '总览'],
    icon: <IconDashboard size={17} />,
    summary: [
      '打开第一眼要回答两个问题：集群现在什么状态、还有什么没处理。',
      'What the first screen has to answer: how the cluster is doing, and what is still unfinished.',
    ],
    items: [
      {
        name: ['集群仪表盘', 'Cluster dashboard'],
        desc: [
          'KPI、节点健康、资源分布、容量预测与占用排行一屏看完',
          'KPIs, node health, resource usage, capacity forecast and top consumers on one screen',
        ],
        icon: <IconDashboard size={15} />,
      },
      {
        name: ['工作台待办', 'Workbench to-dos'],
        desc: [
          '连接异常、待审批注册、配额告急、告警与基线未通过自动汇总',
          'Broken connections, registrations awaiting approval, quota warnings, alerts and failed baselines gathered in one place',
        ],
        icon: <IconLayout size={15} />,
      },
      {
        name: ['实时指标流', 'Live metric stream'],
        desc: [
          '节点 CPU / 内存经 WebSocket 每 5 秒推送，断线自动回落轮询',
          'Node CPU / memory pushed over WebSocket every 5 seconds, falling back to polling if the socket drops',
        ],
        icon: <IconActivity size={15} />,
      },
      {
        name: ['全局检索', 'Global search'],
        desc: [
          'Ctrl / ⌘ + K 跨资源检索虚拟机、节点、存储与用户',
          'Ctrl / ⌘ + K searches VMs, nodes, storage and users in one box',
        ],
        icon: <IconSearch size={15} />,
      },
      {
        name: ['多集群连接', 'Multi-cluster connections'],
        desc: [
          '同时接入多套 Proxmox，节点与存储按连接隔离不串味',
          'Attach several Proxmox clusters at once; nodes and storage stay isolated per connection',
        ],
        icon: <IconPlug size={15} />,
      },
      {
        name: ['卡片布局自定义', 'Custom card layout'],
        desc: [
          '仪表盘卡片可拖动排序、可隐藏，布局按账号存在服务端',
          'Drag, reorder and hide dashboard cards; the layout is stored per account on the server',
        ],
        icon: <IconGrip size={15} />,
      },
    ],
  },
  {
    id: 'compute',
    name: ['计算', 'Compute'],
    en: ['Compute', '计算'],
    icon: <IconCpu size={17} />,
    summary: [
      '从建机器到交出去的完整链路，虚拟机与容器两套端点各自成套。',
      'The whole path from creating a machine to handing it over — VMs and containers each with their own endpoints.',
    ],
    items: [
      {
        name: ['虚拟机', 'Virtual machines'],
        desc: [
          '开关机、重启、挂起、克隆、迁移、改配置与删除全生命周期',
          'Start, stop, restart, suspend, clone, migrate, reconfigure and delete — the full lifecycle',
        ],
        icon: <IconVm size={15} />,
      },
      {
        name: ['容器（LXC）', 'Containers (LXC)'],
        desc: [
          '与虚拟机同面板管理，网卡、挂载点与快照独立成套',
          'Managed in the same panel as VMs, with their own NICs, mount points and snapshots',
        ],
        icon: <IconBox size={15} />,
      },
      {
        name: ['模板流水线', 'Template pipeline'],
        desc: [
          'cloud 镜像一键建模板，克隆时注入主机名、IP 与 SSH 密钥',
          'Turn a cloud image into a template in one click; hostname, IP and SSH keys are injected on clone',
        ],
        icon: <IconTemplate size={15} />,
      },
      {
        name: ['批量操作', 'Bulk operations'],
        desc: [
          '多选后一次开机、关机、打标签、迁移或建快照，逐台回报成败',
          'Select many, then start, stop, tag, migrate or snapshot at once, with per-machine results',
        ],
        icon: <IconTasks size={15} />,
      },
      {
        name: ['节点', 'Nodes'],
        desc: [
          '在线状态、负载与 RRD 曲线，CPU / 内存 / 网络 / 磁盘逐项下钻',
          'Online state, load and RRD charts, drilling down into CPU / memory / network / disk',
        ],
        icon: <IconServer size={15} />,
      },
      {
        name: ['浏览器控制台', 'In-browser console'],
        desc: [
          'noVNC 图形控制台，PVE 无需暴露公网',
          'noVNC graphical console, without exposing Proxmox to the internet',
        ],
        icon: <IconConsole size={15} />,
      },
      {
        name: ['下发配额', 'Quotas'],
        desc: [
          '全局容量上限，到顶时创建按钮直接禁用，克隆入口同样拦截',
          'Global capacity caps: the create button disables at the limit and cloning is blocked too',
        ],
        icon: <IconLayers size={15} />,
      },
    ],
  },
  {
    id: 'storage',
    name: ['存储与网络', 'Storage & network'],
    en: ['Storage & network', '存储与网络'],
    icon: <IconStorage size={17} />,
    summary: [
      '存储池、集群网络与内网出口，全部在面板里在线配置。',
      'Storage pools, cluster networking and outbound tunnels, all configured online from the panel.',
    ],
    items: [
      {
        name: ['存储', 'Storage'],
        desc: [
          '容量与使用率、内容浏览、ISO 与镜像上传，上传即可用于装机',
          'Capacity and usage, content browsing, ISO and image upload ready for provisioning',
        ],
        icon: <IconStorage size={15} />,
      },
      {
        name: ['网络', 'Network'],
        desc: [
          '网桥、Bond 与 VLAN 在线配置，改动先进「待应用」再统一下发',
          'Bridges, bonds and VLANs configured online; changes stage as pending, then apply together',
        ],
        icon: <IconNetwork size={15} />,
      },
      {
        name: ['内网穿透', 'Tunnels (frp)'],
        desc: [
          '内置 frp 客户端与服务端，规则、启停与运行日志都在面板里',
          'Built-in frp client and server — rules, start/stop and logs all live in the panel',
        ],
        icon: <IconPlug size={15} />,
      },
      {
        name: ['IP 地址池', 'IP pools'],
        desc: [
          '维护可复用地址段，创建与克隆时直接挑选静态 IP',
          'Keep reusable address ranges and pick a static IP while creating or cloning',
        ],
        icon: <IconLayers size={15} />,
      },
    ],
  },
  {
    id: 'protection',
    name: ['数据保护', 'Data protection'],
    en: ['Data protection', '数据保护'],
    icon: <IconBackup size={17} />,
    summary: [
      '先把数据兜住：快照、定时备份，以及真出事之后怎么处置。',
      'Cover the data first: snapshots, scheduled backups, and what to do when something really goes wrong.',
    ],
    items: [
      {
        name: ['快照', 'Snapshots'],
        desc: [
          '全局视图集中查看，一键回滚与删除，回滚前二次确认',
          'One global view, one-click rollback and delete, with confirmation before rolling back',
        ],
        icon: <IconSnapshot size={15} />,
      },
      {
        name: ['备份与计划', 'Backups & schedules'],
        desc: [
          '三种备份模式与压缩策略，可视化配置 Proxmox 定时任务',
          'Three backup modes and compression choices, configuring Proxmox schedules visually',
        ],
        icon: <IconBackup size={15} />,
      },
      {
        name: ['备份防删', 'Backup guard'],
        desc: [
          '关键备份登记后拒绝删除，定期核对体积与时间戳变化并发告警',
          'Registered critical backups refuse deletion; size and timestamp changes are checked and alerted',
        ],
        icon: <IconLock size={15} />,
      },
      {
        name: ['应急响应', 'Incident response'],
        desc: [
          '可疑虚拟机一键隔离 —— 先取证快照、再断网、后关机',
          'Isolate a suspicious VM in one click — snapshot for evidence, cut the network, then power off',
        ],
        icon: <IconAlert size={15} />,
      },
    ],
  },
  {
    id: 'security',
    name: ['安全', 'Security'],
    en: ['Security', '安全'],
    icon: <IconShield size={17} />,
    summary: [
      '防、查、管、溯：从网络规则一直盖到主机加固与操作留痕。',
      'Prevent, detect, govern and trace: from network rules down to host hardening and audit trails.',
    ],
    items: [
      {
        name: ['防火墙', 'Firewall'],
        desc: [
          'PVE 原生防火墙图形化，集群 / 节点 / 虚拟机三级规则与安全组',
          'A UI over the native PVE firewall: cluster / node / VM level rules and security groups',
        ],
        icon: <IconLock size={15} />,
      },
      {
        name: ['SSH 安全', 'SSH security'],
        desc: [
          '本机与受管主机登录日志统一采集，命中爆破自动封禁',
          'Login logs from the panel host and managed hosts in one place; brute force triggers a ban',
        ],
        icon: <IconTerminal size={15} />,
      },
      {
        name: ['登录审计', 'Login audit'],
        desc: [
          'last / lastb 登录历史与 sudo 提权记录，增量汇入面板审计',
          'last / lastb history and sudo escalations, incrementally merged into the panel audit trail',
        ],
        icon: <IconClock size={15} />,
      },
      {
        name: ['端口与进程', 'Ports & processes'],
        desc: [
          '巡检监听端口与可疑进程，反弹 shell 启发式命中即告警',
          'Scans listening ports and suspicious processes, alerting on heuristic reverse-shell hits',
        ],
        icon: <IconActivity size={15} />,
      },
      {
        name: ['安全基线', 'Security baseline'],
        desc: [
          'SSH、口令策略、防火墙、时间同步一键体检，可修复的直接修',
          'One-click checks for SSH, password policy, firewall and time sync, with direct fixes',
        ],
        icon: <IconCheck size={15} />,
      },
    ],
  },
  {
    id: 'observe',
    name: ['观测与集成', 'Observability & integrations'],
    en: ['Observability', '观测与集成'],
    icon: <IconBell size={17} />,
    summary: [
      '让系统替你盯着外面的事：指标、证书、硬件与通知通道。',
      'Let the system watch what is outside: metrics, certificates, hardware and notification channels.',
    ],
    items: [
      {
        name: ['监控告警', 'Monitoring & alerts'],
        desc: [
          '宿主机与虚拟机阈值监控，飞书 / 邮件触达与恢复通知',
          'Threshold monitoring for hosts and VMs, with Feishu / email delivery and recovery notices',
        ],
        icon: <IconBell size={15} />,
      },
      {
        name: ['网站证书', 'Website certificates'],
        desc: [
          '腾讯云免费 DV 证书申请、签发、部署与到期自动续期一条龙',
          'Free Tencent Cloud DV certificates: request, issue, deploy and auto-renew before expiry',
        ],
        icon: <IconKey size={15} />,
      },
      {
        name: ['飞书机器人', 'Feishu bot'],
        desc: [
          '群里 @机器人 查状态、开关机、建快照，白名单 + 卡片二次确认',
          '@ the bot in a group to check status, power machines on or off or take snapshots, with an allow-list and card confirmation',
        ],
        icon: <IconChat size={15} />,
      },
      {
        name: ['硬件健康', 'Hardware health'],
        desc: [
          '磁盘 SMART、ZFS 池与 Ceph 状态，故障盘提前发现',
          'Disk SMART, ZFS pools and Ceph state — failing disks found before they fail',
        ],
        icon: <IconDisk size={15} />,
      },
      {
        name: ['数据导出', 'Data export'],
        desc: [
          '审计、任务、资产清单与告警历史一键导出 CSV',
          'Audit trail, tasks, asset inventory and alert history exported to CSV in one click',
        ],
        icon: <IconDownload size={15} />,
      },
      {
        name: ['站内通知', 'In-app notifications'],
        desc: [
          '铃铛里的未读提醒，任务完成与告警不必守着页面等',
          'Unread notices in the bell, so you need not sit on the page waiting for tasks or alerts',
        ],
        icon: <IconInfo size={15} />,
      },
    ],
  },
  {
    id: 'platform',
    name: ['系统管理', 'Platform'],
    en: ['Platform', '系统管理'],
    icon: <IconSettings size={17} />,
    summary: [
      '面板自身的管控：任务、账号、审计与后台作业。',
      'Running the panel itself: tasks, accounts, audit and background jobs.',
    ],
    items: [
      {
        name: ['任务队列', 'Task queue'],
        desc: [
          '集群全部任务的进度与输出日志实时推送，失败在哪一步一眼看到',
          'Progress and output logs for every cluster task streamed live, so the failing step is obvious',
        ],
        icon: <IconTasks size={15} />,
      },
      {
        name: ['后台任务', 'Background jobs'],
        desc: [
          '巡检与清理作业的运行状态、间隔调整与立即执行',
          'Status, interval changes and on-demand runs for inspection and cleanup jobs',
        ],
        icon: <IconRestart size={15} />,
      },
      {
        name: ['用户与角色', 'Users & roles'],
        desc: [
          '内置三级角色，权限点可逐条自定义，注册需管理员审批',
          'Three built-in roles, per-permission customisation, and registration approved by an admin',
        ],
        icon: <IconUsers size={15} />,
      },
      {
        name: ['审计日志', 'Audit log'],
        desc: [
          '写操作与敏感读取全部留痕，按用户、动作、结果筛选追溯',
          'Every write and sensitive read recorded, filterable by user, action and result',
        ],
        icon: <IconAudit size={15} />,
      },
      {
        name: ['系统设置', 'Settings'],
        desc: [
          '站点信息、常见问题、邮件通知与连接配置在线维护，改完即生效',
          'Site info, FAQs, email notifications and connection settings maintained online, effective immediately',
        ],
        icon: <IconSettings size={15} />,
      },
      {
        name: ['环境自检', 'Environment check'],
        desc: [
          '读取 PVE 上凭据的真实权限，缺什么权限直接给出修复命令',
          'Reads the real permissions of the PVE credentials and prints the commands to close any gap',
        ],
        icon: <IconCheck size={15} />,
      },
    ],
  },
];

/** 能力条目总数：页面上的「N 项能力」由它算出，不手写（与语言无关） */
export const CAPABILITY_TOTAL = DOMAINS.reduce((n, d) => n + d.items.length, 0);

/* ---------------------------------------------------------------------------
   按语言解引用：Bi → string
   ---------------------------------------------------------------------------

   组件只消费解引用后的结构，因此不必到处写 pick(...)。语言切换时整棵内容树
   重算一次（数据是常量，开销可忽略），而不是让每个字符串都挂一次判断。
   --------------------------------------------------------------------------- */

export interface ResolvedCapability {
  name: string;
  desc: string;
  icon: ReactNode;
}

export interface ResolvedDomain {
  id: string;
  name: string;
  /** 眉题：与 name 互为对方语言 */
  en: string;
  icon: ReactNode;
  summary: string;
  items: ResolvedCapability[];
}

export function localizeDomains(lang: Lang): ResolvedDomain[] {
  return DOMAINS.map((domain) => ({
    id: domain.id,
    name: pick(domain.name, lang),
    en: pick(domain.en, lang),
    icon: domain.icon,
    summary: pick(domain.summary, lang),
    items: domain.items.map((item) => ({
      name: pick(item.name, lang),
      desc: pick(item.desc, lang),
      icon: item.icon,
    })),
  }));
}

/** 拍平索引：能力矩阵的关键词检索在它上面跑（已解引用） */
export interface FlatCapability extends ResolvedCapability {
  domainId: string;
  domainName: string;
}

export function localizeCapabilities(lang: Lang): FlatCapability[] {
  return localizeDomains(lang).flatMap((domain) =>
    domain.items.map((item) => ({
      ...item,
      domainId: domain.id,
      domainName: domain.name,
    })),
  );
}

/* ---------------------------------------------------------------------------
   其余内容常量的解引用
   ---------------------------------------------------------------------------

   逐个显式映射，不做「深度递归解引用」那种通用实现：内容里混着 ReactNode
   （icon）与字符串数组，靠结构猜哪一个是 Bi 迟早会猜错 —— 比如长度恰好为 2
   的字符串数组会被误判成双语元组，而 React 元素被当作普通对象递归更会直接
   把图标拆坏。多写几行 map，换的是改版时不会莫名其妙掉图标。
   --------------------------------------------------------------------------- */

export type ResolvedHighlight = Omit<Highlight, 'kicker' | 'title' | 'desc' | 'points' | 'tags'> & {
  kicker: string;
  title: string;
  desc: string;
  points: string[];
  tags: string[];
};

export function localizeHighlights(lang: Lang): ResolvedHighlight[] {
  return HIGHLIGHTS.map((item) => ({
    id: item.id,
    kicker: pick(item.kicker, lang),
    title: pick(item.title, lang),
    desc: pick(item.desc, lang),
    points: item.points.map((point) => pick(point, lang)),
    tags: item.tags.map((tag) => pick(tag, lang)),
    visual: item.visual,
  }));
}

export type ResolvedPillar = Omit<Pillar, 'title' | 'desc'> & { title: string; desc: string };

export function localizePillars(lang: Lang): ResolvedPillar[] {
  return PILLARS.map((item) => ({
    icon: item.icon,
    title: pick(item.title, lang),
    desc: pick(item.desc, lang),
  }));
}

export type ResolvedAuditRow = Omit<AuditRow, 'target'> & { target: string };

export function localizeAuditSample(lang: Lang): ResolvedAuditRow[] {
  return AUDIT_SAMPLE.map((row) => ({ ...row, target: pick(row.target, lang) }));
}

export type ResolvedTopoNode = { name: string; desc: string };

function localizeTopoNodes(nodes: TopoNode[], lang: Lang): ResolvedTopoNode[] {
  return nodes.map((node) => ({
    name: pick(node.name, lang),
    desc: pick(node.desc, lang),
  }));
}

export type ResolvedTopoCluster = {
  name: string;
  nodes: string;
  meta: string;
  online: boolean;
};

export function localizeTopoCore(lang: Lang): ResolvedTopoNode[] {
  return localizeTopoNodes(TOPO_CORE, lang);
}

export function localizeTopoEntries(lang: Lang): ResolvedTopoNode[] {
  return localizeTopoNodes(TOPO_ENTRIES, lang);
}

export function localizeTopoClusters(lang: Lang): ResolvedTopoCluster[] {
  return TOPO_CLUSTERS.map((cluster) => ({
    name: cluster.name,
    nodes: pick(cluster.nodes, lang),
    meta: pick(cluster.meta, lang),
    online: cluster.online,
  }));
}

export type ResolvedScenario = Omit<Scenario, 'title' | 'desc' | 'points' | 'tags'> & {
  title: string;
  desc: string;
  points: string[];
  tags: string[];
};

export function localizeScenarios(lang: Lang): ResolvedScenario[] {
  return SCENARIOS.map((item) => ({
    id: item.id,
    icon: item.icon,
    title: pick(item.title, lang),
    desc: pick(item.desc, lang),
    points: item.points.map((point) => pick(point, lang)),
    tags: item.tags.map((tag) => pick(tag, lang)),
  }));
}

export type ResolvedStep = { title: string; desc: string };

export function localizeSteps(lang: Lang): ResolvedStep[] {
  return STEPS.map((step) => ({
    title: pick(step.title, lang),
    desc: pick(step.desc, lang),
  }));
}

export function localizeDeployLines(lang: Lang): string[] {
  return DEPLOY_LINES.map((line) => pick(line, lang));
}

export type ResolvedStackGroup = { icon: ReactNode; title: string; items: string[] };

export function localizeStack(lang: Lang): ResolvedStackGroup[] {
  return STACK.map((group) => ({
    icon: group.icon,
    title: pick(group.title, lang),
    items: group.items.map((item) => pick(item, lang)),
  }));
}

/* ---------------------------------------------------------------------------
   顶栏导航锚点（FAQ 是否出现由服务端内容决定，见 Landing.tsx）
   --------------------------------------------------------------------------- */

/**
 * 锚点导航。存**词条键**而不是文案：官网要跟随界面语言，而这里是全站唯一
 * 的文案来源，渲染处用 t(labelKey) 取（见 Landing.tsx）。
 */
export const NAV_LINKS: { id: string; labelKey: MessageKey }[] = [
  { id: 'matrix', labelKey: 'landing.nav.matrix' },
  { id: 'console', labelKey: 'landing.nav.console' },
  { id: 'architecture', labelKey: 'landing.nav.architecture' },
  { id: 'highlights', labelKey: 'landing.nav.highlights' },
  { id: 'security', labelKey: 'landing.nav.security' },
  { id: 'start', labelKey: 'landing.nav.start' },
];

/* ---------------------------------------------------------------------------
   重点能力：四件真正会左右选型的事
   每块配一张示意图，visual 决定渲染哪一种（见 Highlights.tsx）
   --------------------------------------------------------------------------- */

export type VisualKind = 'pipeline' | 'contain' | 'baseline' | 'auto';

/** 双语相同：标识符、时间戳与英文专名不必把同一串写两遍 */
export function same(text: string): Bi {
  return [text, text];
}

export interface Highlight {
  id: string;
  /** 小标签，说明这块讲的是哪一段 */
  kicker: Bi;
  title: Bi;
  desc: Bi;
  points: Bi[];
  tags: Bi[];
  visual: VisualKind;
}

export const HIGHLIGHTS: Highlight[] = [
  {
    id: 'pipeline',
    kicker: ['交付', 'Delivery'],
    title: ['模板 + Cloud-init 交付流水线', 'Template + Cloud-init delivery pipeline'],
    desc: [
      '把「开一台机器」变成一条可重复执行的流水线。后端按固定顺序推进，每步之间等待 PVE 任务真正完成，任一步失败都会自动删掉临时虚拟机，不留半成品。',
      'Turns “spin up a machine” into a repeatable pipeline. The backend advances in a fixed order, waiting for each PVE task to actually finish; if any step fails the temporary VM is deleted instead of being left half-built.',
    ],
    points: [
      ['从 cloud 镜像一键构建模板，无需手工敲 qm 命令', 'Build a template from a cloud image in one click — no hand-typed qm commands'],
      ['克隆时注入主机名、静态 IP、SSH 公钥，开完即用', 'Hostname, static IP and SSH key injected on clone, usable the moment it boots'],
      ['构建过程中的临时虚拟机在失败时自动回收', 'Temporary VMs created during the build are reclaimed automatically if it fails'],
    ],
    tags: [
      ['一键建模板', 'One-click template'],
      ['注入主机名与 IP', 'Hostname and IP injection'],
      ['失败自动清理', 'Cleanup on failure'],
    ],
    visual: 'pipeline',
  },
  {
    id: 'contain',
    kicker: ['应急', 'Incident'],
    title: ['出事时的处置顺序是刻意的', 'The response order is deliberate'],
    desc: [
      '可疑虚拟机一键隔离，顺序固定为「先取证快照 → 再断网 → 后关机」。反过来的话机器一关现场就没了。每一步独立执行、单独回报，取证失败不会阻止断网，但会明确标红。',
      'A suspicious VM is isolated in one click, in a fixed order: snapshot for evidence → cut the network → power off. Do it the other way round and the evidence dies with the machine. Each step runs and reports independently — a failed snapshot does not block the network cut, but it is flagged in red.',
    ],
    points: [
      ['断网只改 netX 的 link_down，网桥 / VLAN / MAC 原样保留', 'Cutting the network only flips netX link_down; bridge, VLAN and MAC are left untouched'],
      ['关键备份登记后面板直接拒绝删除，勒索软件删不掉备份', 'Registered critical backups are refused for deletion, so ransomware cannot remove them'],
      ['定期核对备份体积与时间戳，对不上就发告警', 'Backup sizes and timestamps are verified on a schedule, alerting on any mismatch'],
    ],
    tags: [
      ['一键隔离', 'One-click isolation'],
      ['取证快照', 'Evidence snapshot'],
      ['备份防删', 'Backup guard'],
    ],
    visual: 'contain',
  },
  {
    id: 'baseline',
    kicker: ['合规', 'Compliance'],
    title: ['安全基线一键体检与加固', 'One-click baseline audit and hardening'],
    desc: [
      '对平台上的所有服务器并发体检 SSH、口令策略、防火墙、时间同步与内核参数。本机与受管主机共用同一套判定逻辑，结论口径完全一致。',
      'Audits SSH, password policy, firewall, time sync and kernel parameters across every server concurrently. The panel host and managed hosts share the same rules, so a verdict means the same thing everywhere.',
    ],
    points: [
      ['按严重级别加权评分，缺权限的项不计入分母，不冤枉扣分', 'Weighted scoring by severity; checks you lack permission for are left out of the denominator rather than counted against you'],
      ['可自动修复的项直接点修复，改完立即校验', 'Items with an automatic fix are one click away, and verified immediately afterwards'],
      ['校验不过自动回滚，绝不把机器改到登录不上去', 'Failed verification rolls back automatically, never leaving a machine you cannot log into'],
    ],
    tags: [
      ['批量体检', 'Batch audit'],
      ['自动修复', 'Automatic fixes'],
      ['校验不过自动回滚', 'Rollback on failed check'],
    ],
    visual: 'baseline',
  },
  {
    id: 'auto',
    kicker: ['自动化', 'Automation'],
    title: ['证书续期与机器人指令双自动', 'Certificate renewal and bot commands, both automated'],
    desc: [
      '免费 DV 证书从申请、验证、签发到部署全自动，到期前自动续期并执行你配置的重载命令；飞书里 @机器人 就能查状态、开关机、建快照，白名单之外一律不执行。',
      'Free DV certificates go from request through validation, issuance and deployment fully automatically, renewing before expiry and running the reload command you configured. In Feishu, @ the bot to check status, power machines on or off or take snapshots — anything outside the allow-list is refused.',
    ],
    points: [
      ['证书支持部署到本机与受管主机，续期后可自动重载服务', 'Certificates deploy to the panel host and managed hosts, with an automatic service reload after renewal'],
      ['危险指令先弹确认卡片，点确认才执行', 'Dangerous commands raise a confirmation card and only run once confirmed'],
      ['机器人消息与面板操作进同一张审计表，追溯不分叉', 'Bot messages and panel actions land in the same audit table, so there is a single trail to follow'],
    ],
    tags: [
      ['自动续期', 'Automatic renewal'],
      ['三类部署', 'Three deploy targets'],
      ['指令控制', 'Command gating'],
    ],
    visual: 'auto',
  },
];

/* ---------------------------------------------------------------------------
   架构拓扑：浏览器 → 面板 → 多套 Proxmox 连接
   --------------------------------------------------------------------------- */

export interface TopoNode {
  name: Bi;
  desc: Bi;
}

/** 面板内部的三块能力，画在中间的方框里 */
export const TOPO_CORE: TopoNode[] = [
  {
    name: ['API 与权限', 'API & permissions'],
    desc: ['RBAC 校验 · 审计落库', 'RBAC checks · audit writes'],
  },
  {
    name: ['实时通道', 'Realtime channel'],
    desc: ['指标推送 · 控制台透传', 'Metric push · console passthrough'],
  },
  {
    name: ['后台作业', 'Background jobs'],
    desc: ['巡检 · 告警 · 状态核对', 'Inspection · alerts · state checks'],
  },
];

/**
 * 右侧多集群：强调「一套面板管多套 PVE」。
 *
 * `online` 是**数据**、`meta` 是**文案**，两者必须分开：英文界面下 meta 是
 * "online"，若沿用 `meta === '在线'` 判在线，所有连接都会被画成故障态。
 */
export const TOPO_CLUSTERS: { name: string; nodes: Bi; meta: Bi; online: boolean }[] = [
  { name: 'proxmox-a', nodes: ['3 节点', '3 nodes'], meta: ['在线', 'online'], online: true },
  { name: 'proxmox-b', nodes: ['1 节点', '1 node'], meta: ['在线', 'online'], online: true },
  {
    name: 'proxmox-c',
    nodes: ['2 节点', '2 nodes'],
    meta: ['连接异常', 'connection error'],
    online: false,
  },
];

/** 左侧入口 */
export const TOPO_ENTRIES: TopoNode[] = [
  {
    name: ['浏览器控制台', 'Web console'],
    desc: ['虚拟机 / 容器 / 存储 / 安全', 'VMs / containers / storage / security'],
  },
  {
    name: ['noVNC 控制台', 'noVNC console'],
    desc: ['WebSocket 双向透传', 'WebSocket passthrough'],
  },
  {
    name: ['飞书机器人', 'Feishu bot'],
    desc: ['群内指令与确认卡片', 'In-chat commands and confirmation cards'],
  },
];

/* ---------------------------------------------------------------------------
   安全与合规（深色重音区）
   --------------------------------------------------------------------------- */

export interface Pillar {
  icon: ReactNode;
  title: Bi;
  desc: Bi;
}

export const PILLARS: Pillar[] = [
  {
    icon: <IconUsers size={17} />,
    title: ['三级角色 + 自定义权限点', 'Three roles plus custom permissions'],
    desc: [
      'admin / operator / viewer 内置，权限点由后端在 JWT 中下发，可逐条勾选覆盖',
      'admin / operator / viewer built in; permissions arrive in the JWT and can be overridden item by item',
    ],
  },
  {
    icon: <IconLock size={17} />,
    title: ['凭据只放 HttpOnly Cookie', 'Credentials only in HttpOnly cookies'],
    desc: [
      'JavaScript 读不到令牌，XSS 也偷不走；写操作还要过一次 CSRF 双提交校验',
      'JavaScript cannot read the token, so XSS cannot steal it; writes also pass a CSRF double-submit check',
    ],
  },
  {
    icon: <IconShield size={17} />,
    title: ['危险操作二次确认', 'Confirmation for dangerous operations'],
    desc: [
      '删除虚机、改连接、下发防火墙等操作即使 token 有效也要重输密码（开了 2FA 再加动态码）',
      'Deleting a VM, changing a connection or pushing firewall rules asks for the password again even with a valid token (plus a TOTP code when 2FA is on)',
    ],
  },
  {
    icon: <IconKey size={17} />,
    title: ['两步验证 TOTP', 'Two-factor authentication (TOTP)'],
    desc: [
      '人人可开、角色可强制；绑定一次性给出 8 张恢复码，密钥加密落库',
      'Optional for everyone and enforceable per role; binding issues 8 recovery codes and the secret is stored encrypted',
    ],
  },
  {
    icon: <IconActivity size={17} />,
    title: ['防爆破与全局限流', 'Brute-force defence and global rate limits'],
    desc: [
      '账号 + 来源 IP 双维度计数落库，重启不清零；接口按 IP 限流并返回 429',
      'Counters persist for both account and source IP and survive restarts; the API rate-limits per IP and answers 429',
    ],
  },
  {
    icon: <IconAudit size={17} />,
    title: ['写操作与敏感读取都留痕', 'Writes and sensitive reads are both recorded'],
    desc: [
      '记录用户、动作、对象、结果与来源 IP；看连接配置、翻审计日志本身也记一条',
      'Records user, action, target, result and source IP; reading connection settings or the audit log itself leaves a trace too',
    ],
  },
];

/** 审计流水示例（示意数据，页面会标注「示意」） */
export interface AuditRow {
  time: string;
  user: string;
  action: string;
  target: Bi;
  result: 'ok' | 'denied' | 'failed';
}

export const AUDIT_SAMPLE: AuditRow[] = [
  { time: '14:02:11', user: 'admin', action: 'vm.start', target: same('web-01'), result: 'ok' },
  {
    time: '14:02:36',
    user: 'admin',
    action: 'firewall.group.apply',
    target: ['集群默认策略', 'cluster default policy'],
    result: 'ok',
  },
  {
    time: '14:03:02',
    user: 'ops',
    action: 'vm.delete',
    target: same('db-02'),
    result: 'denied',
  },
  {
    time: '14:03:18',
    user: 'admin',
    action: 'config.connection.read',
    target: same('proxmox-a'),
    result: 'ok',
  },
  {
    time: '14:04:05',
    user: 'ops',
    action: 'baseline.fix_all',
    target: same('host-03'),
    result: 'failed',
  },
];

/* ---------------------------------------------------------------------------
   适用场景
   --------------------------------------------------------------------------- */

export interface Scenario {
  id: string;
  icon: ReactNode;
  title: Bi;
  desc: Bi;
  points: Bi[];
  tags: Bi[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'solo',
    icon: <IconServer size={17} />,
    title: ['单机自建', 'Single host'],
    desc: [
      '一台 PVE 主机加上这个面板，就是把整套虚拟化平台管起来的最小组合。',
      'One PVE host plus this panel is the smallest complete way to run a virtualisation platform.',
    ],
    points: [
      ['虚拟机与容器同面板，创建、开关机、控制台一步到位', 'VMs and containers in one panel: create, power on or off and open the console without switching tools'],
      ['模板 + Cloud-init 克隆即交付，不用每次从头装系统', 'Template + Cloud-init means clone and deliver, with no reinstall from scratch each time'],
      ['存储容量、ISO 上传与挂载都留在面板内完成', 'Storage capacity, ISO uploads and mounting all happen inside the panel'],
      ['快照与定时备份先把「能回滚」这条路留好', 'Snapshots and scheduled backups keep a rollback path open from the start'],
    ],
    tags: [['计算', 'Compute'], ['存储', 'Storage'], ['数据保护', 'Data protection']],
  },
  {
    id: 'cluster',
    icon: <IconLayers size={17} />,
    title: ['多节点集群运维', 'Multi-node cluster operations'],
    desc: [
      '节点一多，靠肉眼盯 PVE 网页版就不够了 —— 先把「谁在冒烟」摆到首屏。',
      'Once there are several nodes, watching the PVE web UI by eye stops working — put “who is on fire” on the first screen instead.',
    ],
    points: [
      ['节点在线状态、负载与 RRD 趋势曲线逐项下钻', 'Online state, load and RRD trends for every node, with drill-down per metric'],
      ['集群仲裁与 HA 态势直接进仪表盘关键指标', 'Quorum and HA status sit among the dashboard KPIs'],
      ['存储按连接 / 共享 / 本地正确去重，容量不被重复累加', 'Storage is de-duplicated across connections, shared and local, so capacity is never double-counted'],
      ['资源占用排行支持内存与 CPU 双口径排序', 'Top consumers can be ranked by memory or by CPU'],
    ],
    tags: [['节点', 'Nodes'], ['仪表盘', 'Dashboard'], ['监控告警', 'Monitoring']],
  },
  {
    id: 'delivery',
    icon: <IconTemplate size={17} />,
    title: ['对外交付与自动化', 'Delivery and automation'],
    desc: [
      '把「开一台机器」变成一条可重复的流水线：模板、注入、配额、通知各管一段。',
      'Turns “spin up a machine” into a repeatable pipeline: templates, injection, quotas and notifications each own a stage.',
    ],
    points: [
      ['Cloud-init 注入主机名、IP 与登录密钥，克隆完直接可用', 'Cloud-init injects hostname, IP and login keys, so a clone is usable straight away'],
      ['下发配额控制还能开多少台，到上限时按钮直接禁用', 'Quotas control how many more machines you can create, disabling the button at the limit'],
      ['IP 地址池维护可复用地址段，创建时挑一个即可', 'The IP pool keeps reusable ranges, so you just pick one when creating'],
      ['证书申请、签发、部署与到期续期全流程自动完成', 'Certificate request, issuance, deployment and renewal run end to end automatically'],
    ],
    tags: [['模板', 'Templates'], ['IP 池', 'IP pools'], ['网站证书', 'Certificates']],
  },
  {
    id: 'security',
    icon: <IconShield size={17} />,
    title: ['安全与合规追溯', 'Security and compliance tracing'],
    desc: [
      '从网络策略到主机加固，再到每一步操作留痕，出事时能说清发生了什么。',
      'From network policy to host hardening to a record of every action, so you can explain what happened when it matters.',
    ],
    points: [
      ['防火墙集群 / 节点 / 虚拟机三级规则与安全组', 'Firewall rules and security groups at cluster / node / VM level'],
      ['SSH 登录日志统一采集，爆破命中即告警并联动 fail2ban', 'SSH login logs collected in one place, alerting and triggering fail2ban on brute force'],
      ['端口与可疑进程巡检，反弹 shell 特征命中进告警', 'Ports and suspicious processes inspected, raising alerts on reverse-shell signatures'],
      ['登录历史与 sudo 提权记录可追溯，敏感操作全部入审计', 'Login history and sudo escalations stay traceable, and every sensitive action reaches the audit log'],
    ],
    tags: [
      ['防火墙', 'Firewall'],
      ['SSH 安全', 'SSH security'],
      ['安全基线', 'Baseline'],
      ['审计日志', 'Audit log'],
    ],
  },
];

/* ---------------------------------------------------------------------------
   上手流程 / 技术栈
   --------------------------------------------------------------------------- */

export const STEPS: { title: Bi; desc: Bi }[] = [
  {
    title: ['部署面板', 'Deploy the panel'],
    desc: [
      '后端拉起来即可，前端由后端同源托管，一个端口对外。',
      'Just start the backend — it serves the frontend from the same origin, one port to the outside.',
    ],
  },
  {
    title: ['接入集群', 'Connect a cluster'],
    desc: [
      '填 Proxmox 地址与 API Token，保存后立即生效，凭据只留在后端。',
      'Enter the Proxmox address and API token; it takes effect on save and the credentials stay on the backend.',
    ],
  },
  {
    title: ['建模板、交付机器', 'Build a template, deliver machines'],
    desc: [
      '用模板 + Cloud-init 一键克隆，IP、主机名、规格一次配好。',
      'Clone from a template with Cloud-init, setting IP, hostname and specs in one go.',
    ],
  },
  {
    title: ['打开值守能力', 'Turn on the watchkeepers'],
    desc: [
      '配置告警规则、基线巡检、证书续期与飞书机器人，之后交给面板盯着。',
      'Configure alert rules, baseline inspection, certificate renewal and the Feishu bot, then let the panel keep watch.',
    ],
  },
];

/**
 * 部署命令示例。注释行随语言变，命令本身不变 —— 用 same() 标出来，
 * 免得读代码的人以为漏翻了。
 */
export const DEPLOY_LINES: Bi[] = [
  [
    '# 构建前端产物，后端会同源托管 dist/ 与 /api',
    '# Build the frontend; the backend serves dist/ and /api from the same origin',
  ],
  same('npm run build'),
  [
    './start-prod.sh          # 监听 0.0.0.0:8080',
    './start-prod.sh          # listens on 0.0.0.0:8080',
  ],
];

export const STACK: { icon: ReactNode; title: Bi; items: Bi[] }[] = [
  {
    icon: <IconCpu size={16} />,
    title: ['前端', 'Frontend'],
    items: [
      same('React 18 + TypeScript'),
      same('Vite'),
      same('TanStack Query'),
      same('Recharts'),
      same('noVNC'),
    ],
  },
  {
    icon: <IconServer size={16} />,
    title: ['后端', 'Backend'],
    items: [
      same('Python 3.13 + FastAPI'),
      ['httpx（异步）', 'httpx (async)'],
      ['WebSocket 双向透传', 'WebSocket passthrough'],
      ['后台作业调度', 'Background job scheduling'],
    ],
  },
  {
    icon: <IconCloud size={16} />,
    title: ['数据与集成', 'Data & integrations'],
    items: [
      same('MySQL 8'),
      same('Proxmox VE API'),
      ['飞书开放平台', 'Feishu Open Platform'],
      ['腾讯云 SSL', 'Tencent Cloud SSL'],
    ],
  },
];
