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

export interface Capability {
  name: string;
  desc: string;
  icon: ReactNode;
}

export interface Domain {
  id: string;
  /** 中文名，与侧边栏分组标题一致 */
  name: string;
  /** 英文眉题，只用于排版层次 */
  en: string;
  icon: ReactNode;
  /** 一句话说明这一域解决什么问题 */
  summary: string;
  items: Capability[];
}

export const DOMAINS: Domain[] = [
  {
    id: 'overview',
    name: '总览',
    en: 'Overview',
    icon: <IconDashboard size={17} />,
    summary: '打开第一眼要回答两个问题：集群现在什么状态、还有什么没处理。',
    items: [
      {
        name: '集群仪表盘',
        desc: 'KPI、节点健康、资源分布、容量预测与占用排行一屏看完',
        icon: <IconDashboard size={15} />,
      },
      {
        name: '工作台待办',
        desc: '连接异常、待审批注册、配额告急、告警与基线未通过自动汇总',
        icon: <IconLayout size={15} />,
      },
      {
        name: '实时指标流',
        desc: '节点 CPU / 内存经 WebSocket 每 5 秒推送，断线自动回落轮询',
        icon: <IconActivity size={15} />,
      },
      {
        name: '全局检索',
        desc: 'Ctrl / ⌘ + K 跨资源检索虚拟机、节点、存储与用户',
        icon: <IconSearch size={15} />,
      },
      {
        name: '多集群连接',
        desc: '同时接入多套 Proxmox，节点与存储按连接隔离不串味',
        icon: <IconPlug size={15} />,
      },
      {
        name: '卡片布局自定义',
        desc: '仪表盘卡片可拖动排序、可隐藏，布局按账号存在服务端',
        icon: <IconGrip size={15} />,
      },
    ],
  },
  {
    id: 'compute',
    name: '计算',
    en: 'Compute',
    icon: <IconCpu size={17} />,
    summary: '从建机器到交出去的完整链路，虚拟机与容器两套端点各自成套。',
    items: [
      {
        name: '虚拟机',
        desc: '开关机、重启、挂起、克隆、迁移、改配置与删除全生命周期',
        icon: <IconVm size={15} />,
      },
      {
        name: '容器（LXC）',
        desc: '与虚拟机同面板管理，网卡、挂载点、快照与串口终端独立成套',
        icon: <IconBox size={15} />,
      },
      {
        name: '模板流水线',
        desc: 'cloud 镜像一键建模板，克隆时注入主机名、IP 与 SSH 密钥',
        icon: <IconTemplate size={15} />,
      },
      {
        name: '批量操作',
        desc: '多选后一次开机、关机、打标签、迁移或建快照，逐台回报成败',
        icon: <IconTasks size={15} />,
      },
      {
        name: '节点',
        desc: '在线状态、负载与 RRD 曲线，CPU / 内存 / 网络 / 磁盘逐项下钻',
        icon: <IconServer size={15} />,
      },
      {
        name: '浏览器控制台',
        desc: 'noVNC 图形控制台与 xterm 串口终端，PVE 无需暴露公网',
        icon: <IconConsole size={15} />,
      },
      {
        name: '下发配额',
        desc: '全局容量上限，到顶时创建按钮直接禁用，克隆入口同样拦截',
        icon: <IconLayers size={15} />,
      },
    ],
  },
  {
    id: 'storage',
    name: '存储与网络',
    en: 'Storage & Network',
    icon: <IconStorage size={17} />,
    summary: '存储池、集群网络与内网出口，全部在面板里在线配置。',
    items: [
      {
        name: '存储',
        desc: '容量与使用率、内容浏览、ISO 与镜像上传，上传即可用于装机',
        icon: <IconStorage size={15} />,
      },
      {
        name: '网络',
        desc: '网桥、Bond 与 VLAN 在线配置，改动先进「待应用」再统一下发',
        icon: <IconNetwork size={15} />,
      },
      {
        name: '内网穿透',
        desc: '内置 frp 客户端与服务端，规则、启停与运行日志都在面板里',
        icon: <IconPlug size={15} />,
      },
      {
        name: 'IP 地址池',
        desc: '维护可复用地址段，创建与克隆时直接挑选静态 IP',
        icon: <IconLayers size={15} />,
      },
    ],
  },
  {
    id: 'protection',
    name: '数据保护',
    en: 'Data Protection',
    icon: <IconBackup size={17} />,
    summary: '先把数据兜住：快照、定时备份，以及真出事之后怎么处置。',
    items: [
      {
        name: '快照',
        desc: '全局视图集中查看，一键回滚与删除，回滚前二次确认',
        icon: <IconSnapshot size={15} />,
      },
      {
        name: '备份与计划',
        desc: '三种备份模式与压缩策略，可视化配置 Proxmox 定时任务',
        icon: <IconBackup size={15} />,
      },
      {
        name: '备份防删',
        desc: '关键备份登记后拒绝删除，定期核对体积与时间戳变化并发告警',
        icon: <IconLock size={15} />,
      },
      {
        name: '应急响应',
        desc: '可疑虚拟机一键隔离 —— 先取证快照、再断网、后关机',
        icon: <IconAlert size={15} />,
      },
    ],
  },
  {
    id: 'security',
    name: '安全',
    en: 'Security',
    icon: <IconShield size={17} />,
    summary: '防、查、管、溯：从网络规则一直盖到主机加固与操作留痕。',
    items: [
      {
        name: '防火墙',
        desc: 'PVE 原生防火墙图形化，集群 / 节点 / 虚拟机三级规则与安全组',
        icon: <IconLock size={15} />,
      },
      {
        name: 'SSH 安全',
        desc: '本机与受管主机登录日志统一采集，命中爆破自动封禁',
        icon: <IconTerminal size={15} />,
      },
      {
        name: '登录审计',
        desc: 'last / lastb 登录历史与 sudo 提权记录，增量汇入面板审计',
        icon: <IconClock size={15} />,
      },
      {
        name: '端口与进程',
        desc: '巡检监听端口与可疑进程，反弹 shell 启发式命中即告警',
        icon: <IconActivity size={15} />,
      },
      {
        name: '安全基线',
        desc: 'SSH、口令策略、防火墙、时间同步一键体检，可修复的直接修',
        icon: <IconCheck size={15} />,
      },
    ],
  },
  {
    id: 'observe',
    name: '观测与集成',
    en: 'Observability',
    icon: <IconBell size={17} />,
    summary: '让系统替你盯着外面的事：指标、证书、硬件与通知通道。',
    items: [
      {
        name: '监控告警',
        desc: '宿主机与虚拟机阈值监控，飞书 / 邮件触达与恢复通知',
        icon: <IconBell size={15} />,
      },
      {
        name: '网站证书',
        desc: '腾讯云免费 DV 证书申请、签发、部署与到期自动续期一条龙',
        icon: <IconKey size={15} />,
      },
      {
        name: '飞书机器人',
        desc: '群里 @机器人 查状态、开关机、建快照，白名单 + 卡片二次确认',
        icon: <IconChat size={15} />,
      },
      {
        name: '硬件健康',
        desc: '磁盘 SMART、ZFS 池与 Ceph 状态，故障盘提前发现',
        icon: <IconDisk size={15} />,
      },
      {
        name: '数据导出',
        desc: '审计、任务、资产清单与告警历史一键导出 CSV',
        icon: <IconDownload size={15} />,
      },
      {
        name: '站内通知',
        desc: '铃铛里的未读提醒，任务完成与告警不必守着页面等',
        icon: <IconInfo size={15} />,
      },
    ],
  },
  {
    id: 'platform',
    name: '系统管理',
    en: 'Platform',
    icon: <IconSettings size={17} />,
    summary: '面板自身的管控：任务、账号、审计与后台作业。',
    items: [
      {
        name: '任务队列',
        desc: '集群全部任务的进度与输出日志实时推送，失败在哪一步一眼看到',
        icon: <IconTasks size={15} />,
      },
      {
        name: '后台任务',
        desc: '巡检与清理作业的运行状态、间隔调整与立即执行',
        icon: <IconRestart size={15} />,
      },
      {
        name: '用户与角色',
        desc: '内置三级角色，权限点可逐条自定义，注册需管理员审批',
        icon: <IconUsers size={15} />,
      },
      {
        name: '审计日志',
        desc: '写操作与敏感读取全部留痕，按用户、动作、结果筛选追溯',
        icon: <IconAudit size={15} />,
      },
      {
        name: '系统设置',
        desc: '站点信息、常见问题、邮件通知与连接配置在线维护，改完即生效',
        icon: <IconSettings size={15} />,
      },
      {
        name: '环境自检',
        desc: '读取 PVE 上凭据的真实权限，缺什么权限直接给出修复命令',
        icon: <IconCheck size={15} />,
      },
    ],
  },
];

