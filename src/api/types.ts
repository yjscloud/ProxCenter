/* ==========================================================================
   ProxCenter — 全局 TS 类型定义
   对齐后端 FastAPI 契约（Proxmox VE 8.x / 9.x）
   ========================================================================== */

/* ---------------------------------------------------------------------------
   认证 / 用户
   --------------------------------------------------------------------------- */

export type PanelRole = 'admin' | 'operator' | 'viewer';

/**
 * 账号审批状态。
 * 自助注册的账号先进 `pending`，管理员审批通过才是 `active`；
 * `rejected` 的账号会留在库里（占住用户名），但无法登录。
 */
export type UserAccountStatus = 'active' | 'pending' | 'rejected';

/** 一条权限（来自 /api/permissions/catalog） */
export interface PermissionEntry {
  key: string;
  label: string;
  desc?: string;
}

/** 权限目录的一个分组 */
export interface PermissionGroup {
  key: string;
  label: string;
  permissions: PermissionEntry[];
}

/** 角色：一组权限的命名预设（内置或 admin 自建） */
export interface RoleOut {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  builtin: boolean;
  /** 有多少用户在使用该角色 */
  user_count?: number;
}

/** 用户列表 / 详情条目 */
export interface UserOut {
  id?: number | null;
  username: string;
  role: string;
  email?: string;
  enabled?: boolean;
  /** 审批状态；后端老版本可能不返回，按 active 处理 */
  status?: UserAccountStatus;
  created?: number;
  /** 该用户实际生效的权限 */
  permissions?: string[];
  comment?: string;
  /** 用户级覆盖：null/undefined = 继承角色；有值 = 以它为准 */
  permissions_override?: string[] | null;
}

export interface UserInfo {
  id: number;
  username: string;
  role: PanelRole | string;
  permissions: string[];
  /** 用户级权限覆盖：null/undefined = 继承角色；有值 = 以它为准 */
  permissions_override?: string[] | null;
  /** 可选字段：列表接口返回 */
  enabled?: boolean;
  status?: UserAccountStatus;
  email?: string;
  comment?: string;
  created?: string;
  /** 是否已绑定两步验证（TOTP） */
  totp_enabled?: boolean;
}

/** 自助注册：提交后进入待审批队列 */
export interface RegisterInput {
  username: string;
  password: string;
  email?: string;
}

/** 自助重置第 1 步：提交用户名，面板给账号邮箱发一次性链接 */
export interface ForgotPasswordInput {
  username: string;
}

/**
 * 自助重置的响应。
 *
 * 刻意不区分「账号是否存在」：这是公开接口，一旦给出不同响应
 * 就成了一台账号枚举机，所以永远返回同一句话。
 */
export interface ForgotPasswordResult {
  ok: boolean;
  message: string;
}

/** 校验重置链接是否还有效（不消耗令牌） */
export interface ResetTokenCheck {
  valid: boolean;
  username: string;
}

export interface LoginRequest {
  username: string;
  password: string;
  /** 图形验证码：验证方式为「关闭」时不校验，可不传 */
  captcha_id?: string;
  captcha_code?: string;
  /** 滑块验证码：拖动结束时拼图块的水平位置（展示坐标 px） */
  captcha_x?: number;
}

/**
 * 登录页的验证方式。
 * off = 不校验；image = 四位图形码；slider = 拖动滑块拼图。
 * 由管理员在「设置 → 登录验证」里切换。
 */
export type LoginCaptchaMode = 'off' | 'image' | 'slider';

/** 登录验证挑战：required=false 表示后端已关闭验证 */
export interface CaptchaChallenge {
  required: boolean;
  /** 后端老版本不返回这个字段，按 image 处理 */
  mode?: LoginCaptchaMode;
  id?: string;
  /** 图形验证码：data:image/png;base64,... */
  image?: string;
  /* ---- 滑动验证（拖动滑块到最右端即通过，没有图片素材） ---- */
  /** 轨道的设计宽度（展示坐标）：手柄宽度与可拖动范围都按它换算百分比 */
  width?: number;
  /** 手柄宽度（展示坐标）；拖到最右时手柄右缘贴住轨道右缘 */
  handle_size?: number;
  /** 距末端多少 px 以内也算拖到底：前端据此提前给「已达标」的反馈 */
  tolerance?: number;
}

/** 自助修改个人信息（当前仅邮箱可改） */
export interface ProfileUpdateInput {
  email: string;
}

/** 自助修改密码：需提供当前密码；开了两步验证还要带动态码 */
export interface PasswordChangeInput {
  current_password: string;
  new_password: string;
  totp_code?: string;
}

/** 个人中心：自己的角色与生效权限（已翻译为中文标签） */
export interface MyPermissionEntry {
  key: string;
  label: string;
  desc: string;
}

export interface MyPermissionGroup {
  key: string;
  label: string;
  permissions: MyPermissionEntry[];
}

export interface MyPermissions {
  role: string;
  role_name: string;
  role_description: string;
  is_admin: boolean;
  permissions: string[];
  groups: MyPermissionGroup[];
}

/**
 * 登录 / 刷新令牌的结果。
 *
 * 开了两步验证的账号，第一次只拿得到 `mfa_required: true` 与 `mfa_token`，
 * 要用它 + 动态码再调一次 `/auth/login/2fa` 才换得到 access_token。
 */
export interface LoginResponse {
  /** 需要第二步验证时为空字符串 */
  access_token: string;
  token_type: string;
  /** 需要第二步验证时为 null */
  user: UserInfo | null;
  mfa_required?: boolean;
  mfa_token?: string;
  /** 该角色被强制要求开 2FA，但还没绑定 */
  totp_setup_required?: boolean;
}

/** 两步验证状态 */
export interface TwoFactorStatus {
  enabled: boolean;
  /** 角色被要求必须开启（TOTP_REQUIRED_ROLES） */
  required: boolean;
  recovery_codes_left: number;
}

/** 绑定两步验证：扫码用的二维码与种子（种子明文只在这一步返回） */
export interface TwoFactorSetup {
  secret: string;
  otpauth_url: string;
  /** data:image/png;base64,... */
  qr_png: string;
  message: string;
}

/** 一台已登录设备（= 一个服务端会话） */
export interface AuthSession {
  id: string;
  created: number;
  expires_at: number;
  ip: string;
  user_agent: string;
  /** 是否就是当前这台设备 */
  current: boolean;
}

/* ---------------------------------------------------------------------------
   个人 API Token（脚本 / 外部系统用的长期凭据）
   --------------------------------------------------------------------------- */

/**
 * 一枚 API Token。
 *
 * 注意这里**没有明文**：明文只在创建那一次的响应（`ApiTokenCreated`）里出现，
 * 之后服务端只剩摘要，谁也取不回来。
 */
export interface ApiToken {
  id: number;
  name: string;
  /** 展示用前缀（zp_ 开头），用来认出是哪一枚；不足以还原出完整令牌 */
  prefix: string;
  created: number;
  /** 0 表示永不过期 */
  expires_at: number;
  last_used: number;
  last_ip: string;
  revoked: boolean;
  expired: boolean;
  /** 服务端现算的「是否已过期」，与 expires_at 一起给 */
  username?: string;
}

/** 创建令牌的响应：比 ApiToken 多一个只在这一次出现的明文。 */
export interface ApiTokenCreated extends ApiToken {
  /** 唯一一次能拿到明文的时机，务必当场复制走 */
  token: string;
}

export interface ApiTokenList {
  items: ApiToken[];
  /** 管理员可整体停用该功能；为 false 时界面只做只读展示 */
  enabled: boolean;
  /** 每人的有效令牌上限 */
  max: number;
  /** 当前仍然有效的数量 */
  active: number;
  default_ttl_days: number;
}

/* ---------------------------------------------------------------------------
   后台作业（调度器）
   --------------------------------------------------------------------------- */

/** 作业最近一次执行的结局 */
export type SchedulerRunStatus = 'never' | 'running' | 'ok' | 'error';

export interface SchedulerJob {
  id: string;
  name: string;
  /** 界面上按组分块展示 */
  group: string;
  description: string;
  /** 当前生效的间隔（秒） */
  interval: number;
  /** 代码里的默认间隔（秒） */
  default_interval: number;
  min_interval: number;
  max_interval: number;
  enabled: boolean;
  /** 间隔或启停被改过（≠ 代码默认值） */
  modified: boolean;
  running: boolean;
  runs: number;
  failures: number;
  /** 因为上一轮还没跑完而跳过的次数：说明间隔设得比实际耗时还短 */
  skipped: number;
  last_status: SchedulerRunStatus;
  last_start: number;
  last_end: number;
  last_duration_ms: number;
  last_error: string;
  last_summary: string;
  /** 本次是手动「立即执行」触发的 */
  last_manual: boolean;
  /** 距下次执行还有多少秒 */
  next_in: number;
  /** 下次执行的绝对时间（秒） */
  next_at: number;
}

export interface SchedulerOverview {
  jobs: SchedulerJob[];
  /** 调度器检查周期（秒） */
  tick: number;
  total: number;
  enabled: number;
  running: number;
  /** 最近一次以失败收场的作业数 */
  failing: number;
  /** 一次都没跑过的作业数 */
  never_run: number;
}

/* ---------------------------------------------------------------------------
   用户界面偏好（仪表盘布局）
   --------------------------------------------------------------------------- */

/**
 * 仪表盘布局。
 *
 * `order` 是全部 widget 的 id 顺序（含被隐藏的），`hidden` 是被隐藏的 id。
 * 隐藏项仍然保留在 `order` 里 —— 这样「显示回来」能回到原来的位置，
 * 而不是被甩到最末尾。
 */
export interface DashboardLayout {
  order: string[];
  hidden: string[];
}

export interface PrefsPayload {
  prefs: Record<string, unknown>;
  /** 服务端认识的偏好键，前端据此决定要不要写 */
  keys: string[];
}

export interface RoleInfo {
  role: string;
  privs: string[];
  description?: string;
}

/* ---------------------------------------------------------------------------
   连接配置
   --------------------------------------------------------------------------- */

export interface ConnectionConfig {
  host: string;
  port: number;
  token_id: string;
  /** 后端只回传「是否已设置」，不回传明文 secret */
  token_secret_set: boolean;
  console_user: string;
  console_password_set: boolean;
  verify_ssl: boolean;
  /**
   * 新建连接时的默认校验策略（跟随后端 PVE_VERIFY_SSL，生产默认开启）。
   * 仅 GET /config/connection 返回，已保存连接的值以 verify_ssl 为准。
   */
  verify_ssl_default?: boolean;
  node_default: string;
  configured: boolean;
  /** 多连接：连接标识与名称 */
  id?: string;
  name?: string;
}

/** 一条已保存的 PVE 连接（多连接列表项） */
export interface ConnectionProfile extends ConnectionConfig {
  id: string;
  name: string;
  active: boolean;
}

export interface ConnectionConfigInput {
  /** 连接显示名（多连接用） */
  name?: string;
  host: string;
  port: number;
  token_id: string;
  /**
   * 留空 = 保持后端已存的 secret 不变（后端据此区分「未修改」与「清空」）。
   * 首次配置时必须填写。
   */
  token_secret?: string;
  /** 控制台（VNC）用的 PVE 账号，留空则禁用控制台 */
  console_user?: string;
  /** 留空 = 保持后端已存的密码不变 */
  console_password?: string;
  verify_ssl: boolean;
  node_default: string;
}

/** 测试连接时后端回报的一个可见节点（PVE `/nodes` 的裁剪版） */
export interface ConnectionTestNode {
  /** 节点名（后端把 PVE 的 node 字段映射过来的） */
  name?: string;
  /** online / offline 等 */
  status?: string;
  /** PVE 原始 type，节点恒为 node */
  type?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  version: string;
  release: string;
  /**
   * 可见节点。
   *
   * 是**对象数组**而不是字符串数组：后端 `/config/connection/test` 在把 PVE 的
   * `node` 映射成 `name` 时顺带带上了 `status` / `type`（见 routers/config.py）。
   * 这里曾经写成 `string[]`，类型说谎让「把对象当子节点渲染」没被 TS 拦住，
   * 一点「测试连接」就抛 React #31（object with keys {name, status, type}）。
   */
  nodes: ConnectionTestNode[];
  message?: string;
}

/** 一条已保存 PVE 连接的可达性（多台同时在线时用于提示哪台不可用） */
export interface ConnectionStatus {
  id: string;
  name: string;
  host: string;
  port: number;
  ok: boolean;
  /** 不可用时的原因 */
  error: string | null;
  node_count: number;
  /** 节点 CPU/内存指标是否可读；false 通常意味着令牌权限不足（虚拟机列表也会是空的） */
  node_metrics: boolean;
}

/**
 * 单条 PVE 连接的合计状态（`/api/cluster/fleet-status`）。
 *
 * 面板把多条连接当同级，所以全局位置上的读数必须是**所有连接合计**；
 * 这个形状就是把「每台一眼看完」所需的最小字段凑在一起。
 */
export interface FleetConnectionStatus {
  id: string;
  name: string;
  host: string;
  ok: boolean;
  error: string | null;
  /** PVE 版本号，如 "9.0.3"；不可达时为空串 */
  version: string;
  node_count: number;
  /** cluster = 多节点集群；standalone = 单机（这时候 HA 无从谈起） */
  cluster_mode: 'cluster' | 'standalone';
  /** 只有集群才有意义；单机与读取失败都是 null */
  quorate: boolean | null;
  ha_enabled: boolean;
  ha_resources: number;
}

export interface FleetTotals {
  connections: number;
  online: number;
  nodes: number;
  clusters: number;
  standalone: number;
  ha_enabled: number;
  ha_resources: number;
  /** quorate === false 的连接数，非零即代表有集群失去仲裁 */
  no_quorum: number;
}

export interface FleetStatus {
  connections: FleetConnectionStatus[];
  totals: FleetTotals;
  /**
   * 只能读单台的接口（健康探活、`/cluster/status`）走这一套。
   * 管理员可在「设置 → 系统信息」里改；它不是「主连接」，其余连接照样同级。
   */
  default_connection?: { id: string; name: string };
}

/** 「一键修复令牌权限」的结果：给该连接的 API Token 授予 PVEAdmin */
export interface ConnectionRepairResult {
  ok: boolean;
  token_id: string;
  role: string;
  /** 授权后该令牌的有效权限，形如 "VM.Audit@/" */
  effective_privileges: string[];
  /** 节点 CPU / 内存 / 磁盘指标是否已可读 */
  node_metrics: boolean;
}

/** 单项环境自检结果 */
export interface DiagnosticsCheck {
  key: string;
  label: string;
  /** ok = 正常；warn = 可用但有提醒；fail = 该能力不可用 */
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** 成因说明或修复提示 */
  hint?: string;
}

/** 环境自检汇总。用于把「令牌权限不足」这类问题讲清楚 */
export interface DiagnosticsResult {
  /** 核心功能是否可用（status !== 'fail'） */
  ok: boolean;
  status: 'ok' | 'warn' | 'fail';
  reachable: boolean;
  host: string;
  token_id: string;
  pve_version: string | null;
  /** 当前凭据的有效权限，形如 "VM.Audit@/" */
  effective_privileges: string[];
  checks: DiagnosticsCheck[];
  /** 可直接执行的修复命令或操作步骤 */
  remediation: string[];
}

/** 面板级创建默认值：新建 / 克隆虚拟机时自动套用 */
export interface VmDefaults {
  /** 默认 DNS（空格分隔）；空串 = 不干预，保持继承 DHCP / RA 下发的 DNS */
  dns: string;
}

/**
 * 资源规格（套餐）：管理员在设置页定义「几核 / 几 G 内存 / 多大盘」，
 * 用户在下单页直接挑一个，不用自己算资源。
 *
 * 规格只是**一组数字**：创建时被翻译成 `cores` / `memory` / 磁盘大小交给既有的
 * 创建接口，不参与配额判定（配额按台数，见 `VmQuotaInfo`）。
 */
export interface ResourceSpec {
  /** 稳定标识，前端拿它当 key 与表单值 */
  id: string;
  name: string;
  /** 适用类型：虚拟机 / 容器 / 通用 */
  kind: 'vm' | 'lxc' | 'both';
  /** 核数 */
  cores: number;
  /** 内存（MB） */
  memory: number;
  /** 磁盘（GB） */
  disk: number;
  description?: string;
}

/* ---------------------------------------------------------------------------
   硬件健康
   --------------------------------------------------------------------------- */

/** 磁盘健康（来自 PVE 的 /nodes/{node}/disks/list，一次拿全部磁盘） */
export interface DiskHealth {
  devpath: string;
  type: string;
  vendor: string;
  model: string;
  serial: string;
  size?: number | null;
  /** 用途说明，如 "BIOS boot"、"ZFS"；空串表示未使用 */
  used: string;
  /** passed | warning | failed | unknown */
  health: string;
  /** 固态硬盘的**剩余**寿命百分比；机械盘没有这个概念，为 null */
  wearout?: number | null;
  rpm?: number | null;
  gpt: boolean;
}

/** 单块磁盘的 SMART 详情（点开才请求） */
export interface DiskSmart {
  health: string;
  /** ATA 盘为 "attributes"，NVMe 盘为 "text" */
  type: string;
  wearout?: number | null;
  attributes: Array<{
    id?: number;
    name: string;
    value?: number | null;
    worst?: number | null;
    threshold?: number | null;
    /** 该属性已触发失败阈值 —— 最该高亮的一列 */
    fail: boolean;
    flags: string;
  }>;
  /** NVMe 盘的原始 SMART 文本 */
  text: string;
}

/** ZFS 池状态 */
export interface ZfsPool {
  name: string;
  state: string;
  size?: number | null;
  alloc?: number | null;
  free?: number | null;
  frag?: string | null;
  dedup?: string | null;
  health?: string | null;
  errors: string;
}

/** 一条友情链接 */
export interface SiteLink {
  name: string;
  /** http / https 绝对地址，或站内相对路径（后端做白名单校验） */
  url: string;
}

/** 备份任务成败统计 */
export interface BackupStats {
  days: number;
  total: number;
  ok: number;
  failed: number;
  running: number;
  /** null 表示统计窗口内一次备份都没有 —— 与 0% 有本质区别 */
  success_rate: number | null;
  failures: Array<{
    node: string;
    vmid?: string;
    upid: string;
    user: string;
    starttime: number;
    endtime: number;
    status: string;
    connection_id: string;
    connection_name: string;
  }>;
}

/** 一条常见问题（产品官网 FAQ 区块） */
export interface FaqItem {
  /** 问题，作为可点击展开的标题 */
  q: string;
  /** 答案，展开后显示的正文 */
  a: string;
}

/** 站点信息：品牌名 / 副标题 / 版权 / 备案号 / 友情链接 / 自定义 Logo，可在「设置 → 站点信息」中自定义 */
export interface SiteInfo {
  /** 站点名称：侧边栏、登录页、落地页与浏览器标题都用它 */
  name: string;
  /** 侧边栏品牌区副标题 */
  subtitle: string;
  /** 落地页页脚的版权信息 */
  copyright: string;
  /** 备案号（如「京ICP备2024000000号-1」）；空串 = 页脚不展示 */
  icp: string;
  /** 友情链接；空数组 = 页脚不展示该区块 */
  links: SiteLink[];
  /** 自定义 Logo 地址（带版本号，换图后自动失效）；未上传时为 null，界面回落内置图标 */
  logo_url: string | null;
  /** 自定义登录页背景图地址（带版本号）；未上传时为 null，登录页回落内置插画 */
  login_bg_url: string | null;
}

/**
 * 面板级界面开关（服务端，全局生效），可在「设置 → 导航栏功能开关」中修改。
 *
 * 当前只有一组：导航栏里哪些入口被关闭（见 app/ui.py）。导航栏本身始终渲染。
 */
export interface UiPrefs {
  /**
   * 已关闭的入口路径清单（如 `['/frp']`）。命中的入口从侧边栏、顶栏菜单与
   * 全局搜索里消失，直接输 URL 也会被弹回一个还开着的页面。
   * 匹配按前缀走：关掉 `/nodes` 连它的子页面一起关。
   */
  nav_disabled: string[];
}

/* ---------------------------------------------------------------------------
   邮件通知（SMTP）
  服务器配置是全局的（管理员在设置页配），告警的收件人则按用户各自配置。
   --------------------------------------------------------------------------- */

export type MailTlsMode = 'starttls' | 'ssl' | 'none';

/** 邮件配置（读接口返回）：**不含密码明文**，只有 password_set */
export interface MailConfig {
  enabled: boolean;
  host: string;
  port: number;
  tls: MailTlsMode;
  username: string;
  sender: string;
  sender_name: string;
  verify_ssl: boolean;
  /** 注册 / 审批通知的收件人，英文逗号分隔；留空则发给填了邮箱的管理员 */
  admin_recipients: string;
  /** 是否已保存过 SMTP 密码 */
  password_set: boolean;
  /** 是否已经配到「能发信」的程度 */
  configured: boolean;
}

/** 保存邮件配置：password 留空 = 沿用旧值，password_clear 才清空 */
export interface MailConfigInput {
  enabled?: boolean;
  host?: string;
  port?: number;
  tls?: MailTlsMode;
  username?: string;
  password?: string;
  password_clear?: boolean;
  sender?: string;
  sender_name?: string;
  verify_ssl?: boolean;
  admin_recipients?: string;
}

/** 某个用户的告警邮件收件人配置 */
export interface AlertEmailConfig {
  enabled: boolean;
  /** 英文逗号分隔；留空 = 用账号邮箱 */
  recipients: string;
}

/**
 * 通用 Webhook 通道配置。
 *
 * 一个通道覆盖企业微信 / 钉钉 / Slack / 自建接收端：差异只在请求体形状上，
 * 用「模板 + 占位符」表达即可，新增一家渠道不需要改代码。
 */
export interface AlertWebhookConfig {
  enabled: boolean;
  /** 留空 = 不修改；读取时后端永远返回空串（地址加密存储，不回显） */
  webhook?: string;
  /** 签名密钥：留空 = 不修改；读取时同样为空串 */
  secret?: string;
  /** 冷却时间（秒） */
  cooldown: number;
  /** 请求体模板（JSON 文本，支持 {{占位符}}）；留空用内置默认体 */
  template: string;
  /** 额外请求头（JSON 对象文本），用于渠道特有的鉴权头 */
  headers: string;
}

/** Webhook 请求体预设模板（企业微信 / 钉钉 / Slack / 通用） */
export interface AlertWebhookPreset {
  label: string;
  template: string;
  headers: string;
}

/* ---------------------------------------------------------------------------
   站内通知（顶部铃铛）
   --------------------------------------------------------------------------- */

/**
 * 一条站内消息。
 *
 * 与 AlertRecord（告警历史）的分工：历史是「评估结果清单」，这里是「面向人的
 * 待办」—— 有未读/已读状态、可点进去。同一条告警对多个收件人只算一条历史，
 * 但每个收件人各有一条自己的未读消息。
 */
export interface AppNotification {
  id: number;
  /** 事件类别：alert / recovery */
  kind: string;
  /** 级别：danger / success / info */
  level: string;
  title: string;
  body: string;
  /** 点击后跳转的面板路径；为空表示没有可跳转的目标 */
  link: string;
  /** Unix 秒 */
  created: number;
  read: boolean;
}

export interface NotificationListResult {
  items: AppNotification[];
  unread: number;
}

/* ---------------------------------------------------------------------------
   全局搜索 / 命令面板
   --------------------------------------------------------------------------- */

export interface SearchItem {
  key: string;
  title: string;
  subtitle: string;
  /** 面板内路径，如 /vms/pve1/100 或 /nodes/pve1 */
  link: string;
  /** 结果右侧的小标签，如「容器」「模板」「节点」 */
  badge: string;
}

export interface SearchGroup {
  key: string;
  label: string;
  /** 命中总数（items 已按 limit 截断） */
  count: number;
  items: SearchItem[];
}

export interface SearchResult {
  query: string;
  groups: SearchGroup[];
  total: number;
}

export interface HealthStatus {
  status: string;
  pve_connected: boolean;
  /** 面板自身版本 */
  version: string;
  /** 当前连接到的 Proxmox VE 版本 */
  pve_version?: string | null;
  node_count?: number;
}

/* ---------------------------------------------------------------------------
   集群
   --------------------------------------------------------------------------- */

export interface ClusterNodeStatus {
  name: string;
  online: boolean;
  type: string;
}

export interface ClusterStatus {
  /** 单机（未组集群）时后端返回 null，不要当成「仲裁丢失」 */
  quorate: boolean | null;
  nodes: ClusterNodeStatus[];
  version: string;
}

/**
 * 集群仲裁与 HA 状态（`/api/cluster/ha-status`）。
 *
 * 读的是**默认连接**那一套 PVE，所以带上 `connection_name`：多连接部署下
 * 不标出名字，这张卡会被当成全站结论。
 */