/** 能力条目总数：页面上的「N 项能力」由它算出，不手写 */
export const CAPABILITY_TOTAL = DOMAINS.reduce((n, d) => n + d.items.length, 0);

/** 拍平索引：能力矩阵的关键词检索在它上面跑 */
export interface FlatCapability extends Capability {
  domainId: string;
  domainName: string;
}

export const ALL_CAPABILITIES: FlatCapability[] = DOMAINS.flatMap((domain) =>
  domain.items.map((item) => ({
    ...item,
    domainId: domain.id,
    domainName: domain.name,
  })),
);

/* ---------------------------------------------------------------------------
   顶栏导航锚点（FAQ 是否出现由服务端内容决定，见 Landing.tsx）
   --------------------------------------------------------------------------- */

export const NAV_LINKS: { id: string; label: string }[] = [
  { id: 'matrix', label: '能力矩阵' },
  { id: 'console', label: '控制台实况' },
  { id: 'architecture', label: '架构' },
  { id: 'highlights', label: '重点能力' },
  { id: 'security', label: '安全合规' },
  { id: 'start', label: '上手' },
];

/* ---------------------------------------------------------------------------
   重点能力：四件真正会左右选型的事
   每块配一张示意图，visual 决定渲染哪一种（见 Highlights.tsx）
   --------------------------------------------------------------------------- */