export interface ClusterHaStatus {
  quorum: { quorate: boolean | null; status: string };
  /** HA 已启用：有托管资源，或集群选出了 master（多节点） */
  ha_enabled: boolean;
  ha_resources: Array<{
    id?: string;
    state?: string;
    node?: string;
    sid?: string;
    type?: string;
  }>;
  /** CRM master 所在节点；单机或未启用时为空串 */
  ha_master?: string;
  node_count?: number;
  cluster_mode?: 'cluster' | 'standalone';
  connection_name?: string;
}

export type ResourceType = 'qemu' | 'lxc' | 'node' | 'storage' | 'sdn' | string;

export interface ClusterResource {
  id: string;
  type: ResourceType;
  node: string;
  vmid?: number;
  name?: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  template?: number | boolean;
  tags?: string;
  storage?: string;
}

/* ---------------------------------------------------------------------------
   节点
   --------------------------------------------------------------------------- */

export interface NodeInfo {
  node: string;
  /** 多台 PVE 合并展示时，标注该节点来自哪条连接 */
  connection_id?: string;
  connection_name?: string;
  status: 'online' | 'offline' | 'unknown' | string;
  cpu: number;
  maxcpu?: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  level?: string;
  /** 补充信息（部分后端会返回） */
  ssl_fingerprint?: string;
  /** PVE 可能返回字符串数组（如 ["0.52","0.58","0.59"]），展示前需转数字 */
  loadavg?: Array<number | string>;
  kernel?: string;
}

export interface NodeStatus {
  node: string;
  status: string;
  uptime: number;
  cpu: number;
  cpus: number;
  memory: {
    total: number;
    used: number;
    free: number;
  };
  swap?: {
    total: number;
    used: number;
    free: number;
  };
  rootfs?: {
    total: number;
    used: number;
    free: number;
    avail: number;
  };
  /** PVE 可能返回字符串数组（如 ["0.52","0.58","0.59"]），展示前需转数字 */
  loadavg?: Array<number | string>;
  pveversion?: string;
  kernel?: string;
  ksm?: unknown;
}

export interface RrdPoint {
  time: number;
  cpu?: number;
  memused?: number;
  mem?: number;
  memtotal?: number;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
  maxcpu?: number;
  maxmem?: number;
  /** 虚拟机磁盘用量（字节），仅虚拟机 rrddata 提供 */
  disk?: number;
  maxdisk?: number;
  /** IO 等待占比（0~1）：CPU 不高但磁盘慢时，最先在这里体现 */
  iowait?: number;
  /** 负载均值，PVE 返回字符串数组 ["0.52","0.58","0.59"] */
  loadavg?: Array<number | string>;
  /** 根文件系统用量（字节） */
  rootused?: number;
  roottotal?: number;
  /** Swap 用量（字节），节点未启用 swap 时为 0 */
  swapused?: number;
  swaptotal?: number;
  /** PSI 压力指标（PVE 8）：某类资源「有多少比例的时间被阻塞」，取值为 0~1 */
  pressurecpusome?: number;
  pressureiosome?: number;
  pressurememorysome?: number;
}

export type RrdTimeframe = 'hour' | 'day' | 'week' | 'month' | 'year';

/* ---------------------------------------------------------------------------
   网络
   --------------------------------------------------------------------------- */

export type NetworkType =
  | 'bridge'
  | 'bond'
  | 'eth'
  | 'vlan'
  | 'alias'
  | 'OVSBridge'
  | 'OVSBond'
  | 'OVSPort'
  | 'OVSIntPort'
  | 'unknown';

export interface NetworkInterface {
  iface: string;
  type: NetworkType | string;
  active: boolean;
  address?: string;
  cidr?: string;
  netmask?: string;
  gateway?: string;
  bridge_ports?: string;
  bridge_vlan_aware?: boolean;
  bond_slaves?: string;
  vlan_id?: number;
  vlan_raw_device?: string;
  autostart?: boolean;
  mtu?: number;
  comments?: string;
  method?: string;
  families?: string[];
  /** 前端本地标记：有未应用的变更 */
  _pending?: boolean;
}

export interface NetworkInterfaceInput {
  iface: string;
  type: NetworkType | string;
  address?: string;
  cidr?: string;
  gateway?: string;
  bridge_ports?: string;
  autostart?: boolean;
  comments?: string;
  mtu?: number;
  vlan_id?: number;
  vlan_raw_device?: string;
  bond_slaves?: string;
  bond_mode?: string;
}

/** IP 地址池：一段可分配的静态地址范围（不依赖 DHCP / SDN） */
export interface IpPool {
  id: string;
  name: string;
  bridge: string;
  subnet: string;
  gateway: string;
  start: string;
  end: string;
  dns: string;
}

/** 带空闲地址信息的地址池（GET 返回） */
export interface IpPoolStatus extends IpPool {
  free: string[];
  free_count: number;
}

/* ---------------------------------------------------------------------------
   存储
   --------------------------------------------------------------------------- */

export type StorageType =
  | 'dir'
  | 'lvm'
  | 'lvmthin'
  | 'nfs'
  | 'cifs'
  | 'zfspool'
  | 'rbd'
  | 'glusterfs'
  | 'cephfs'
  | 'iscsi'
  | 'pbs'
  | 'btrfs'
  | string;

export interface Storage {
  storage: string;
  type: StorageType;
  content: string;
  active: boolean;
  total: number;
  used: number;
  avail: number;
  shared: boolean;
  node: string;
  /** 多台 PVE 聚合时，标注该存储来自哪条连接（同名存储是各自独立的两份容量） */
  connection_id?: string;
  connection_name?: string;
}

export interface StorageContent {
  volid: string;
  format: string;
  size: number;
  ctime: number;
  vmid?: number;
  name?: string;
  content?: string;
  notes?: string;
  /** 后端可能用 parent / verification 等字段 */
  parent?: string;
}

/* ---------------------------------------------------------------------------
   虚拟机
   --------------------------------------------------------------------------- */

export type VmStatus =
  | 'running'
  | 'stopped'
  | 'paused'
  | 'suspended'
  | 'stopping'
  | 'starting'
  | 'unknown'
  | string;

export interface VmSummary {
  node: string;
  /** 多台 PVE 合并展示时，标注该虚拟机来自哪条连接 */
  connection_id?: string;
  connection_name?: string;
  vmid: number;
  name: string;
  status: VmStatus;
  /** 主 IP（列表接口 with_ip=true 时返回，Guest Agent 优先、回退静态配置） */
  ip?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  /**
   * 创建时间（秒级 Unix 时间戳）。两个来源，面板侧优先：
   *
   * 1. 面板发起的新建 / 克隆 / 恢复 —— 操作那一刻记下，**准确**；
   * 2. PVE 写在 config 里的 `meta.ctime` —— 存量机器用这个，但**克隆 / 恢复会
   *    继承来源机器的时间**（面板自身发起的克隆已按实际时刻纠正）。
   *
   * 两处都取不到时为 `null`（PVE 8 之前建的机器、以及容器普遍如此），界面显示「—」。
   * 细节见 backend/app/guest_created.py。
   */
  created?: number | null;
  template?: number | boolean;
  tags?: string;
  /**
   * guest 类型：`qemu` = 虚拟机，`lxc` = 容器。
   * 只在 `/vms?type=all` 下才有意义（默认接口只返回虚拟机）。
   * 前端靠它决定跳转到 `/vms/:node/:id` 还是 `/lxc/:node/:id`、
   * 以及电源 / 快照 / 删除该调哪一套接口。
   */
  type?: string;
  /** 集群资源 ID，形如 qemu/100 */
  id?: string;
  pool?: string;
  /** 操作锁（如 backup、migrate、clone），非空时表示有任务进行中 */
  lock?: string;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
}

/** guest 类型：虚拟机 / 容器 */
export type GuestType = 'qemu' | 'lxc';

/**
 * 归一取出 guest 类型。
 *
 * 后端在 `/vms?type=all` 返回 `type` 字段，但很多调用点拿到的是
 * `VmSummary` 之外的形状（快照行、下拉选项…），统一走这个函数避免出现
 * 「容器被当成虚拟机、调到 qemu 接口上」的串台。
 */
export function guestTypeOf(guest: { type?: unknown } | null | undefined): GuestType {
  return guest?.type === 'lxc' ? 'lxc' : 'qemu';
}

/* ---------------------------------------------------------------------------
   批量操作
   一次请求对多台机器执行同一动作；逐台回报结果（与防火墙模板下发同一套形状）。
   --------------------------------------------------------------------------- */

export type BulkAction =
  | 'start'
  | 'stop'
  | 'shutdown'
  | 'reboot'
  | 'suspend'
  | 'resume'
  | 'delete'
  | 'tag'
  | 'migrate'
  | 'balloon'
  | 'snapshot';

/** 一台目标机器。type 能带就带，省掉后端一次探测请求。 */
export interface BulkTarget {
  node: string;
  vmid: number;
  type?: 'qemu' | 'lxc';
  /** 仅用于结果回显 */
  name?: string;
}

/** 各动作取用的附加参数，用不到的留空。 */
export interface BulkParams {
  /** stop / shutdown 的超时与强制兜底 */
  timeout?: number;
  force_stop?: boolean;
  /** delete */
  purge?: boolean;
  /** tag */
  tags?: string;
  /** replace = 覆盖；append = 追加到原标签之后 */
  tag_mode?: 'replace' | 'append';
  /** balloon：内存气球的最低保留量（MB）。0 = 关掉气球驱动；只对虚拟机有效 */
  balloon?: number;
  /** migrate */
  target_node?: string;
  online?: boolean;
  /** snapshot */
  name?: string;
  description?: string;
  vmstate?: boolean;
}

export interface BulkRequest {
  action: BulkAction;
  targets: BulkTarget[];
  params?: BulkParams;
}

export interface BulkItemResult {
  node: string;
  vmid: number;
  name: string;
  type: string;
  ok: boolean;
  /** PVE 任务 UPID（有些动作没有任务，如打标签） */
  task: string | null;
  error: string | null;
}

export interface BulkResponse {
  action: BulkAction;
  total: number;
  ok: number;
  failed: number;
  results: BulkItemResult[];
}

export interface VmDiskConfig {
  key: string;
  storage: string;
  size: string;
  format?: string;
  volume?: string;
  interface?: string;
}

export interface VmNetworkConfig {
  key: string;
  /** PVE 返回的接口名（如 net0）。部分后端字段用 interface，展示时需兼容 key。 */
  interface?: string;
  bridge?: string;
  model?: string;
  macaddr?: string;
  vlan_tag?: number;
  firewall?: boolean;
  rate?: number;
  tag?: number;
}

export interface VmAgentInterface {
  name: string;
  hardware_address?: string;
  ip_addresses?: Array<{ ip_address: string; prefix?: number; ip_address_type?: string }>;
}

export interface VmDetail {
  node: string;
  vmid: number;
  name: string;
  status: VmStatus;
  template?: number | boolean;
  config: VmConfig;
  /** 实时资源 */
  cpu?: number;
  /** QEMU 的 status/current 里没有 maxcpu，vCPU 数在 cpus 字段 */
  cpus?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  /**
   * 注意：QEMU 虚拟机的 status.disk 恒为 0（那是容器才有的字段），
   * maxdisk 是磁盘的分配总量。所以这两个字段不能当「已用 / 容量」用。
   */
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  /** 创建时间；面板记录优先，其次 PVE 的 `meta.ctime`，都没有时为 null */
  created?: number | null;
  /**
   * 来源模板：这台机器从哪个模板克隆来的（模板已删时 name 为空串）。
   *
   * 新建、ISO 安装、导入出来的机器没有来源模板，这里是 null —— 那是「确实没有」，
   * 不是「没查到」。链接克隆的机器尤其要看这一行：磁盘依赖该模板，模板一删这台
   * 机器就起不来了。
   */
  source_template?: { node: string; vmid: number; name: string } | null;
  disks: VmDiskConfig[];
  networks: VmNetworkConfig[];
  /** 配置里是否启用了 QEMU Guest Agent（agent: 1 / enabled=1）*/
  agent_enabled: boolean;
  /** Guest Agent 是否真的回话了（虚拟机没运行时恒为 false）*/
  agent_available: boolean;
  /** 客户机内网卡（来自 Guest Agent）*/
  agent_interfaces?: VmAgentInterface[];
  tags?: string;
  lock?: string;
}

export interface VmConfig {
  /** 常用字段，其余走索引签名 */
  name?: string;
  description?: string;
  memory?: number | string;
  balloon?: number | string;
  cores?: number | string;
  sockets?: number | string;
  cpu?: string;
  cpuunits?: number | string;
  vcpus?: number | string;
  ostype?: string;
  bios?: string;
  machine?: string;
  scsihw?: string;
  boot?: string;
  onboot?: number | boolean;
  agent?: number | string;
  bootdisk?: string;
  iso?: string;
  /* 高级硬件 */
  /** NUMA 开关（0/1） */
  numa?: number | boolean;
  /** 整机 CPU 亲和性 cpuset，如 "0-7" */
  affinity?: string;
  /** EFI 变量盘，值形如 "local-lvm:1,efitype=4m,pre-enrolled-keys=1" */
  efidisk0?: string;
  /** 虚拟 TPM，值形如 "local-lvm:4,version=v2.0" */
  tpmstate0?: string;
  /** 磁盘 / 网卡 / cloud-init 等动态字段 */
  [key: string]: string | number | boolean | undefined;
}

export interface VmCreateDisk {
  storage: string;
  size: number;
  interface: string;
  format?: string;
}

export interface VmCreateNetwork {
  bridge: string;
  model: string;
  vlan_tag?: number | null;
  firewall?: boolean;
  macaddr?: string;
}

/* ---- 高级硬件（NUMA 绑定 / EFI 盘 / 虚拟 TPM）----
   后端 PVE 的 numaN 是一节点一项；cpus 必填，memory 留空时由后端按节点数均分。 */

export interface NumaNodeSpec {
  /** 本节点分到的逻辑 CPU，cpuset 写法，如 "0-3,8-11" */
  cpus: string;
  /** 本节点内存（MB）。留空由后端均分总内存 */
  memory?: number | null;
  /** 绑定的宿主机 NUMA 节点，如 "0" / "0-1"。留空=只做客户机内部拓扑 */
  hostnodes?: string;
  /** 内存策略，仅在给了 hostnodes 时生效 */
  policy?: string;
}

/** EFI 变量盘（PVE efidisk0）。Windows 11 必需 */
export interface EfiDiskSpec {
  storage: string;
  /** 4m 才支持 pre-enrolled-keys（Win11 安全启动） */
  efitype?: string;
  pre_enrolled_keys?: boolean;
  /** 容量 MB，EFI 变量盘极小 */
  size?: number;
}

/** 虚拟 TPM（PVE tpmstate0）。Windows 11 必需 */
export interface TpmSpec {
  storage: string;
  version?: string;
  /** 容量 MB，PVE 最小 4 */
  size?: number;
}

export interface CloudInitConfig {
  enabled: boolean;
  user?: string;
  password?: string;
  ssh_keys?: string;
  ip_configs?: Array<{ ip: string; gateway: string }>;
  nameserver?: string;
  searchdomain?: string;
}

/* ---------------------------------------------------------------------------
   重置客户机内用户口令（虚拟机 / 容器共用）
   --------------------------------------------------------------------------- */

/** 重置通道。容器只有 ssh 一条，虚拟机有 agent / cloudinit 两条 */
export type GuestPasswordMethodId = 'agent' | 'cloudinit' | 'ssh';

/** 一条重置通道的可用性与说明（后端探测后回传，前端渲染成单选） */
export interface GuestPasswordMethod {
  id: GuestPasswordMethodId;
  label: string;
  description: string;
  available: boolean;
  /** 不可选的原因；available=false 时必定有值 */
  reason: string;
  /** 这条路会不会重启客户机 */
  restarts: boolean;
}

/** 「这台客户机现在能怎么改口令」的探测结果 */
export interface GuestPasswordMethods {
  kind: 'qemu' | 'lxc';
  node: string;
  vmid: number;
  running: boolean;
  methods: GuestPasswordMethod[];
  /** 后端推荐的方式；一条都不可用时为空串 */
  recommended: string;
  /** 默认用户名 */
  username: string;
  /** 容器走 ssh 时命中的受管主机（仅容器有） */
  ssh_host?: { name: string; host: string; username: string };
}

export interface GuestPasswordRequest {
  username: string;
  password: string;
  /** 留空 = 用后端推荐的方式（不重启的优先） */
  method?: GuestPasswordMethodId | '';
}

export interface GuestPasswordResult {
  ok: boolean;
  method: GuestPasswordMethodId;
  username: string;
  detail: string;
  /** 是否已经重启客户机（cloud-init 那条路会） */
  restarted: boolean;
  /** cloud-init 那条路带回的重启任务 UPID */
  task: string;
}

/* ---------------------------------------------------------------------------
   硬件增删（虚拟机详情 → 硬件）
   --------------------------------------------------------------------------- */

/** 新增一块磁盘。interface 留空时由后端挑第一个空闲的 scsi 槽位 */
export interface VmAddDiskRequest {
  storage: string;
  /** 容量，单位 GB */
  size: number;
  interface?: string;
  format?: string;
  discard?: boolean;
  ssd?: boolean;
}

/** 新增一张网卡，键名（netN）由后端挑空位 */
export interface VmAddNetworkRequest {
  bridge: string;
  model?: string;
  vlan_tag?: number | null;
  firewall?: boolean;
  macaddr?: string;
  rate?: number | null;
}

/** 新增硬件后后端回传的结果：实际落到了哪个键 */
export interface VmHardwareResult {
  task: string;
  key: string;
  value?: string;
}

/* ===========================================================================
   LXC 容器
   =========================================================================== */

/** 容器网卡（netN）。与虚拟机不同：IP 直接写在网卡行里，没有 cloud-init */
export interface LxcNetworkConfig {
  /** 键名，如 net0 */
  interface: string;
  /** 容器内的接口名，如 eth0 */
  name?: string;
  bridge?: string;
  /** dhcp | manual | 192.168.1.50/24 */
  ip?: string;
  gw?: string;
  ip6?: string;
  gw6?: string;
  tag?: string;
  firewall?: string;
  hwaddr?: string;
  rate?: string;
  mtu?: string;
  /** PVE 原始配置值，展示与排障用 */
  raw?: string;
}

/** 容器挂载点（mpN） */
export interface LxcMountConfig {
  interface?: string;
  storage?: string;
  volid?: string;
  size?: string;
  /** 容器内的挂载路径 */
  mp?: string;
  raw?: string;
}

/** rootfs（容器系统盘）。创建前是「存储:GiB」，创建后 PVE 换成 volid */
export interface LxcRootfsConfig {
  interface: string;
  storage: string;
  volid: string;
  size: string;
  raw?: string;
}

export interface LxcDetail {
  node: string;
  vmid: number;
  name: string;
  hostname?: string;
  type: 'lxc';
  status: VmStatus;
  template?: number | boolean;
  config: VmConfig;
  /** 系统盘 */
  rootfs: LxcRootfsConfig;
  /** 额外挂载点（mp0…mpN） */
  mounts: LxcMountConfig[];
  networks: LxcNetworkConfig[];
  /** 特权容器 = false；非特权（推荐、更安全）= true */
  unprivileged: boolean;
  features?: string;
  ostemplate?: string;
  tags?: string;
  description?: string;
  nameserver?: string;
  searchdomain?: string;
  /** 是否已注入 SSH 公钥（后端只回布尔值，不回明文） */
  ssh_keys_set?: boolean;

  /* 实时资源 */
  cpu?: number;
  cpus?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  /**
   * 与虚拟机相反：容器的 disk / maxdisk 是**真实**用量，可以直接算百分比，
   * 不需要像 QEMU 那样进客户机跑 df。
   */
  disk?: number;
  maxdisk?: number;
  swap?: number;
  maxswap?: number;
  uptime?: number;
  /** 创建时间；面板记录优先，容器普遍没有 PVE 的 `meta` 记录，通常为 null */
  created?: number | null;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
  lock?: string;
}

/** 节点上可用的容器模板（vztmpl） */
export interface LxcTemplateItem {
  volid: string;
  storage: string;
  name: string;
  size?: number;
  ctime?: number;
}

/** 创建容器时的网卡配置 */
export interface LxcCreateNetwork {
  bridge: string;
  /** 容器内接口名；留空后端按 eth0 / eth1 顺序分配 */
  name?: string;
  /** dhcp | manual | 192.168.1.50/24 */
  ip?: string;
  gateway?: string;
  /** dhcp | auto | <IPv6/CIDR>；留空不配 IPv6 */
  ip6?: string;
  gateway6?: string;
  vlan_tag?: number | null;
  firewall?: boolean;
  hwaddr?: string;
  rate?: number | null;
  mtu?: number | null;
}

/** 创建容器时的挂载点 */
export interface LxcCreateMount {
  storage: string;
  /** 容量，单位 GB */
  size: number;
  /** 容器内挂载路径，如 /data */
  mp: string;
  backup?: boolean;
  acl?: boolean;
}

/**
 * 容器初始化。**没有 cloud-init** —— 只能给 root 口令与 SSH 公钥，
 * 所以这里没有 user / ip_configs 那些字段。
 */
export interface LxcSetupConfig {
  password?: string;
  /** 多行粘贴的 SSH 公钥，写入容器内 /root/.ssh/authorized_keys */
  ssh_keys?: string;
  nameserver?: string;
  searchdomain?: string;
}

export interface LxcCreateRequest {
  node: string;
  vmid?: number;
  /** 主机名 / 名称 */
  name: string;
  /** 系统模板 volid，如 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst */
  ostemplate: string;
  /** rootfs 落在哪个存储 */
  storage: string;
  /** rootfs 容量，单位 GB */
  rootfs: number;
  memory: number;
  swap: number;
  cores: number;
  cpulimit?: number | null;
  cpuunits?: number | null;
  unprivileged?: boolean;
  /** nesting / keyctl / fuse / mknod / mount */
  features?: string[];
  ostype?: string;
  networks?: LxcCreateNetwork[];
  mounts?: LxcCreateMount[];
  setup?: LxcSetupConfig;
  start_on_boot?: boolean;
  protection?: boolean;
  tags?: string;
  description?: string;
  /** 创建完成后是否立即启动 */
  start?: boolean;
}

export interface LxcCreateResponse {
  task: string;
  vmid: number;
  node: string;
  type: 'lxc';
}

export interface LxcCloneRequest {
  newid: number;
  hostname?: string;
  target_storage?: string;
  target_node?: string;
  description?: string;
}

export interface LxcResizeRequest {
  /** rootfs 或 mpN */
  disk: string;
  /** 绝对值（20G）或增量（+10G） */
  size: string;
}

export interface LxcMoveRequest {
  /** rootfs 或 mpN */
  volume: string;
  storage: string;
  delete_source?: boolean;
}

export interface LxcMigrateRequest {
  target_node: string;
  online?: boolean;
  restart?: boolean;
}

/** 容器可改的配置项（其余 PVE 键走索引签名） */
export interface LxcConfigUpdate {
  hostname?: string;
  memory?: number;
  swap?: number;
  cores?: number;
  cpulimit?: number | null;
  cpuunits?: number | null;
  description?: string;
  tags?: string;
  onboot?: number;
  protection?: number;
  nameserver?: string;
  searchdomain?: string;
  [key: string]: string | number | boolean | null | undefined;
}

/* ---------------------------------------------------------------------------
   Guest 下发配额（全局容量上限，不是按用户分配）
   ---------------------------------------------------------------------------
   虚拟机与容器**各有一份额度**，互不占用：容器堆满不会吃掉虚拟机的额度。
   --------------------------------------------------------------------------- */

export interface VmQuotaInfo {
  /** vm = 虚拟机额度；lxc = 容器额度 */
  kind?: 'vm' | 'lxc';
  /** 该类 guest 的中文名（"虚拟机" / "容器"），直接用于文案 */
  label?: string;
  /** 总配额：最多能下发多少台。null = 不限制 */
  quota: number | null;
  /** 现有数量（跨所有 PVE 连接，含模板） */
  used: number;
  /** 还能下发几台；null = 不限制 */
  remaining: number | null;
  /** 是否启用了配额限制 */
  limited: boolean;
  /** 当前用户此刻能否创建（管理员不受配额限制，恒为 true） */
  can_create: boolean;
  /** 统计现有台数时的错误（例如某条 PVE 连不上）；null = 正常 */
  count_error: string | null;
}

/* ---------------------------------------------------------------------------
   虚拟机 / 容器的手动补充信息（面板侧，见后端 routers/vm_meta.py）
   --------------------------------------------------------------------------- */

/**
 * 一条手动 IP 记录。
 *
 * 只用于展示：面板不会把它写回 PVE 的 ipconfig / net0，
 * 它存在的意义是补齐「Guest Agent 没开、容器又用 DHCP」时看不到地址的场景。
 */
export interface VmMetaEntry {
  ip: string;
  /** 填写人；普通用户只拿得到自己填的条目 */
  by?: string;
  /** 填写时间（秒） */
  at?: number;
}

export interface VmMetaListResult {
  /** 键为 `<connection_id>|<node>|<vmid>`，与后端 _entry_key 一致 */
  items: Record<string, VmMetaEntry>;
}