export type VisualKind = 'pipeline' | 'contain' | 'baseline' | 'auto';

export interface Highlight {
  id: string;
  /** 小标签，说明这块讲的是哪一段 */
  kicker: string;
  title: string;
  desc: string;
  points: string[];
  tags: string[];
  visual: VisualKind;
}

export const HIGHLIGHTS: Highlight[] = [
  {
    id: 'pipeline',
    kicker: '交付',
    title: '模板 + Cloud-init 交付流水线',
    desc: '把「开一台机器」变成一条可重复执行的流水线。后端按固定顺序推进，每步之间等待 PVE 任务真正完成，任一步失败都会自动删掉临时虚拟机，不留半成品。',
    points: [
      '从 cloud 镜像一键构建模板，无需手工敲 qm 命令',
      '克隆时注入主机名、静态 IP、SSH 公钥，开完即用',
      '构建过程中的临时虚拟机在失败时自动回收',
    ],
    tags: ['一键建模板', '注入主机名与 IP', '失败自动清理'],
    visual: 'pipeline',
  },
  {
    id: 'contain',
    kicker: '应急',
    title: '出事时的处置顺序是刻意的',
    desc: '可疑虚拟机一键隔离，顺序固定为「先取证快照 → 再断网 → 后关机」。反过来的话机器一关现场就没了。每一步独立执行、单独回报，取证失败不会阻止断网，但会明确标红。',
    points: [
      '断网只改 netX 的 link_down，网桥 / VLAN / MAC 原样保留',
      '关键备份登记后面板直接拒绝删除，勒索软件删不掉备份',
      '定期核对备份体积与时间戳，对不上就发告警',
    ],
    tags: ['一键隔离', '取证快照', '备份防删'],
    visual: 'contain',
  },
  {
    id: 'baseline',
    kicker: '合规',
    title: '安全基线一键体检与加固',
    desc: '对平台上的所有服务器并发体检 SSH、口令策略、防火墙、时间同步与内核参数。本机与受管主机共用同一套判定逻辑，结论口径完全一致。',
    points: [
      '按严重级别加权评分，缺权限的项不计入分母，不冤枉扣分',
      '可自动修复的项直接点修复，改完立即校验',
      '校验不过自动回滚，绝不把机器改到登录不上去',
    ],
    tags: ['批量体检', '自动修复', '校验不过自动回滚'],
    visual: 'baseline',
  },
  {
    id: 'auto',
    kicker: '自动化',
    title: '证书续期与机器人指令双自动',
    desc: '免费 DV 证书从申请、验证、签发到部署全自动，到期前自动续期并执行你配置的重载命令；飞书里 @机器人 就能查状态、开关机、建快照，白名单之外一律不执行。',
    points: [
      '证书支持部署到本机与受管主机，续期后可自动重载服务',
      '危险指令先弹确认卡片，点确认才执行',
      '机器人消息与面板操作进同一张审计表，追溯不分叉',
    ],
    tags: ['自动续期', '三类部署', '指令控制'],
    visual: 'auto',
  },
];