/* ---------------------------------------------------------------------------
   客户机磁盘用量（Guest Agent）
   --------------------------------------------------------------------------- */

/** 客户机内一个文件系统的用量。后端经 Guest Agent 在客户机里执行 df 取回 */
export interface VmGuestFilesystem {
  /** 设备名，如 /dev/mapper/centos-root */
  filesystem: string;
  /** 挂载点，如 / 或 /boot */
  mountpoint: string;
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  /** 已用百分比（0-100，保留一位小数） */
  percent: number;
}

export interface VmDiskUsage {
  filesystems: VmGuestFilesystem[];
  /** 解析不出内容时后端回传的原始输出，用于排查少见的 df 实现 */
  raw?: string;
}

/* ---------------------------------------------------------------------------
   模板
   --------------------------------------------------------------------------- */

/** 集群中的一个模板 */
export interface TemplateItem {
  node: string;
  vmid: number;
  name: string;
  status: string;
  template: boolean;
  /**
   * 是虚拟机模板（qemu）还是容器模板（lxc）—— PVE 对两者都给 ``template=1``。
   * 前端据此决定克隆 / 删除走哪套接口：两者的参数与能力不同（容器没有链接克隆）。
   */
  guest_type?: 'qemu' | 'lxc';
  /** 客户机 OS 类型；后端当前未填充，保留以便与 VmSummary 对齐 */
  type?: string;
  maxcpu?: number;
  maxmem?: number;
  maxdisk?: number;
  disk?: number;
  tags?: string;
  uptime?: number;
  pool?: string;
  /** 所属 PVE 连接：多主机场景下节点名与 VMID 可能重复，必须靠它区分 */
  connection_id?: string;
  connection_name?: string;
}

/** 节点上的一个 cloud 镜像（.img / .qcow2 / .raw）*/
export interface CloudImageItem {
  volid: string;
  storage: string;
  name: string;
  size?: number;
  format?: string;
}

/** 任意可挂载的 ISO / 镜像卷 */
export interface IsoItem {
  volid: string;
  storage: string;
  name: string;
  size?: number;
  content: string;
  format?: string;
  is_cloud_image?: boolean;
}

/** 构建模板的流水线请求 */
export interface TemplateFromImageRequest {
  node: string;
  name: string;
  vmid?: number;
  /** cloud 镜像的 volid，如 local:iso/ubuntu-24.04-cloudimg.img */
  image: string;
  /** 系统盘落地的存储池 */
  storage: string;
  memory?: number;
  cores?: number;
  /** 内存气球的最低保留量（MB）：设了它，克隆出来的机器才有可回收的余量 */
  balloon?: number;
  cpu_type?: string;
  ostype?: string;
  /** 目标磁盘大小（GB），仅在大于镜像原始大小时生效 */
  disk_size?: number;
  bridge?: string;
  net_model?: string;
  scsihw?: string;
  bios?: string;
  machine?: string;
  ci_user?: string;
  ci_password?: string;
  ssh_keys?: string;
  nameserver?: string;
  tags?: string;
  description?: string;
  start_on_boot?: boolean;
}

/** 流水线每一步的执行结果 */
export interface TemplateBuildStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface TemplateBuildResult {
  vmid: number;
  node: string;
  name?: string;
  success: boolean;
  steps: TemplateBuildStep[];
  task?: string;
}

/** 从模板克隆一台新虚拟机 */
export interface TemplateCloneRequest {
  source_node: string;
  source_vmid: number;
  target_node?: string;
  newid?: number;
  name: string;
  full?: boolean;
  storage?: string;
  memory?: number;
  cores?: number;
  /** 内存气球的最低保留量（MB）：覆盖模板自带的值（模板不带就是「整份内存」） */
  balloon?: number;
  ci_user?: string;
  ci_password?: string;
  ssh_keys?: string;
  /** 形如 "ip=dhcp" 或 "ip=10.0.0.5/24,gw=10.0.0.1"，多网卡用 ; 分隔 */
  ip_config?: string;
  nameserver?: string;
  description?: string;
  start?: boolean;
}

export interface TemplateCloneResult {
  vmid: number;
  node: string;
  task: string;
  start_task?: string;
  name: string;
  success: boolean;
}

/* ---------------------------------------------------------------------------
   仪表盘
   --------------------------------------------------------------------------- */

export interface DashboardSummary {
  version: { pve?: string; release?: string; panel: string };
  vms: {
    total: number;
    running: number;
    stopped: number;
    templates: number;
    other: number;
  };
  containers: { total: number };
  nodes: {
    total: number;
    online: number;
    offline: number;
    cpu_total: number;
    cpu_used: number;
    cpu_usage: number;
    mem_total: number;
    mem_used: number;
    mem_usage: number;
    disk_total: number;
    disk_used: number;
    disk_usage: number;
    detail: NodeInfo[];
  };
  storage: {
    total: number;
    used: number;
    avail: number;
    usage: number;
    count: number;
  };
  recent_tasks: TaskInfo[];
}

export interface DashboardTopEntry {
  node: string;
  vmid: number;
  name: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  uptime?: number;
}

export interface DashboardTop {
  by_cpu: DashboardTopEntry[];
  by_memory: DashboardTopEntry[];
  total_running: number;
}

export interface CapacityForecastPoint {
  time: number;
  used: number;
}

/** 容量预测：基于节点磁盘历史做线性外推，估算满容时间 */
export interface CapacityForecast {
  /** 集群磁盘总容量（字节） */
  total_bytes: number;
  /** 历史已用量时间线（跨节点求和） */
  history: CapacityForecastPoint[];
  /** 当前已用字节 */
  current_used: number;
  /** 日均增长字节（可为负）；无增长或数据不足为 null */
  daily_rate_bytes: number | null;
  /** 预计满容天数；不会满 / 数据不足为 null */
  days_to_full: number | null;
  method: string;
}


export interface VmCreateRequest {
  node: string;
  vmid: number;
  name: string;
  memory: number;
  cores: number;
  sockets?: number;
  cpu_type?: string;
  ostype?: string;
  disks: VmCreateDisk[];
  networks: VmCreateNetwork[];
  iso?: string;
  scsi_hw?: string;
  bios?: string;
  machine?: string;
  boot_order?: string;
  start_on_boot?: boolean;
  /**
   * 内存气球的最低保留量（MiB）。不传时 PVE 按「整份内存」算，宿主机收不回
   * 客户机的空闲内存；0 = 显式关掉气球驱动，其它值 = 保留这么多。
   */
  balloon?: number;
  cloudinit?: CloudInitConfig;
  /**
   * 接入安全管控：把面板公钥追加进 cloud-init 的 `sshkeys`，创建成功后把这台
   * 机器登记成受管主机（凭据是面板统一密钥对，首次连接自动信任指纹）。
   * 只在「全新创建 + cloud-init + 静态 IP」下有意义 —— DHCP 时后端直接拒绝。
   */
  manage?: boolean;
  clone_from?: {
    vmid: number;
    node: string;
    full: boolean;
    target_storage?: string;
    /** 克隆完成后是否自动开机（默认 true） */
    start?: boolean;
  };
  tags?: string;
  description?: string;
  /* ---- 高级硬件（都可选）---- */
  /** 开启 NUMA：只开这个 = 给客户机呈现 NUMA 拓扑，不绑定宿主机节点 */
  numa?: boolean;
  /** 逐节点的绑定；给了就必然开 NUMA */
  numa_nodes?: NumaNodeSpec[];
  /** 整机 CPU 亲和性 cpuset，如 "0-7" */
  affinity?: string;
  /** EFI 变量盘；与 tpm 同为 Windows 11 必需 */
  efi_disk?: EfiDiskSpec;
  /** 虚拟 TPM */
  tpm?: TpmSpec;
  /** 从镜像生成模板标记（后端走 importdisk 流水线） */
  templateMode?: boolean;
  /** 源镜像 volid（模板模式 A 使用） */
  source_image?: string;
  target_storage?: string;
}

export interface VmCreateResponse {
  task: string;
  vmid: number;
}

export interface VmCloneRequest {
  newid: number;
  name?: string;
  full?: boolean;
  target_storage?: string;
  target_node?: string;
  description?: string;
}

export interface VmResizeRequest {
  disk: string;
  size: string;
}

export interface VmMoveRequest {
  disk: string;
  storage: string;
  delete_source?: boolean;
}

export interface VmMigrateRequest {
  target_node: string;
  online?: boolean;
}

/* ---------------------------------------------------------------------------
   快照
   --------------------------------------------------------------------------- */

export interface Snapshot {
  name: string;
  description?: string;
  snaptime?: number;
  parent?: string;
  vmstate?: number | boolean;
  /** 创建者（用户隔离：普通用户只看得到自己创建的，admin 看全部） */
  owner?: string | null;
  /** 前端补充：所属 VM（全局快照视图用） */
  vmid?: number;
  node?: string;
  vmname?: string;
  /** qemu | lxc —— 全局快照视图里据此跳到虚拟机页还是容器页 */
  vm_type?: string;
}

export interface SnapshotCreateRequest {
  name: string;
  description?: string;
  vmstate?: boolean;
}

/* ---------------------------------------------------------------------------
   备份
   --------------------------------------------------------------------------- */

export interface BackupItem {
  volid: string;
  ctime: number;
  size: number;
  format: string;
  vmid: number;
  notes?: string;
  node?: string;
  storage?: string;
  name?: string;
  /** 创建者（用户隔离，见后端 notes 里的归属标记） */
  owner?: string | null;
  /** PBS 校验状态 */
  verification?: unknown;
}

export type BackupMode = 'snapshot' | 'suspend' | 'stop';

export interface BackupCreateRequest {
  node: string;
  vmid?: number;
  storage: string;
  mode: BackupMode;
  compress: string;
  notes?: string;
  all?: boolean;
}

export interface BackupRestoreRequest {
  node: string;
  storage: string;
  volid: string;
  vmid: number;
  force?: boolean;
  start?: boolean;
}

export interface BackupJob {
  job_id: string | number;
  schedule: string;
  storage: string;
  mode: BackupMode;
  compress: string;
  vmid?: string;
  node?: string;
  enabled: boolean;
  notes?: string;
  comment?: string;
  /** 保留策略 */
  prune_backups?: string;
  keep_daily?: number;
  keep_weekly?: number;
  keep_monthly?: number;
  next_run?: number;
  last_run?: number;
  /** 创建者（用户隔离，见后端 comment 里的归属标记） */
  owner?: string | null;
}

export interface BackupJobInput {
  schedule: string;
  storage: string;
  mode: BackupMode;
  compress: string;
  vmid?: string;
  node?: string;
  enabled: boolean;
  notes?: string;
  prune_backups?: string;
}

/* ---------------------------------------------------------------------------
   任务
   --------------------------------------------------------------------------- */

export type TaskStatus = 'running' | 'stopped' | 'unknown' | string;

export interface TaskInfo {
  upid: string;
  node: string;
  type: string;
  status: TaskStatus;
  exitstatus?: string;
  starttime?: number;
  endtime?: number;
  user?: string;
  id?: string;
  /** WebSocket 推送的字段 */
  progress?: number;
}

export interface TaskLogLine {
  n: number;
  t: string;
}

export interface TaskDetail extends TaskInfo {
  log: TaskLogLine[];
}

/* ---------------------------------------------------------------------------
   WS 消息
   --------------------------------------------------------------------------- */

export interface TaskWsMessage {
  upid: string;
  node: string;
  status: TaskStatus;
  progress?: number;
  log?: string;
  exitstatus?: string;
}

/* ---------------------------------------------------------------------------
   审计
   --------------------------------------------------------------------------- */

export interface AuditEntry {
  id: number;
  timestamp: string;
  username: string;
  action: string;
  target: string;
  result: string;
  detail?: string;
  ip?: string;
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  username?: string;
  action?: string;
  result?: string;
  start?: string;
  end?: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
}

/* ---------------------------------------------------------------------------
   控制台
   --------------------------------------------------------------------------- */

export interface VncProxyResponse {
  ticket: string;
  port: number;
  cert?: string;
  password: string;
  node: string;
  vmid: number;
}



/* ---------------------------------------------------------------------------
   面板设置
   --------------------------------------------------------------------------- */

export interface PanelSettings {
  refreshInterval: number;
  pageSize: number;
  timezone: string;
}

/* ---------------------------------------------------------------------------
   前端 UI 辅助类型
   --------------------------------------------------------------------------- */

/**
 * 通知语义。
 *
 * `destructive` 是「破坏性操作成功」：删除、隔离这类不可撤销的动作，成功也
 * 需要用户注意到（默认绿勾会被当成「一切照旧」划过去），所以单独给它一档
 * 更强的视觉权重，而不是复用 error —— 它并不是失败。
 */
export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'destructive';

export interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  /** 持久 toast（loading 用） */
  persistent?: boolean;
  loading?: boolean;
}

export type BadgeVariant =
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'neutral'
  | 'accent';

/* ---- 内网穿透（frp 客户端） ----
   服务端 + 规则两个独立维度：
   - server_addr / server_port / token 由 admin 集中管理；
   - 规则按用户归属：每条 rule 带 username，普通用户只能增删改自己的。
   frpc 实际渲染时是两者合并后的结果（见 ``FrpEffective``）。 */

export interface FrpServer {
  server_addr: string;
  server_port: number;
  /** 服务端 token 是否已设置（前端永远拿不到明文） */
  token_set: boolean;
}

export interface FrpRule {
  id: string;
  username: string;
  name: string;
  type: string;
  local_ip: string;
  local_port: number;
  remote_port: number;
}

export interface FrpRuleInput {
  name: string;
  type?: string;
  local_ip?: string;
  local_port: number;
  remote_port: number;
}

/** 列出规则接口返回（含可见性信息，让普通用户能区分「自己的」与「别人的」） */
export interface FrpRuleList {
  rules: FrpRule[];
  /** 当前登录用户的用户名 */
  own_username: string;
  /** 当前用户是否能看/改所有人的规则 */
  is_admin: boolean;
}

export interface FrpEffectiveConfig {
  server_addr: string;
  server_port: number;
  /** token 始终为空字符串 —— 不回显明文 */
  token: string;
  proxies: FrpRule[];
}

export interface FrpEffective {
  config: FrpEffectiveConfig;
  token_set: boolean;
  rule_count: number;
}

export interface FrpStatus {
  running: boolean;
  available: boolean;
  binary: string;
  server_addr: string;
  server_port: number;
  proxy_count: number;
  /**
   * 「frpc 停了自动拉起」是否开启。开启时面板的看护作业会把它重新拉起来，
   * 面板重启后也会按这个开关恢复。手动点「停止穿透」会把它一起关掉
   * （否则点了停止却被看护立刻拉回来）。
   */
  auto_restart?: boolean;
}

/* 以下保留向后兼容 —— 旧前端 / 老 API 兼容字段。 */
export interface FrpProxy {
  name: string;
  type: string;
  local_ip: string;
  local_port: number;
  remote_port: number;
}

export interface FrpConfig {
  server_addr: string;
  server_port: number;
  token: string;
  proxies: FrpProxy[];
}

export interface AlertRule {
  id: string;
  name: string;
  target_type: string;
  target: string;
  metric: string;
  threshold: number;
  enabled: boolean;
  /** 归属用户：规则按用户隔离，管理员可以看到并区分多个用户的规则 */
  username?: string;
}

export interface AlertRecord {
  id: number;
  rule_name: string;
  target_type: string;
  target: string;
  metric: string;
  value: number;
  threshold: number;
  result: string;
  detail: string;
  /** alarm = 触发告警，recovery = 恢复正常 */
  kind?: 'alarm' | 'recovery';
  /** 归属用户：普通用户只看得到自己的，管理员可以看到全部 */
  username?: string;
  ts: number;
}

/**
 * 当前处于告警状态、尚未恢复的对象。
 *
 * 与 AlertRecord（历史记录）的区别：历史是「发生过什么」，含早就恢复的；
 * 这里是「此刻还有几件事没解决」，首页工作台的待办数量以它为准。
 * 已停推（静默）的来源不会出现在这里。
 */
export interface AlertActiveItem {
  alarm_key: string;
  username?: string;
  rule_id?: string;
  rule_name?: string;
  target_type?: string;
  target?: string;
  metric?: string;
  value?: number;
  threshold?: number;
  node?: string;
  ip?: string;
  vmid?: string | number | null;
  ts?: number;
  /** 写这条状态的来源（NOTIFY_SOURCE_IDS 之一），后端过滤静默来源时用 */
  notify_source?: string;
}

/** 告警概览（含可见性信息，用于区分「自己的」与「别人的」） */
export interface AlertsOverview {
  feishu: Record<string, any>;
  webhook_set: boolean;
  webhook_masked: string;
  secret_set: boolean;
  /** 通用 Webhook 通道；字段名刻意与飞书那组区分（两个通道各自独立） */
  hook: AlertWebhookConfig;
  hook_set: boolean;
  hook_masked: string;
  hook_secret_set: boolean;
  /** 一键填充用的请求体预设（key → 预设） */
  hook_presets: Record<string, AlertWebhookPreset>;
  /** 模板里可用的占位符名 */
  hook_placeholders: string[];
  /** 当前用户自己的告警邮件收件人配置 */
  email: AlertEmailConfig;
  /** 全局 SMTP 是否已配好；没配好时邮件通道发不出去 */
  mail_ready: boolean;
  /** 账号邮箱，收件人留空时用它 */
  account_email: string;
  rules: AlertRule[];
  history: AlertRecord[];
  /** 尚未恢复的告警（待办数量看这个，不是 history 的条数） */
  active: AlertActiveItem[];
  metrics: Record<string, string>;
  /** 可开关的告警来源清单（后端注册表，前端照着渲染开关） */
  notify_sources: AlertNotifySource[];
  /** 各来源当前是否允许推送 */
  notify_enabled: Record<string, boolean>;
  /** 当前登录用户名 */
  own_username: string;
  /** 是否管理员：管理员可见全部用户的规则与历史 */
  is_admin: boolean;
}

/** 一个可开关的告警来源（资源规则 / 端口 / SSH / 远程主机 / 备份） */
export interface AlertNotifySource {
  id: string;
  label: string;
  description: string;
}

/* ---- 网站证书（腾讯云免费证书） ---- */

export interface TencentCertConfig {
  secret_id: string;
  secret_key: string;
  /** DNS_AUTO / DNS / FILE */
  dv_auth_method: string;
  /** RSA / ECC */
  encrypt_algo: string;
  /** 全局默认：到期前多少天开始续期 */
  renew_before_days: number;
}

export interface CertSite {
  id: string;
  name: string;
  /** 归属用户：站点按用户隔离，管理员可以看到并区分多个用户的站点 */
  username?: string;
  domain: string;
  cert_id: string;
  /** 已提交申请、等待 CA 签发的证书 ID */
  pending_cert_id: string;
  /** local = 面板本机；ssh = 远程服务器；agent = PVE 虚拟机 Guest Agent */
  deploy_method: 'local' | 'ssh' | 'agent';
  deploy_dir: string;
  cert_filename: string;
  key_filename: string;
  reload_command: string;
  /* ---- SSH 远程部署 ---- */
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  /** password / key */
  ssh_auth: string;
  ssh_password: string;
  ssh_key: string;
  /** 首次连接后记录的主机指纹 */
  ssh_host_key: string;
  /* ---- PVE 虚拟机 Guest Agent 部署 ---- */
  agent_node: string;
  agent_vmid: string;
  auto_renew: boolean;
  /** 0 表示跟随全局设置 */
  renew_before_days: number;
  enabled: boolean;
  notes: string;
  cert_status: number;
  cert_status_text: string;
  cert_domain: string;
  expire_at: number;
  last_deploy_at: number;
  last_check_at: number;
  last_error: string;
  /* 后端计算字段 */
  days_left?: number | null;
  renew_before_days_effective?: number;
  needs_renew?: boolean;
  ssh_password_set?: boolean;
  ssh_key_set?: boolean;
}

export interface CertDeployLog {
  id: number;
  /** 归属用户：普通用户只看得到自己的部署日志 */
  username?: string;
  site_id: string;
  site_name: string;
  domain: string;
  /** apply / renew / deploy / bind / sync */
  action: string;
  result: string;
  detail: string;
  ts: number;
}

export interface RemoteCertificate {
  cert_id: string;
  domain: string;
  alias: string;
  status: number;
  status_text: string;
  expire_at: number;
  encrypt_algo: string;
  wildcard: boolean;
  is_dv: boolean;
  source: string;
}

export interface CertOptions {
  dv_auth_methods: { value: string; label: string }[];
  encrypt_algos: { value: string; label: string }[];
  deploy_methods: { value: string; label: string }[];
}

/* ---- 飞书机器人（指令控制） ---- */

export interface BotConfig {
  enabled: boolean;
  app_id: string;
  app_secret: string;
  verification_token: string;
  encrypt_key: string;
  allowed_chat_ids: string[];
  allowed_user_ids: string[];
  allow_write: boolean;
  allow_create: boolean;
  default_template_vmid: string;
  default_node: string;
  default_storage: string;
  default_backup_storage: string;
  max_vms: number;
  app_secret_set?: boolean;
  verification_token_set?: boolean;
  encrypt_key_set?: boolean;
}

export interface BotCommand {
  cmd: string;
  desc: string;
}

/* ---------------------------------------------------------------------------
   防火墙（PVE 原生）
   --------------------------------------------------------------------------- */

/** 一条防火墙规则。字段名与 PVE 保持一致，便于对照官方文档排查。 */
export interface FirewallRule {
  /** 位置：PVE 按 pos 从小到大匹配，越靠前优先级越高 */
  pos: number;
  /** in（入站）/ out（出站）/ group（引用安全组） */
  type: 'in' | 'out' | 'group' | string;
  action: 'ACCEPT' | 'DROP' | 'REJECT' | string;
  enable: boolean;
  /** tcp / udp / icmp … 空 = 任意 */
  proto: string;
  /** 目标端口：22 / 80,443 / 8000:8100 */
  dport: string;
  sport: string;
  /** 源地址：IP、CIDR，或 +集合名 */
  source: string;
  dest: string;
  /** PVE 内置宏，如 SSH、HTTP */
  macro: string;
  iface: string;
  /** nolog / info / debug … */
  log: string;
  comment: string;
  /** type=group 时引用的安全组名 */
  group: string;
  digest?: string;
}

/** 规则编辑器的入参：pos 留空表示追加到末尾 */
export type FirewallRuleInput = Omit<FirewallRule, 'pos' | 'digest'> & {
  pos?: number | null;
};

export interface FirewallOptions {
  enable?: boolean;
  policy_in?: string;
  policy_out?: string;
  log_level_in?: string;
  log_level_out?: string;
  ebtables?: boolean;
  dhcp?: boolean;
  ipfilter?: boolean;
  macfilter?: boolean;
  ndp?: boolean;
  radv?: boolean;
}

export type FirewallScope = 'cluster' | 'node' | 'vm';

export interface FirewallRefs {
  macros: string[];
  aliases: string[];
  ipsets: string[];
  groups: string[];
}

export interface FirewallGroup {
  group: string;
  comment: string;
  digest?: string;
}

export interface FirewallIpsetEntry {
  cidr: string;
  comment: string;
  nomatch: boolean;
}

export interface FirewallIpset {
  name: string;
  comment: string;
  digest?: string;
  entries: FirewallIpsetEntry[];
}

/** 规则模板：面板侧保存，可批量下发到多台虚拟机 */
export interface FirewallTemplate {
  id: string;
  name: string;
  description: string;
  /** 下发时是否同时打开目标机的防火墙开关 */
  enable: boolean;
  policy_in: string;
  policy_out: string;
  rules: FirewallRuleInput[];
  updated?: number;
  updated_by?: string;
}

export interface FirewallApplyResultItem {
  node: string;
  vmid: number;
  ok: boolean;
  removed: number;
  added: number;
  /** 例如「网卡未开防火墙」的提醒 */
  warning: string;
  error: string;
}

export interface FirewallApplyResult {
  applied: number;
  failed: number;
  results: FirewallApplyResultItem[];
}

/* ---------------------------------------------------------------------------
   SSH 登录安全（读面板所在主机的日志 + fail2ban）
   --------------------------------------------------------------------------- */

export interface SshLogSource {
  kind: 'file' | 'journalctl' | 'none' | string;
  path: string;
  label: string;
  available: boolean;
  /** 数据来自哪台主机（面板只能读自己所在主机） */
  host?: string;
  detail: string;
}

export interface SshFailureRow {
  ip: string;
  count: number;
  users: string[];
  first_ts: number;
  last_ts: number;
}

export interface SshLoginRow {
  id?: number;
  ts: number;
  username: string;
  ip: string;
  method: string;
  /** 1 = 当时是第一次见到的地址 */
  new_ip: number | boolean;
}

export interface SshSummary {
  failures: number;
  distinct_ips: number;
  distinct_users: number;
  logins: number;
}