/* ---------------------------------------------------------------------------
   架构拓扑：浏览器 → 面板 → 多套 Proxmox 连接
   --------------------------------------------------------------------------- */

export interface TopoNode {
  name: string;
  desc: string;
}

/** 面板内部的三块能力，画在中间的方框里 */
export const TOPO_CORE: TopoNode[] = [
  { name: 'API 与权限', desc: 'RBAC 校验 · 审计落库' },
  { name: '实时通道', desc: '指标推送 · 控制台透传' },
  { name: '后台作业', desc: '巡检 · 告警 · 状态核对' },
];

/** 右侧多集群：强调「一套面板管多套 PVE」 */
export const TOPO_CLUSTERS: { name: string; nodes: string; meta: string }[] = [
  { name: 'proxmox-a', nodes: '3 节点', meta: '在线' },
  { name: 'proxmox-b', nodes: '1 节点', meta: '在线' },
  { name: 'proxmox-c', nodes: '2 节点', meta: '连接异常' },
];

/** 左侧入口 */
export const TOPO_ENTRIES: TopoNode[] = [
  { name: '浏览器控制台', desc: '虚拟机 / 容器 / 存储 / 安全' },
  { name: 'noVNC 与串口', desc: 'WebSocket 双向透传' },
  { name: '飞书机器人', desc: '群内指令与确认卡片' },
];

/* ---------------------------------------------------------------------------
   安全与合规（深色重音区）
   --------------------------------------------------------------------------- */

export interface Pillar {
  icon: ReactNode;
  title: string;
  desc: string;
}

export const PILLARS: Pillar[] = [
  {
    icon: <IconUsers size={17} />,
    title: '三级角色 + 自定义权限点',
    desc: 'admin / operator / viewer 内置，权限点由后端在 JWT 中下发，可逐条勾选覆盖',
  },
  {
    icon: <IconLock size={17} />,
    title: '凭据只放 HttpOnly Cookie',
    desc: 'JavaScript 读不到令牌，XSS 也偷不走；写操作还要过一次 CSRF 双提交校验',
  },
  {
    icon: <IconShield size={17} />,
    title: '危险操作二次确认',
    desc: '删除虚机、改连接、下发防火墙等操作即使 token 有效也要重输密码（开了 2FA 再加动态码）',
  },
  {
    icon: <IconKey size={17} />,
    title: '两步验证 TOTP',
    desc: '人人可开、角色可强制；绑定一次性给出 8 张恢复码，密钥加密落库',
  },
  {
    icon: <IconActivity size={17} />,
    title: '防爆破与全局限流',
    desc: '账号 + 来源 IP 双维度计数落库，重启不清零；接口按 IP 限流并返回 429',
  },
  {
    icon: <IconAudit size={17} />,
    title: '写操作与敏感读取都留痕',
    desc: '记录用户、动作、对象、结果与来源 IP；看连接配置、翻审计日志本身也记一条',
  },
];

/** 审计流水示例（示意数据，页面会标注「示意」） */
export interface AuditRow {
  time: string;
  user: string;
  action: string;
  target: string;
  result: 'ok' | 'denied' | 'failed';
}

export const AUDIT_SAMPLE: AuditRow[] = [
  { time: '14:02:11', user: 'admin', action: 'vm.start', target: 'web-01', result: 'ok' },
  {
    time: '14:02:36',
    user: 'admin',
    action: 'firewall.group.apply',
    target: '集群默认策略',
    result: 'ok',
  },
  {
    time: '14:03:02',
    user: 'ops',
    action: 'vm.delete',
    target: 'db-02',
    result: 'denied',
  },
  {
    time: '14:03:18',
    user: 'admin',
    action: 'config.connection.read',
    target: 'proxmox-a',
    result: 'ok',
  },
  {
    time: '14:04:05',
    user: 'ops',
    action: 'baseline.fix_all',
    target: 'host-03',
    result: 'failed',
  },
];

/* ---------------------------------------------------------------------------
   适用场景
   --------------------------------------------------------------------------- */

export interface Scenario {
  id: string;
  icon: ReactNode;
  title: string;
  desc: string;
  points: string[];
  tags: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'solo',
    icon: <IconServer size={17} />,
    title: '单机自建',
    desc: '一台 PVE 主机加上这个面板，就是把整套虚拟化平台管起来的最小组合。',
    points: [
      '虚拟机与容器同面板，创建、开关机、控制台一步到位',
      '模板 + Cloud-init 克隆即交付，不用每次从头装系统',
      '存储容量、ISO 上传与挂载都留在面板内完成',
      '快照与定时备份先把「能回滚」这条路留好',
    ],
    tags: ['计算', '存储', '数据保护'],
  },
  {
    id: 'cluster',
    icon: <IconLayers size={17} />,
    title: '多节点集群运维',
    desc: '节点一多，靠肉眼盯 PVE 网页版就不够了 —— 先把「谁在冒烟」摆到首屏。',
    points: [
      '节点在线状态、负载与 RRD 趋势曲线逐项下钻',
      '集群仲裁与 HA 态势直接进仪表盘关键指标',
      '存储按连接 / 共享 / 本地正确去重，容量不被重复累加',
      '资源占用排行支持内存与 CPU 双口径排序',
    ],
    tags: ['节点', '仪表盘', '监控告警'],
  },
  {
    id: 'delivery',
    icon: <IconTemplate size={17} />,
    title: '对外交付与自动化',
    desc: '把「开一台机器」变成一条可重复的流水线：模板、注入、配额、通知各管一段。',
    points: [
      'Cloud-init 注入主机名、IP 与登录密钥，克隆完直接可用',
      '下发配额控制还能开多少台，到上限时按钮直接禁用',
      'IP 地址池维护可复用地址段，创建时挑一个即可',
      '证书申请、签发、部署与到期续期全流程自动完成',
    ],
    tags: ['模板', 'IP 池', '网站证书'],
  },
  {
    id: 'security',
    icon: <IconShield size={17} />,
    title: '安全与合规追溯',
    desc: '从网络策略到主机加固，再到每一步操作留痕，出事时能说清发生了什么。',
    points: [
      '防火墙集群 / 节点 / 虚拟机三级规则与安全组',
      'SSH 登录日志统一采集，爆破命中即告警并联动 fail2ban',
      '端口与可疑进程巡检，反弹 shell 特征命中进告警',
      '登录历史与 sudo 提权记录可追溯，敏感操作全部入审计',
    ],
    tags: ['防火墙', 'SSH 安全', '安全基线', '审计日志'],
  },
];

/* ---------------------------------------------------------------------------
   上手流程 / 技术栈
   --------------------------------------------------------------------------- */

export const STEPS: { title: string; desc: string }[] = [
  {
    title: '部署面板',
    desc: '后端拉起来即可，前端由后端同源托管，一个端口对外。',
  },
  {
    title: '接入集群',
    desc: '填 Proxmox 地址与 API Token，保存后立即生效，凭据只留在后端。',
  },
  {
    title: '建模板、交付机器',
    desc: '用模板 + Cloud-init 一键克隆，IP、主机名、规格一次配好。',
  },
  {
    title: '打开值守能力',
    desc: '配置告警规则、基线巡检、证书续期与飞书机器人，之后交给面板盯着。',
  },
];

export const DEPLOY_LINES = [
  '# 构建前端产物，后端会同源托管 dist/ 与 /api',
  'npm run build',
  './start-prod.sh          # 监听 0.0.0.0:8080',
];

export const STACK: { icon: ReactNode; title: string; items: string[] }[] = [
  {
    icon: <IconCpu size={16} />,
    title: '前端',
    items: ['React 18 + TypeScript', 'Vite', 'TanStack Query', 'Recharts', 'noVNC / xterm.js'],
  },
  {
    icon: <IconServer size={16} />,
    title: '后端',
    items: ['Python 3.13 + FastAPI', 'httpx（异步）', 'WebSocket 双向透传', '后台作业调度'],
  },
  {
    icon: <IconCloud size={16} />,
    title: '数据与集成',
    items: ['MySQL 8', 'Proxmox VE API', '飞书开放平台', '腾讯云 SSL'],
  },
];