export interface SshReport {
  source: SshLogSource;
  since: number;
  generated_at: number;
  summary: SshSummary;
  top_ips: SshFailureRow[];
  top_users: Array<{ user: string; count: number }>;
  logins: SshLoginRow[];
  scanned_lines?: number;
}

export interface SshPolicy {
  enabled: boolean;
  window_hours: number;
  max_failures: number;
  alert_unknown_ip: boolean;
  cooldown_minutes: number;
  notify_user: string;
  jail: string;
  ignore_ips: string;
}

export interface Fail2banJail {
  jail: string;
  filter: string;
  /** 面板托管的 jail 片段路径（存在说明是本面板写的） */
  managed_config?: string;
  currently_failed: number;
  total_failed: number;
  currently_banned: number;
  total_banned: number;
  banned_ips: string[];
  log_files: string[];
}

export interface Fail2banStatus {
  installed: boolean;
  running: boolean;
  jails: string[];
  details: Fail2banJail[];
  preferred: string;
  /** 面板所在主机名 */
  host?: string;
  /** 找到的 fail2ban-client 绝对路径（没装则为空） */
  binary?: string;
  /** 没找到时，面板实际查过哪些路径 */
  checked?: string[];
  hint: string;
}

export interface SshOverview {
  policy: SshPolicy;
  report: SshReport;
  fail2ban: Fail2banStatus;
  known_ips: number;
  window_hours: number;
  notify_user: string;
}

export interface SshKnownIp {
  ip: string;
  first_seen: number;
  last_seen: number;
  hits: number;
  note: string;
}

export interface SshCheckResult {
  fired: Array<Record<string, unknown>>;
  count: number;
}

/* ---------------------------------------------------------------------------
   多机 SSH 安全（受管主机）
   --------------------------------------------------------------------------- */

/**
 * 面板本机的管控状态（`GET /api/ssh/local`）。
 *
 * 「SSH 安全 / 安全基线 / 端口与进程 / 登录审计」四个功能都能管面板自己所在
 * 那台服务器，但它**默认不管控** —— 读宿主机日志与 /proc、改 sshd 与 fail2ban
 * 都需要相当高的权限，要由管理员在「受管主机」里显式导入。
 */
export interface LocalHostState {
  id: string;
  /** 展示名，形如 `pve01（面板本机）` */
  name: string;
  hostname: string;
  /** 是否已导入；false 时这四个功能里不会出现本机 */
  enabled: boolean;
  /** 导入者用户名，未导入时为空 */
  by: string;
  /** 导入时间（epoch 秒），未导入时为 0 */
  at: number;
  /**
   * 面板是否跑在容器里（后端自检，见 `app/localhost.in_container`）。
   * 容器里「本机管控」读到的是容器自身的数据而非宿主机的，所以前端据此
   * **不再提示导入本机** —— 不把一个用不起来的开关摆在用不了的场景里。
   */
  container: boolean;
}

/**
 * 面板 SSH 公钥的状态（`GET /api/ssh/panel-key`）。
 *
 * 面板下发虚拟机时把公钥写进 cloud-init，之后自己 SSH 进去做安全采集（见
 * `app/panelkey.py`）。私钥加密落库、**永不回传前端**，所以这里只有公钥。
 */
export interface PanelKeyState {
  /** 是否已生成。false = 从没用过「接入安全管控」，没有多余的密钥存在 */
  present: boolean;
  /** 公钥单行，形如 `ssh-ed25519 AAAAC3...`；未生成时为空 */
  public: string;
  /** 生成时间（epoch 秒），未生成时为 0 */
  created: number;
  /** 生成者用户名 */
  by: string;
  /** 靠这把钥匙接入的受管主机数 */
  in_use: number;
  /** 受管主机总数（只有 state 接口返回，rotate 的返回值没有） */
  host_total?: number;
}

export interface SshHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** key = 私钥；password = 口令 */
  auth_type: 'key' | 'password' | string;
  use_sudo: boolean;
  /** auto | journalctl | secure | auth.log */
  log_source: string;
  enabled: boolean;
  /**
   * 主机来源：`manual` = 用户手工添加；`panel` = 面板下发虚拟机时自动登记
   * （凭据是面板统一密钥对，首次连接自动信任指纹）。
   */
  origin: 'manual' | 'panel' | string;
  /** 已确认的 SSH 主机指纹；为空表示首次连接还没信任 */
  known_host: string;
  /** 凭据是否设置（私钥 / 口令永不回传前端） */
  secret_set: boolean;
  /**
   * 归属用户名：这台主机归谁。空串 = 没有归属记录（存量主机），
   * 此时普通用户看不到它，只有管理员能管（并可指派归属）。
   */
  owner?: string;
  updated?: number;
  updated_by?: string;
}

export interface SshHostTestResult {
  ok: boolean;
  detail: string;
  fingerprint?: string;
  hostname?: string;
  user?: string;
  fail2ban?: string;
  journal?: string;
  secure?: string;
  authlog?: string;
  /**
   * 本次连接看到的指纹与库里记录的不一致。
   * 可能是中间人，也可能是主机重装过 —— 排查无误后可以「重新信任」。
   */
  mismatch?: boolean;
  /** 库里记录的指纹（mismatch 时给出，供用户比对） */
  expected?: string;
  /** 本次连接看到的实际指纹 */
  actual?: string;
}

/* ---------------------------------------------------- 虚拟机导入 / 导出 */
/** 已上传到 PVE 的 import 内容的文件（导入源） */
export interface ImportSource {
  volid: string;
  /** 相对卷名（import/xx.ova）—— 接口要的就是它，不带存储前缀 */
  volume: string;
  storage: string;
  name: string;
  format: string;
  size?: number | null;
}

/** 可以承载导入文件的存储（支持 import 内容类型） */
export interface ImportStorage {
  storage: string;
  type: string;
  active: boolean;
  avail?: number | null;
  content?: string | null;
  /**
   * 目录型存储在宿主机上的路径（拿不到时是空串）。散开的 OVF 传不上去，
   * 只能由用户 scp 到 `<path>/import/`，所以界面上要把这个路径指出来。
   */
  path?: string;
}

/** PVE 对 OVF/OVA 的告警（缺 SCSI 控制器、OVA 需要解包空间等） */
export interface ImportWarning {
  type: string;
  key?: string;
  value?: string;
}

export interface ImportMetadata {
  source: string;
  type: string;
  /** 可直接用于建机的参数（内存 / 核数 / 名称 / 网卡…） */
  create_args: Record<string, unknown>;
  /**
   * 磁盘位 → 源卷。PVE 9.2 给的是 `{ scsi0: { size, volid } }`，
   * 早期文档写的是字符串形式，两种都做兼容。
   */
  disks: Record<string, string | { size?: number; volid?: string }>;
  net: Record<string, unknown>;
  warnings: ImportWarning[];
  /**
   * 裸磁盘镜像（VMDK / QCOW2 / RAW…）：里面只有盘上的数据，没有 OVF 那种描述
   * 机器配置的 XML，所以 PVE 解析不了，由面板合成一份等价描述。
   * 这种情况下 create_args 是空的，内存 / CPU 核数需要人来填。
   */
  bare?: boolean;
}

/** 一次导出作业 */
export interface ExportJob {
  id: string;
  node: string;
  vmid: number;
  name: string;
  format: string;
  storage: string;
  status: 'running' | 'done' | 'failed' | string;
  /** preparing / converting / packing / done / failed */
  stage: string;
  progress: number;
  detail: string;
  files: Array<{ name: string; size: number }>;
  created: number;
  finished: number;
  /**
   * 面板重启前留下的产物：磁盘上还在，但已经查不到它属于哪台机器。
   * 列表里照样给下载与删除 —— 用户要的正是「把它清掉」。
   */
  orphan?: boolean;
}

/* -------------------------------------------------- 虚拟机重装系统 */
/** 可作为重装来源的模板 */
export interface ReinstallTemplate {
  node: string;
  vmid: number;
  name: string;
  ostype: string;
  /** 模板的系统盘卷 ID */
  disk: string;
  size: number;
  used: number;
  /** 模板是否带 cloud-init 配置 */
  cloudinit: boolean;
}

/**
 * 这台虚拟机**当前**在用的网络配置（重装向导的默认值来源）。
 * 后端从 PVE 的 `ipconfigN` 读回来，所以机器关着也有值。
 */
export interface ReinstallNetwork {
  /** static = 配置里写死了地址；dhcp = 原配置就是 DHCP；'' = 没配过 cloud-init 网络 */
  mode: 'static' | 'dhcp' | '';
  /** 带掩码，与 PVE 里的写法一致（如 10.0.0.10/24） */
  ip: string;
  gateway: string;
  dns: string;
}

export interface ReinstallStep {
  step: string;
  ok: boolean;
  detail?: string;
}

/**
 * 一次重装的作业记录（后端后台任务）。
 * 提交后立即返回，进度与结果都靠轮询 `GET /vms/reinstall-jobs` 拿。
 */
export interface ReinstallJob {
  id: string;
  /** 提交人（普通用户只能看到自己的作业） */
  owner: string;
  connection: string;
  node: string;
  vmid: number;
  /** 原来的虚拟机名（重装后改叫什么另说） */
  name: string;
  /** 模板，形如 node/vmid */
  template: string;
  storage: string;
  status: 'running' | 'success' | 'failed';
  /** 正在做的一步（running 时有值） */
  stage: string;
  /** 失败原因；成功时是新系统盘卷名 */
  detail: string;
  steps: ReinstallStep[];
  old_volume: string;
  new_volume: string;
  /** Unix 秒 */
  created: number;
  finished: number;
}

export interface VmReinstallBody {
  template_node: string;
  template_vmid: number;
  target_storage: string;
  hostname?: string;
  ci_user?: string;
  ci_password?: string;
  ssh_keys?: string;
  ip_mode?: string;
  ip?: string;
  gateway?: string;
  dns?: string;
  start?: boolean;
  /** 连数据盘一起删（默认 true：重装 = 回到干净状态） */
  wipe_data_disks?: boolean;
}

export interface FleetHost {
  id: string;
  name: string;
  host: string;
  ok: boolean;
  error: string;
  source: SshLogSource;
  summary: SshSummary;
  top_ips: SshFailureRow[];
  fail2ban: Fail2banStatus;
}

export interface FleetOverview {
  hosts: FleetHost[];
  totals: {
    hosts: number;
    reachable: number;
    failures: number;
    distinct_ips: number;
    logins: number;
    banned: number;
  };
  generated_at: number;
}

/* ---------------------------------------------------------------------------
   主机登录审计（last / lastb / sudo）
   --------------------------------------------------------------------------- */

export interface HostAuditHost {
  id: string;
  name: string;
  host: string;
  /** 是否面板本机 */
  local: boolean;
}

export interface HostLoginEntry {
  /** login / failed / reboot */
  kind: string;
  user: string;
  tty: string;
  ip: string;
  start?: number | null;
  end?: number | null;
  duration?: string;
  state?: string;
  kernel?: string;
  success?: boolean;
  /** 虚拟机视角下补上的所属主机 */
  host?: string;
  host_id?: string;
}

export interface HostSudoEntry {
  /** sudo / su */
  kind: string;
  success: boolean;
  ts?: number | null;
  user: string;
  target: string;
  tty: string;
  command: string;
}

export interface HostAuditCursor {
  host_id: string;
  name: string;
  last_ts: number;
  updated: number;
}

export interface HostLoginsResult {
  host_id: string;
  name: string;
  ok: boolean;
  error: string;
  kind: string;
  entries: HostLoginEntry[];
  generated_at?: number;
}

export interface HostSudoResult {
  host_id: string;
  name: string;
  ok: boolean;
  error: string;
  entries: HostSudoEntry[];
  generated_at?: number;
}

export interface VmAuditResult {
  node: string;
  vmid: number;
  ip: string;
  hours: number;
  entries: HostLoginEntry[];
  note: string;
}

/* ---------------------------------------------------------------------------
   安全基线（全平台服务器的体检与加固：本机 + SSH 受管主机）
   --------------------------------------------------------------------------- */

/** pass 通过 / warn 待改进 / fail 不合格 / unknown 无法检测 */
export type BaselineStatus = 'pass' | 'warn' | 'fail' | 'unknown';
export type BaselineSeverity = 'high' | 'medium' | 'low';

/** 加固权限来源：本机 root / 受管主机的 sudo / 都没有 */
export type BaselinePrivilege = 'root' | 'sudo' | 'none';

/** 可体检的一台服务器 */
export interface BaselineHost {
  /** local 或受管主机 id */
  id: string;
  /** 展示名（本机为主机名，远程为备注名） */
  name: string;
  /** 实际主机名（体检后才知道，选择器阶段用不到） */
  host: string;
  /** 连接地址（本机为 localhost） */
  address: string;
  local: boolean;
  enabled: boolean;
}

export interface BaselineCheck {
  key: string;
  /** ssh / password / firewall / ntp / accounts / kernel */
  category: string;
  label: string;
  status: BaselineStatus;
  severity: BaselineSeverity;
  /** 观测到的实际值 */
  value: string;
  /** 期望值 */
  expected: string;
  detail: string;
  /** 加固建议 */
  hint: string;
  /** 是否支持一键修复 */
  fixable: boolean;
  /** 是否纳入「一键加固」批量执行（false = 只能单独点名修复） */
  auto: boolean;
}

export interface BaselineCategory {
  key: string;
  label: string;
  score: number;
  checks: BaselineCheck[];
}

export interface BaselineSummary {
  total: number;
  pass: number;
  warn: number;
  fail: number;
  unknown: number;
  /** 当前可一键修复的失败 / 待改进项数 */
  fixable: number;
  /** 其中可纳入「一键加固」批量的项数 */
  auto_fixable: number;
}

export interface BaselineOsInfo {
  system?: string;
  distribution?: string;
  kernel?: string;
  hostname?: string;
}

/** 单台服务器的完整体检报告（本机与远程同构） */
export interface BaselineReport {
  /** local 或受管主机 id */
  host_id: string;
  local: boolean;
  /** 展示名 */
  name: string;
  /** 实际主机名 */
  host: string;
  /** 连接地址 */
  address: string;
  checked_at: number;
  /** 是否体检成功（远程不可达时为 false，其余字段为占位） */
  ok: boolean;
  error: string;
  /** 是否具备加固权限 */
  elevated: boolean;
  privilege: BaselinePrivilege;
  os: BaselineOsInfo;
  score: number;
  /** A / B / C / D（未体检为空串） */
  grade: string;
  grade_label: string;
  summary: BaselineSummary;
  categories: BaselineCategory[];
  checks: BaselineCheck[];
}

/** 总览里的一条问题摘要 */
export interface BaselineIssue {
  key: string;
  label: string;
  severity: BaselineSeverity;
  status: BaselineStatus;
  category: string;
}

/** 总览里的一台服务器（不带全部检查项） */
export interface BaselineHostSummary {
  host_id: string;
  name: string;
  host: string;
  local: boolean;
  ok: boolean;
  error: string;
  elevated: boolean;
  privilege: BaselinePrivilege;
  score: number;
  grade: string;
  grade_label: string;
  summary: BaselineSummary;
  os: BaselineOsInfo;
  /** 最需要处理的几项（高危优先，最多 4 条） */
  issues: BaselineIssue[];
}

export interface BaselineFleetTotals {
  hosts: number;
  reachable: number;
  unreachable: number;
  fail: number;
  warn: number;
  fixable: number;
  avg_score: number;
  worst_score: number;
  healthy: number;
}

export interface BaselineFleetReport {
  /** 已按「最需要处理」排序 */
  hosts: BaselineHostSummary[];
  totals: BaselineFleetTotals;
  generated_at: number;
}

export interface BaselineFixResult {
  key: string;
  host_id?: string;
  ok: boolean;
  detail: string;
  path?: string;
  error?: string;
}

export interface BaselineFixAllResult {
  host_id?: string;
  applied: BaselineFixResult[];
  fixed: number;
  failed: number;
}

/* ---------------------------------------------------------------------------
   端口 / 进程异常检测（全平台服务器）
   --------------------------------------------------------------------------- */

export type PortSeverity = 'high' | 'medium' | 'low';
/** loopback 仅本机可访问 / all 监听全部网卡 / specific 监听某个地址 */
export type PortScope = 'loopback' | 'all' | 'specific';

export interface PortListener {
  proto: string;
  state: string;
  address: string;
  port: number;
  scope: PortScope;
  /** 归属进程名（需要 root 才能看到别人的进程） */
  process: string;
  pid?: number | null;
  /** 是否监听在非回环地址 */
  exposed: boolean;
  /** 是否属于常见的「不该对公网开放」的服务端口 */
  sensitive: boolean;
  /** 是否在策略的预期端口清单里 */
  expected: boolean;
  /** 人工处置：确认 / 忽略 / 加白。有值即不再计入「非预期」，但仍列出、可撤销 */
  disposition?: PortDisposition | null;
  /** 处置指纹：调「确认 / 忽略 / 加白」时用 */
  fingerprint?: string;
}

/**
 * 一条人工处置。
 *
 * 处置不是删除：它只是把这条发现从「待处理」里挪出去，因此必须能被撤销
 * （否则「忽略」就成了永久放弃）。
 */
export interface PortDisposition {
  /** ack = 确认；ignore = 忽略（有时效）；whitelist = 加白（永久） */
  action: 'ack' | 'ignore' | 'whitelist';
  actor: string;
  ts: number;
  /** 仅 ignore 有值：到期自动回到待处理 */
  expires_at?: number | null;
  note: string;
  label: string;
  kind: 'port' | 'process';
}

export interface PortDispositionItem extends PortDisposition {
  fingerprint: string;
}

export interface SuspiciousSignal {
  code: string;
  severity: PortSeverity;
  label: string;
}

export interface SuspiciousProcess {
  pid: number;
  ppid: number;
  user: string;
  name: string;
  args: string;
  etime: string;
  exe: string;
  severity: PortSeverity;
  signals: SuspiciousSignal[];
  connections: Array<{ local: string; peer: string }>;
  /** 处置指纹：同一个程序命中同一条规则算同一件事（PID 每次都变，不能当标识） */
  fingerprint: string;
  /** 人工处置：确认 / 忽略 / 加白 */
  disposition?: PortDisposition | null;
}

export interface PortSummary {
  listeners: number;
  exposed: number;
  unexpected: number;
  unexpected_ports: number[];
  suspicious: number;
  /** 已处置（确认 / 忽略 / 加白）但仍列出的条目数 */
  disposed?: number;
  highest: string;
  unattributed: number;
  firewall_active: boolean;
}

export interface PortFirewall {
  active?: boolean;
  manager?: string;
  detail?: string;
}

/** 单台服务器的完整巡检结果 */
export interface PortReport {
  host_id: string;
  local: boolean;
  name: string;
  host: string;
  address: string;
  checked_at: number;
  ok: boolean;
  error: string;
  elevated: boolean;
  os: BaselineOsInfo;
  listeners: PortListener[];
  exposed: PortListener[];
  unexpected: PortListener[];
  suspicious: SuspiciousProcess[];
  firewall: PortFirewall;
  summary: PortSummary;
}

export interface PortTopPort {
  port: number;
  proto: string;
  address: string;
  process: string;
  sensitive: boolean;
  severity: PortSeverity;
}

export interface PortTopSuspicious {
  pid: number;
  name: string;
  user: string;
  severity: PortSeverity;
  labels: string[];
}

export interface PortHostSummary {
  host_id: string;
  name: string;
  host: string;
  local: boolean;
  ok: boolean;
  error: string;
  elevated: boolean;
  os: BaselineOsInfo;
  summary: PortSummary;
  top_ports: PortTopPort[];
  top_suspicious: PortTopSuspicious[];
  firewall: PortFirewall;
}

export interface PortFleetTotals {
  hosts: number;
  reachable: number;
  unreachable: number;
  exposed: number;
  unexpected: number;
  suspicious: number;
  no_firewall: number;
}

export interface PortOverview {
  hosts: PortHostSummary[];
  totals: PortFleetTotals;
  generated_at: number;
}

export interface PortPolicy {
  enabled: boolean;
  alert_open_ports: boolean;
  alert_suspicious: boolean;
  cooldown_minutes: number;
  notify_user: string;
  /** 预期对外开放的端口："22" / "0.0.0.0:80" / "*:443" */
  expected_ports: string[];
  /** 进程白名单（正则，匹配命令行即忽略） */
  process_whitelist: string[];
}

/* ---------------------------------------------------------------------------
   应急响应：虚拟机隔离
   --------------------------------------------------------------------------- */

export interface QuarantineStep {
  step: string;
  ok: boolean;
  detail: string;
  snapshot?: string;
  interfaces?: string[];
  action?: string;
}

export interface QuarantineResult {
  node: string;
  vmid: number;
  ok: boolean;
  steps: QuarantineStep[];
  summary: string;
  snapshot?: string;
  interfaces?: string[];
  power_action?: string;
  note?: string;
  started_at?: number;
  /** 处置能力的边界说明（快照非内存取证、link_down 不覆盖直通网卡…） */
  caveats?: string[];
}

export interface QuarantineNet {
  interface: string;
  value: string;
  link_down: boolean;
}

export interface QuarantineEvidence {
  name: string;
  description: string;
  snaptime?: number | null;
}

export interface QuarantineStatus {
  node: string;
  vmid: number;
  isolated: boolean;
  cut_interfaces: string[];
  networks: QuarantineNet[];
  protected: boolean;
  evidence_snapshots: QuarantineEvidence[];
}

/* ---------------------------------------------------------------------------
   备份防护（防删 / 防篡改核对）
   --------------------------------------------------------------------------- */

/** ok 一致 / missing 已丢失 / changed 元数据变了 / unknown 无法确认 */
export type ProtectedBackupState = 'ok' | 'missing' | 'changed' | 'unknown';

export interface ProtectedBackup {
  volid: string;
  node: string;
  storage: string;
  vmid: string;
  size: number;
  ctime: number;
  meta_fingerprint: string;
  note: string;
  created: number;
  created_by: string;
  last_seen: number;
  state: ProtectedBackupState;
  state_detail: string;
  pve_protected: boolean;
}

export interface ProtectedBackupList {
  items: ProtectedBackup[];
  note: string;
}

export interface ProtectedVerifyResult {
  checked: number;
  ok: number;
  missing: number;
  changed: number;
  unknown: number;
  items: Array<{ volid: string; state: ProtectedBackupState; detail: string }>;
  fired: number;
  /**
   * true = 本次核对**只统计当前用户自己登记的**受保护备份，且没有触发告警。
   * 后端对普通用户按归属过滤（管理员拿到全量结果，这个字段为 undefined）。
   */
  scoped?: boolean;
}

/* ---------------------------------------------------------------------------
   面板自身的更新（检查新版本 / 一键更新，见后端 app/update.py）
   --------------------------------------------------------------------------- */

/** 安装目录的 git 状态（容器与打包安装时只有 is_git: false） */
export interface UpdateGitInfo {
  is_git?: boolean;
  root?: string;
  remote?: string;
  branch?: string;
  head?: string;
  /** HEAD 正好落在某个 tag 上时的 tag 名（不在 tag 上就是空串） */
  tag?: string;
  /** 工作区有未提交改动 —— 一键更新会覆盖它们，所以默认被挡住 */
  dirty?: boolean;
  dirty_files?: number;
}

/** 面板「是怎么装的」：这决定更新能不能一键做 */
export interface UpdateDeployment {
  form?: 'docker' | 'git' | 'other';
  root?: string;
  /** 当前进程所属的 systemd 服务名（空串 = 不是 systemd 托管的） */
  service?: string;
  /** 真的由 systemd 托管：手工起的实例重启的是另一个进程，代码不会换 */
  managed?: boolean;
  is_root?: boolean;
  git?: UpdateGitInfo;
}

export interface UpdateStatus {
  current: string;
  /** 最近一次检查到的最新版本（空串 = 还没检查出结果） */
  latest: string;
  tag: string;
  release_name: string;
  /** Release 说明（GitHub 的 body，可能较长） */
  notes: string;
  release_url: string;
  published_at: string;
  /** 上次检查的 Unix 秒；0 = 从未检查 */
  checked_at: number;
  update_available: boolean;
  /** 用户选择「跳过」的版本（空串 = 不跳过） */
  skipped: string;
  auto_check: boolean;
  repo: string;
  /** 上次检查的失败原因（空串 = 成功） */
  error: string;
  /** 更新进行中时的信息（空对象 = 当前没有在更新） */
  applying?: { tag?: string; started_at?: number; log?: string; from?: string };
  last_update?: { tag?: string; ok?: boolean; at?: number; log?: string };
  /** 能否一键更新；为 false 时看 reason */
  can_apply: boolean;
  /** 不能一键更新的原因，直接展示给用户 */
  reason: string;
  deployment: UpdateDeployment;
  /** 该部署形态下的手工升级命令 */
  manual: string[];
}

/** 一键更新启动后的回执（更新本身在后台跑，进度看日志） */
export interface UpdateApplyResult {
  started: boolean;
  tag: string;
  log: string;
  script: string;
  command: string;
  current: string;
}
