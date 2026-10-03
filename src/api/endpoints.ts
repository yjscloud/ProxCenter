/* ==========================================================================
   ProxCenter — API 调用函数（按模块组织）
   路径严格对齐后端契约
   ========================================================================== */

import { del, get, http, post, put, scoped, upload } from './client';
import type {
  AuditEntry,
  AuditQuery,
  CaptchaChallenge,
  BackupCreateRequest,
  BackupItem,
  BackupStats,
  BackupJob,
  BackupJobInput,
  BackupRestoreRequest,
  ClusterHaStatus,
  ClusterResource,
  ClusterStatus,
  ConnectionConfig,
  ConnectionConfigInput,
  ConnectionProfile,
  ConnectionStatus,
  FleetStatus,
  PermissionGroup,
  RoleOut,
  UserAccountStatus,
  UserOut,
  ConnectionRepairResult,
  ConnectionTestResult,
  DiagnosticsResult,
  LoginCaptchaMode,
  VmDefaults,
  VmQuotaInfo,
  ResourceSpec,
  VmMetaEntry,
  VmMetaListResult,
  FrpEffective,
  FrpRule,
  FrpRuleInput,
  FrpRuleList,
  FrpServer,
  FrpStatus,
  HealthStatus,
  IpPool,
  IpPoolStatus,
  AlertEmailConfig,
  ApiTokenCreated,
  ApiTokenList,
  AuthSession,
  PrefsPayload,
  SchedulerJob,
  SchedulerOverview,
  FirewallApplyResult,
  FirewallGroup,
  FirewallIpset,
  FirewallOptions,
  FirewallRefs,
  FirewallRule,
  FirewallRuleInput,
  FirewallScope,
  FirewallTemplate,
  Fail2banStatus,
  FleetOverview,
  HostAuditCursor,
  HostAuditHost,
  HostLoginsResult,
  HostSudoResult,
  VmAuditResult,
  BaselineFixAllResult,
  BaselineFixResult,
  BaselineFleetReport,
  BaselineHost,
  BaselineReport,
  BulkRequest,
  BulkResponse,
  PortDisposition,
  PortDispositionItem,
  PortOverview,
  PortPolicy,
  PortReport,
  ProtectedBackupList,
  ProtectedVerifyResult,
  QuarantineResult,
  QuarantineStatus,
  SshHost,
  SshHostTestResult,
  SshFailureRow,
  SshKnownIp,
  SshLogSource,
  SshCheckResult,
  SshLoginRow,
  SshOverview,
  SshPolicy,
  SshSummary,
  LoginRequest,
  LoginResponse,
  TwoFactorSetup,
  TwoFactorStatus,
  MailConfig,
  MailConfigInput,
  MyPermissions,
  NetworkInterface,
  NetworkInterfaceInput,
  NodeInfo,
  PasswordChangeInput,
  ForgotPasswordInput,
  ForgotPasswordResult,
  ProfileUpdateInput,
  RegisterInput,
  ResetTokenCheck,
  NodeStatus,
  DiskHealth,
  DiskSmart,
  FaqItem,
  Paginated,
  PanelSettings,
  SiteInfo,
  UiPrefs,
  RrdPoint,
  ZfsPool,
  RrdTimeframe,
  Snapshot,
  SnapshotCreateRequest,
  Storage,
  StorageContent,
  TaskDetail,
  TaskInfo,
  UserInfo,
  VmCloneRequest,
  VmConfig,
  VmCreateRequest,
  VmCreateResponse,
  VmAddDiskRequest,
  VmAddNetworkRequest,
  VmDetail,
  LxcTemplateItem,
  LxcDetail,
  LxcCreateRequest,
  LxcCreateResponse,
  LxcCreateNetwork,
  LxcCreateMount,
  LxcConfigUpdate,
  LxcCloneRequest,
  LxcResizeRequest,
  LxcMoveRequest,
  LxcMigrateRequest,
  VmDiskUsage,
  VmHardwareResult,
  GuestPasswordMethods,
  GuestPasswordRequest,
  GuestPasswordResult,
  VmMigrateRequest,
  VmMoveRequest,
  VmResizeRequest,
  VmSummary,
  VncProxyResponse,
  CloudInitConfig,
  TemplateItem,
  CloudImageItem,
  TemplateFromImageRequest,
  TemplateBuildResult,
  TemplateCloneRequest,
  TemplateCloneResult,
  CapacityForecast,
  DashboardSummary,
  DashboardTop,
  IsoItem,
  AlertRecord,
  AlertRule,
  AlertsOverview,
  BotCommand,
  BotConfig,
  CertSite,
  CertDeployLog,
  CertOptions,
  RemoteCertificate,
  TencentCertConfig,
  LocalHostState,
  PanelKeyState,
  NotificationListResult,
  SearchResult,
} from './types';

/** 统一的任务返回 */
interface TaskResponse {
  task: string;
}

/* ---------------------------------------------------------------------------
   认证
   --------------------------------------------------------------------------- */

export const authApi = {
  login: (body: LoginRequest) => post<LoginResponse>('/auth/login', body),
  /** 登录页验证码（公开接口）：required=false 时前端隐藏输入框 */
  captcha: () => get<CaptchaChallenge>('/auth/captcha'),
  /** 自助注册（公开接口）：提交后账号进入待审批队列，不能立即登录 */
  register: (body: RegisterInput) =>
    post<{ ok: boolean; status: string; message: string }>('/auth/register', body),
  /**
   * 自助重置第 1 步（公开接口）：给账号邮箱发一次性链接。
   * 无论账号是否存在都返回同一句话，防止被用来枚举账号。
   */
  forgotPassword: (body: ForgotPasswordInput) =>
    post<ForgotPasswordResult>('/auth/forgot-password', body),
  /** 校验重置链接是否还有效（不消耗令牌） */
  checkResetToken: (token: string) =>
    post<ResetTokenCheck>('/auth/reset-password/check', { token }),
  /** 自助重置第 2 步：凭令牌设置新密码，令牌一次性 */
  resetPassword: (token: string, password: string) =>
    post<{ ok: boolean; username: string; message: string }>(
      '/auth/reset-password',
      { token, password },
    ),
  /** 登录第二步：mfa_token + 动态码（或一次性恢复码） */
  loginMfa: (body: { mfa_token: string; code: string }) =>
    post<LoginResponse>('/auth/login/2fa', body),
  /**
   * 用 HttpOnly 里的 refresh cookie 换新 access token。
   *
   * 正常情况下由 axios 拦截器在 401 时自动调用，前端不需要手动调它。
   */
  refresh: () => post<LoginResponse>('/auth/refresh'),
  logout: () => post<{ ok: boolean }>('/auth/logout'),
  /** 退出所有设备（撤销全部会话 + 会话版本 +1） */
  logoutAll: () =>
    post<{ message: string; sessions_revoked: number; token_version: number }>(
      '/auth/logout-all',
    ),
  me: () => get<UserInfo>('/auth/me'),
  /** 修改自己的个人信息（邮箱） */
  updateProfile: (body: ProfileUpdateInput) => put<UserInfo>('/auth/me', body),
  /**
   * 敏感操作前的二次确认：重输密码（开了两步验证还要动态码或恢复码）。
   *
   * 前端一般不用直接调它 —— axios 拦截器收到 403 + ``X-Step-Up: required``
   * 时会自动弹框、调用本接口、再重放原请求。
   */
  stepUp: (password: string, totpCode?: string) =>
    post<{ ok: boolean; expires_in: number; message: string }>('/auth/step-up', {
      password,
      totp_code: totpCode ?? '',
    }),
  /**
   * 修改自己的密码（需提供当前密码；开了两步验证还要动态码）。
   * 改完其它设备全部下线，本次响应会把新的 Cookie 直接换发下来。
   */
  changePassword: (body: PasswordChangeInput) =>
    post<{
      ok: boolean;
      message: string;
      other_sessions_revoked?: number;
    }>('/auth/password', body),
  /** 自己的角色与生效权限（普通用户也能调用） */
  myPermissions: () => get<MyPermissions>('/auth/my-permissions'),

  /* ---- 已登录设备（服务端会话）---- */
  sessions: () => get<{ sessions: AuthSession[] }>('/auth/sessions'),
  /** 把某一台设备踢下线（只允许操作自己的会话） */
  revokeSession: (id: string) =>
    del<{ ok: boolean; message: string }>(`/auth/sessions/${id}`),

  /* ---- 两步验证（TOTP）---- */
  twoFactorStatus: () => get<TwoFactorStatus>('/auth/2fa'),
  /** 生成新种子（还没启用）：返回二维码与种子，扫完要用动态码确认 */
  setupTwoFactor: () => post<TwoFactorSetup>('/auth/2fa/setup'),
  /** 用一次动态码确认绑定，返回一次性恢复码（只显示这一次） */
  enableTwoFactor: (code: string) =>
    post<{ ok: boolean; recovery_codes: string[]; message: string }>(
      '/auth/2fa/enable',
      { code },
    ),
  /** 关闭两步验证（口令 + 动态码双确认） */
  disableTwoFactor: (password: string, code: string) =>
    post<{ ok: boolean; message: string }>('/auth/2fa/disable', {
      password,
      code,
    }),
};

/* ---------------------------------------------------------------------------
   健康检查
   --------------------------------------------------------------------------- */

export const healthApi = {
  /** 面板自身的健康探测（后端是否可达 PVE） */
  check: () => get<HealthStatus>('/health'),

  /* ---- 硬件健康：磁盘 SMART / ZFS 池 / Ceph，属于「事前」信号 ---- */

  /** 磁盘健康总览：一次请求拿回该节点全部磁盘的 health 与 wearout */
  disks: (node: string, connectionId?: string) =>
    get<DiskHealth[]>(`/nodes/${node}/disks/health`, scoped(connectionId)),
  /** 单块磁盘的 SMART 详情，点开才请求（ATA 给结构化属性，NVMe 给原文） */
  diskSmart: (node: string, disk: string, connectionId?: string) =>
    get<DiskSmart>(`/nodes/${node}/disks/smart`, {
      params: { disk },
      ...scoped(connectionId),
    }),
  /** ZFS 池；没有池的节点返回空数组 */
  zfs: (node: string, connectionId?: string) =>
    get<ZfsPool[]>(`/nodes/${node}/disks/zfs`, scoped(connectionId)),
  /** Ceph 集群状态；未部署时返回 { installed: false } */
  ceph: () =>
    get<{
      installed: boolean;
      clusters: Array<Record<string, unknown>>;
    }>('/cluster/ceph/status'),
};

/* ---------------------------------------------------------------------------
   连接配置
   --------------------------------------------------------------------------- */

export const configApi = {
  getConnection: () => get<ConnectionConfig>('/config/connection'),
  updateConnection: (body: ConnectionConfigInput) =>
    put<ConnectionConfig | { ok: boolean }>('/config/connection', body),
  testConnection: (body: Omit<ConnectionConfigInput, 'node_default'>) =>
    post<ConnectionTestResult>('/config/connection/test', body),
  /** 环境自检：探测当前凭据的有效权限，并解释各项限制 */
  diagnostics: () => get<DiagnosticsResult>('/config/diagnostics'),
  /** 面板级创建默认值（当前只有默认 DNS），创建向导向所有用户预填 */
  getVmDefaults: () => get<VmDefaults>('/config/vm-defaults'),
  saveVmDefaults: (dns: string) => put<VmDefaults>('/config/vm-defaults', { dns }),
  /**
   * 资源规格（套餐）。管理员在设置页维护、下单页读取，因此**读取只要求登录**；
   * 保存是整份覆盖（与 IP 池同一契约），需要 settings.manage，
   * 不合法的条目会被后端逐条丢弃，返回值才是真正落库的那份。
   */
  getSpecs: () => get<{ specs: ResourceSpec[] }>('/config/specs'),
  saveSpecs: (specs: ResourceSpec[]) =>
    put<{ specs: ResourceSpec[] }>('/config/specs', specs),
  /**
   * 登录页的验证方式：关闭 / 图形验证码 / 拖动滑块。
   * 读取只要求登录（设置页要显示当前值）；写入需要 settings.manage + 二次确认。
   */
  getLoginCaptcha: () => get<{ mode: LoginCaptchaMode }>('/config/login-captcha'),
  saveLoginCaptcha: (mode: LoginCaptchaMode) =>
    put<{ mode: LoginCaptchaMode }>('/config/login-captcha', { mode }),
  /**
   * 面板界面开关（导航栏里被逐个关闭的入口）。
   * 读取只要求登录：控制台外壳在每个用户登录后立刻要用。写入需要
   * settings.manage，但不需要二次确认 —— 它不降低安全门槛，只改新版式。
   *
   * 提交时两个字段都带上：后端对缺省字段的处理是「保持原值」，前端显式给全，
   * 免得两份状态各改一半。
   */
  getUiPrefs: () => get<UiPrefs>('/config/ui'),
  saveUiPrefs: (prefs: UiPrefs) => put<UiPrefs>('/config/ui', prefs),
  /**
   * 虚拟机下发总配额（全局容量上限）。
   * `quota` 传 null 表示「不限制」；传 0 表示普通用户完全不能下发。
   */
  getVmQuota: () => get<VmQuotaInfo>('/config/vm-quota'),
  saveVmQuota: (quota: number | null) =>
    put<VmQuotaInfo>('/config/vm-quota', { quota }),
  /** 容器下发额度：与虚拟机额度互相独立 */
  getLxcQuota: () => get<VmQuotaInfo>('/config/lxc-quota'),
  saveLxcQuota: (quota: number | null) =>
    put<VmQuotaInfo>('/config/lxc-quota', { quota }),
  /**
   * 面板全局地址：邮件（重置密码 / 审批结果）与飞书回调里拼链接用的对外域名。
   * 空串 = 未配置，后端回落到本次请求的 Host。
   */
  getPanelUrl: () => get<{ url: string }>('/config/panel-url'),
  savePanelUrl: (url: string) => put<{ url: string }>('/config/panel-url', { url }),
};

/* ---------------------------------------------------------------------------
   站点信息（品牌名 / 副标题 / 版权）
   --------------------------------------------------------------------------- */

export const siteApi = {
  /** 公开接口：登录页与落地页在未登录状态下也要展示品牌名 */
  get: () => get<SiteInfo>('/config/site'),
  /** 保存站点信息，需要 settings.manage 权限；留空 = 恢复该项默认值 */
  save: (body: SiteInfo) => put<SiteInfo>('/config/site', body),
  /** 上传自定义 Logo（PNG / JPG / WebP / GIF / SVG / ICO，≤ 512 KB） */
  uploadLogo: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return upload<SiteInfo>('/config/site/logo', form);
  },
  /** 移除自定义 Logo，界面回落内置图标 */
  removeLogo: () => del<SiteInfo>('/config/site/logo'),
  /** 上传登录页背景图（PNG / JPG / WebP / GIF，≤ 4 MB） */
  uploadLoginBg: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return upload<SiteInfo>('/config/site/login-bg', form);
  },
  /** 移除登录页背景图，登录页回落内置插画 */
  removeLoginBg: () => del<SiteInfo>('/config/site/login-bg'),
};

/* ---------------------------------------------------------------------------
   常见问题（产品官网 FAQ 区块）
   --------------------------------------------------------------------------- */

export const faqApi = {
  /** 公开接口：产品官网在未登录状态下也要渲染 FAQ */
  get: () => get<FaqItem[]>('/config/faq'),
  /** 保存 FAQ，需要 settings.manage 权限；传空数组 = 关闭官网的 FAQ 区块 */
  save: (items: FaqItem[]) => put<FaqItem[]>('/config/faq', { items }),
  /** 恢复内置的默认问题 */
  reset: () => del<FaqItem[]>('/config/faq'),
};

/* ---------------------------------------------------------------------------
   邮件通知（SMTP）
   --------------------------------------------------------------------------- */

export const mailApi = {
  /** 读配置（登录即可）。返回体不含 SMTP 密码，只有 password_set */
  get: () => get<MailConfig>('/config/mail'),
  /** 保存配置，需要 settings.manage；password 留空 = 沿用旧值 */
  save: (body: MailConfigInput) => put<MailConfig>('/config/mail', body),
  /** 发一封测试邮件。to 留空时发给「管理员收件人」 */
  test: (to = '') =>
    post<{ ok: boolean; detail: string }>('/config/mail/test', { to }),
};

/* ---------------------------------------------------------------------------
   集群
   --------------------------------------------------------------------------- */

export const clusterApi = {
  status: () => get<ClusterStatus>('/cluster/status'),
  /** 集群仲裁与 HA 运行状态（多节点集群掉仲裁意味着整群只读） */
  haStatus: () => get<ClusterHaStatus>('/cluster/ha-status'),
  /**
   * 所有 PVE 连接的合计状态。
   *
   * 「控制台状态」「设置 → 系统信息」这类全局位置要用它，而不是只能读一套
   * 连接的 `/health` —— 否则 4 套连接只显示 1 个节点。
   */
  fleetStatus: () => get<FleetStatus>('/cluster/fleet-status'),
  resources: () => get<ClusterResource[]>('/cluster/resources'),
  /**
   * connectionId 可选：指定在另一台 PVE 主机上取号（多主机创建时用）。
   * 形参为 unknown 是为了兼容 `queryFn: clusterApi.nextId` 这种直接引用 ——
   * react-query 会传入查询上下文对象，`scoped` 会安全忽略非字符串入参。
   */
  nextId: (connectionId?: unknown) =>
    get<{ vmid: number }>('/cluster/nextid', scoped(connectionId)),
  tasks: (params: { node?: string; limit?: number } = {}) =>
    get<TaskInfo[]>('/cluster/tasks', { params }),
};

/* ---------------------------------------------------------------------------
   节点
   --------------------------------------------------------------------------- */

export const nodesApi = {
  /**
   * connectionId 可选：指定在另一台 PVE 主机上读取节点列表。
   * 形参为 unknown 是为了兼容 `queryFn: nodesApi.list` 这种直接引用 ——
   * react-query 会传入查询上下文对象，`scoped` 会安全忽略非字符串入参。
   */
  list: (connectionId?: unknown) => get<NodeInfo[]>('/nodes', scoped(connectionId)),
  status: (node: string, connectionId?: string) =>
    get<NodeStatus>(`/nodes/${node}/status`, scoped(connectionId)),
  rrddata: (node: string, timeframe: RrdTimeframe = 'hour', connectionId?: string) =>
    get<RrdPoint[]>(`/nodes/${node}/rrddata`, {
      params: { timeframe },
      ...scoped(connectionId),
    }),
  network: (node: string, connectionId?: string) =>
    get<NetworkInterface[]>(`/nodes/${node}/network`, scoped(connectionId)),
  createNetwork: (node: string, body: NetworkInterfaceInput, connectionId?: string) =>
    post<TaskResponse>(`/nodes/${node}/network`, body, scoped(connectionId)),
  updateNetwork: (
    node: string,
    iface: string,
    body: NetworkInterfaceInput,
    connectionId?: string,
  ) => put<TaskResponse>(`/nodes/${node}/network/${iface}`, body, scoped(connectionId)),
  deleteNetwork: (node: string, iface: string, connectionId?: string) =>
    del<TaskResponse>(`/nodes/${node}/network/${iface}`, scoped(connectionId)),
  reloadNetwork: (node: string, iface: string, connectionId?: string) =>
    post<TaskResponse>(
      `/nodes/${node}/network/${iface}/reload`,
      undefined,
      scoped(connectionId),
    ),
};

/* ---------------------------------------------------------------------------
   IP 地址池
   --------------------------------------------------------------------------- */

export const ipPoolsApi = {
  get: () => get<{ pools: IpPoolStatus[]; used: string[] }>('/ip-pools'),
  save: (pools: IpPool[]) => put<{ pools: IpPool[] }>('/ip-pools', pools),
};

/* ---------------------------------------------------------------------------
   节点备注（面板侧存储）
   --------------------------------------------------------------------------- */

export const nodeNotesApi = {
  get: () => get<{ notes: Record<string, string> }>('/node-notes'),
  save: (notes: Record<string, string>) =>
    put<{ notes: Record<string, string> }>('/node-notes', notes),
};

/* ---------------------------------------------------------------------------
   虚拟机 / 容器的手动 IP（面板侧补充信息）
   ---------------------------------------------------------------------------
   只解决「平台拿不到 IP」的显示问题，不会回写 PVE 的网络配置。
   存法见后端 routers/vm_meta.py（settings KV）。
   --------------------------------------------------------------------------- */

export const vmMetaApi = {
  /** 当前用户可见的全部手动 IP（管理员拿全量，普通用户只有自己填的） */
  list: () => get<VmMetaListResult>('/vm-meta'),
  /** ip 传空串 = 清除该条记录，回落到平台自动识别 */
  save: (body: {
    node: string;
    vmid: number;
    connection_id?: string | null;
    ip: string;
  }) => put<{ key: string; item: VmMetaEntry | null }>('/vm-meta', body),
};

/**
 * 手动 IP 的条目键。
 *
 * 必须与后端 `_entry_key` 完全一致：两台 PVE 上可以同时存在 node1/100，
 * 不带连接就会把两台不同的机器认成同一台。
 */
export function vmMetaKey(
  connectionId: string | null | undefined,
  node: string,
  vmid: number,
): string {
  return `${connectionId ?? ''}|${node}|${vmid}`;
}



/* ---------------------------------------------------------------------------
   多 PVE 连接
   --------------------------------------------------------------------------- */

export const connectionsApi = {
  list: () => get<ConnectionProfile[]>('/connections'),
  /** 逐条探测已保存 PVE 的可达性（多台同时在线时提示哪台不可用） */
  status: () => get<ConnectionStatus[]>('/connections/status'),
  create: (body: ConnectionConfigInput & { name?: string }) =>
    post<ConnectionProfile>('/connections', body),
  update: (id: string, body: ConnectionConfigInput & { name?: string }) =>
    put<ConnectionProfile>(`/connections/${id}`, body),
  /**
   * 指定「默认读取的那一台」。
   *
   * 多台 PVE 仍是**同级**的，没有哪台更「正式」—— 这个指针只服务少数一次只能
   * 读单台的接口（健康探活、`/cluster/status`）。后端仍会自动维护它（第一条连接
   * 创建时置为它，删除时顺延），但管理员可以在「设置 → 系统信息」里改，
   * 否则多连接部署下「节点数只有 1 个」这类读数没人解释得清。
   */
  activate: (id: string) => post<{ active: string }>(`/connections/${id}/activate`),
  remove: (id: string) => del<{ deleted: string; remaining: number }>(`/connections/${id}`),
  /** 一键修复：给该连接的 API Token 授予 PVEAdmin（需已保存 PVE 账号密码） */
  repair: (id: string) =>
    post<ConnectionRepairResult>(`/connections/${id}/repair-permissions`),
};

/* ---------------------------------------------------------------------------
   存储
   --------------------------------------------------------------------------- */

export const storagesApi = {
  list: (node?: string, connectionId?: string) =>
    get<Storage[]>('/storages', {
      params: node ? { node } : {},
      ...scoped(connectionId),
    }),
  content: (
    params: {
      node: string;
      storage: string;
      content?: string;
    },
    connectionId?: string,
  ) => get<StorageContent[]>('/storages/content', { params, ...scoped(connectionId) }),
  deleteContent: (body: { node: string; storage: string; volid: string }) =>
    del<TaskResponse & { deleted?: string }>('/storages/content', {
      params: body,
    }),
  /** 上传（后端可能未实现，调用方需容错）*/
  upload: (
    params: { node: string; storage: string; content: string },
    file: File,
    onProgress?: (percent: number) => void,
  ) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('node', params.node);
    fd.append('storage', params.storage);
    fd.append('content', params.content);
    return upload<{ volid?: string; task?: string }>(
      '/storages/upload',
      fd,
      onProgress,
    );
  },
};

/* ---------------------------------------------------------------------------
   虚拟机
   --------------------------------------------------------------------------- */

export const vmsApi = {
  /**
   * 虚拟机列表。
   *
   * `type` 支持 `qemu`（默认，只返回虚拟机）、`lxc`、`all`（虚拟机 + 容器混排）。
   * 列表页用 `all`，返回里每行的 `type` 决定该调哪套接口、跳哪个详情页。
   */
  list: (
    node?: string,
    opts?: { withIp?: boolean; connectionId?: string; type?: 'qemu' | 'lxc' | 'all' },
  ) =>
    get<VmSummary[]>('/vms', {
      params: {
        ...(node ? { node } : {}),
        ...(opts?.withIp ? { with_ip: true } : {}),
        ...(opts?.type ? { type: opts.type } : {}),
      },
      ...scoped(opts?.connectionId),
    }),
  create: (body: VmCreateRequest, connectionId?: string) =>
    post<VmCreateResponse>('/vms', body, scoped(connectionId)),
  /** 下发配额读数：还能建几台（创建向导用它把数量摆在明面上） */
  quota: () => get<VmQuotaInfo>('/vms/quota'),
  /**
   * 批量操作：一次对多台机器执行同一动作，逐台回报结果。
   * HTTP 200 只表示请求合法，成败看 `results[]` 每一项的 `ok`。
   */
  bulk: (body: BulkRequest) => post<BulkResponse>('/vms/bulk', body),
  detail: (node: string, vmid: number) =>
    get<VmDetail>(`/vms/${node}/${vmid}`),
  delete: (node: string, vmid: number, purge = true, connectionId?: unknown) =>
    del<TaskResponse>(`/vms/${node}/${vmid}`, {
      params: { purge },
      ...scoped(connectionId),
    }),

  /* 电源操作 */
  start: (node: string, vmid: number, timeout?: number) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/status/start`, { timeout }),
  stop: (node: string, vmid: number) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/status/stop`),
  shutdown: (node: string, vmid: number, timeout?: number, forceStop?: boolean) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/status/shutdown`, {
      timeout,
      forceStop,
    }),
  reboot: (node: string, vmid: number) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/status/reboot`),
  suspend: (node: string, vmid: number) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/status/suspend`),
  resume: (node: string, vmid: number) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/status/resume`),

  /* 配置 */
  clone: (node: string, vmid: number, body: VmCloneRequest) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/clone`, body),
  updateConfig: (node: string, vmid: number, body: Partial<VmConfig>) =>
    put<TaskResponse>(`/vms/${node}/${vmid}/config`, body),
  toTemplate: (node: string, vmid: number, connectionId?: unknown) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/template`, undefined, scoped(connectionId)),
  resize: (node: string, vmid: number, body: VmResizeRequest) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/resize`, body),
  /** 新增一块磁盘；槽位与 format= 都由后端按存储类型决定 */
  addDisk: (node: string, vmid: number, body: VmAddDiskRequest) =>
    post<VmHardwareResult>(`/vms/${node}/${vmid}/hardware/disk`, body),
  /** 新增一张网卡 */
  addNetwork: (node: string, vmid: number, body: VmAddNetworkRequest) =>
    post<VmHardwareResult>(`/vms/${node}/${vmid}/hardware/network`, body),
  /** 卸掉一件硬件（磁盘 / 网卡 / 光驱）。只删配置项，卷数据留在存储池 */
  removeHardware: (node: string, vmid: number, key: string) =>
    del<{ task: string; key: string }>(`/vms/${node}/${vmid}/hardware/${key}`),
  /**
   * 读取客户机内文件系统的真实用量。
   *
   * 后端会经 Guest Agent 在客户机里执行 df，所以是**按需调用**，不要放进
   * 轮询 —— 每调一次就会在客户机里起一个进程。
   */
  diskUsage: (node: string, vmid: number) =>
    post<VmDiskUsage>(`/vms/${node}/${vmid}/disk-usage`),
  move: (node: string, vmid: number, body: VmMoveRequest) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/move`, body),
  ipconfig: (node: string, vmid: number, body: Partial<CloudInitConfig>) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/ipconfig`, body),
  migrate: (node: string, vmid: number, body: VmMigrateRequest) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/migrate`, body),

  /**
   * 重置客户机内某个用户的口令。
   *
   * 后端按顺序试：Guest Agent（即时生效）→ cloud-init（会重启）。
   * 先读 `passwordMethods` 看这台机器现在能走哪条，别硬猜 —— 关机、没装
   * agent、没挂 cloud-init 盘的机器情况各不相同。
   */
  passwordMethods: (node: string, vmid: number, connectionId?: unknown) =>
    get<GuestPasswordMethods>(
      `/vms/${node}/${vmid}/password-methods`,
      scoped(connectionId),
    ),
  resetPassword: (
    node: string,
    vmid: number,
    body: GuestPasswordRequest,
    connectionId?: unknown,
  ) =>
    post<GuestPasswordResult>(
      `/vms/${node}/${vmid}/password`,
      body,
      scoped(connectionId),
    ),

  /* 归属指派（管理员：把存量虚拟机交给某个用户） */
  getOwner: (node: string, vmid: number, connectionId?: string) =>
    get<{ node: string; vmid: number; owner: string | null }>(
      `/vms/${node}/${vmid}/owner`,
      { params: connectionId ? { connection_id: connectionId } : {} },
    ),
  assignOwner: (
    node: string,
    vmid: number,
    username: string | null,
    connectionId?: string,
  ) =>
    put<{ node: string; vmid: number; owner: string | null }>(
      `/vms/${node}/${vmid}/owner`,
      { username, connection_id: connectionId || null },
    ),

  /* 快照 */
  snapshots: (node: string, vmid: number) =>
    get<Snapshot[]>(`/vms/${node}/${vmid}/snapshot`),
  createSnapshot: (node: string, vmid: number, body: SnapshotCreateRequest) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/snapshot`, body),
  rollbackSnapshot: (node: string, vmid: number, name: string) =>
    post<TaskResponse>(`/vms/${node}/${vmid}/snapshot/${name}/rollback`),
  deleteSnapshot: (node: string, vmid: number, name: string) =>
    del<TaskResponse>(`/vms/${node}/${vmid}/snapshot/${name}`),

  /* 监控 */
  rrddata: (node: string, vmid: number, timeframe: RrdTimeframe = 'hour') =>
    get<RrdPoint[]>(`/vms/${node}/${vmid}/rrddata`, { params: { timeframe } }),

  /* Guest Agent */
  agentNetwork: (node: string, vmid: number) =>
    get<unknown>(`/vms/${node}/${vmid}/agent/network`),

  /* 控制台代理（只保留 VNC） */
  vncProxy: (node: string, vmid: number) =>
    post<VncProxyResponse>(`/vms/${node}/${vmid}/console/vncproxy`),

  /* 待生效配置 */
  pending: (node: string, vmid: number) =>
    get<Array<{ key: string; value?: string; pending?: string; delete?: number }>>(
      `/vms/${node}/${vmid}/pending`,
    ),
};

/* ---------------------------------------------------------------------------
   LXC 容器

   容器的 PVE 端点与虚拟机是两套（/lxc/{vmid}/... 而不是 /qemu/{vmid}/...），
   所以这里独立成一组；归属与权限仍在后端与 vms 共用。
   --------------------------------------------------------------------------- */

export const lxcApi = {
  list: (node?: string, opts?: { withIp?: boolean; connectionId?: string }) =>
    get<VmSummary[]>('/lxc', {
      params: {
        ...(node ? { node } : {}),
        ...(opts?.withIp ? { with_ip: true } : {}),
      },
      ...scoped(opts?.connectionId),
    }),

  /** 容器下发额度的读数（与虚拟机的 /vms/quota 是两份独立额度） */
  quota: () => get<VmQuotaInfo>('/lxc/quota'),

  /** 节点上可用的容器模板（vztmpl），供创建向导选择 */
  templates: (node: string, connectionId?: string) =>
    get<LxcTemplateItem[]>('/lxc/templates', {
      params: { node },
      ...scoped(connectionId),
    }),

  create: (body: LxcCreateRequest, connectionId?: string) =>
    post<LxcCreateResponse>('/lxc', body, scoped(connectionId)),

  detail: (node: string, vmid: number) => get<LxcDetail>(`/lxc/${node}/${vmid}`),

  delete: (
    node: string,
    vmid: number,
    purge = true,
    force = false,
    connectionId?: string,
  ) =>
    del<TaskResponse>(`/lxc/${node}/${vmid}`, {
      params: { purge, force },
      ...scoped(connectionId),
    }),

  /* 电源操作（容器没有 hibernate） */
  start: (node: string, vmid: number) =>
    post<TaskResponse>(`/lxc/${node}/${vmid}/status/start`),
  stop: (node: string, vmid: number) =>
    post<TaskResponse>(`/lxc/${node}/${vmid}/status/stop`),
  shutdown: (node: string, vmid: number, timeout?: number, forceStop?: boolean) =>
    post<TaskResponse>(`/lxc/${node}/${vmid}/status/shutdown`, {
      timeout,
      forceStop,
    }),
  reboot: (node: string, vmid: number) =>
    post<TaskResponse>(`/lxc/${node}/${vmid}/status/reboot`),
  suspend: (node: string, vmid: number) =>
    post<TaskResponse>(`/lxc/${node}/${vmid}/status/suspend`),
  resume: (node: string, vmid: number) =>
    post<TaskResponse>(`/lxc/${node}/${vmid}/status/resume`),

  /* 配置 */
  updateConfig: (node: string, vmid: number, body: LxcConfigUpdate) =>
    put<TaskResponse>(`/lxc/${node}/${vmid}/config`, body),
  clone: (
    node: string,
    vmid: number,
    body: LxcCloneRequest,
    connectionId?: string,
  ) => post<TaskResponse>(`/lxc/${node}/${vmid}/clone`, body, scoped(connectionId)),

  /** 容器转模板（PVE 的 `pct template`；要求容器已关机） */
  toTemplate: (node: string, vmid: number, connectionId?: string) =>
    post<TaskResponse>(
      `/lxc/${node}/${vmid}/template`,
      undefined,
      scoped(connectionId),
    ),
  migrate: (node: string, vmid: number, body: LxcMigrateRequest) =>
    post<TaskResponse>(`/lxc/${node}/${vmid}/migrate`, body),
  /** 扩容 rootfs / mpN。容器只支持增容 */
  resize: (node: string, vmid: number, body: LxcResizeRequest) =>
    post<TaskResponse>(`/lxc/${node}/${vmid}/resize`, body),
  /** 把 rootfs / mpN 迁到别的存储 */
  moveVolume: (node: string, vmid: number, body: LxcMoveRequest) =>
    post<TaskResponse>(`/lxc/${node}/${vmid}/move`, body),

  /**
   * 重置容器内某个用户的口令。
   *
   * 容器没有 Guest Agent，PVE 的 API 里也没有「在容器里执行命令」的端点，
   * 所以后端只有一条通道：借「SSH → 受管主机」的凭据在宿主机上执行
   * `pct exec <vmid> -- chpasswd`。没配受管主机时 `passwordMethods` 会说明。
   */
  passwordMethods: (node: string, vmid: number, connectionId?: unknown) =>
    get<GuestPasswordMethods>(
      `/lxc/${node}/${vmid}/password-methods`,
      scoped(connectionId),
    ),
  resetPassword: (
    node: string,
    vmid: number,
    body: GuestPasswordRequest,
    connectionId?: unknown,
  ) =>
    post<GuestPasswordResult>(
      `/lxc/${node}/${vmid}/password`,
      body,
      scoped(connectionId),
    ),

  /* 硬件增删：网卡（netN）与挂载点（mpN） */
  addNetwork: (node: string, vmid: number, body: LxcCreateNetwork) =>
    post<VmHardwareResult>(`/lxc/${node}/${vmid}/hardware/network`, body),
  addMount: (node: string, vmid: number, body: LxcCreateMount) =>
    post<VmHardwareResult>(`/lxc/${node}/${vmid}/hardware/mount`, body),
  removeHardware: (node: string, vmid: number, key: string) =>
    del<{ task: string; key: string }>(`/lxc/${node}/${vmid}/hardware/${key}`),

  /* 快照（没有 vmstate） */
  snapshots: (node: string, vmid: number) =>
    get<Snapshot[]>(`/lxc/${node}/${vmid}/snapshot`),
  createSnapshot: (node: string, vmid: number, body: SnapshotCreateRequest) =>
    post<TaskResponse>(`/lxc/${node}/${vmid}/snapshot`, body),
  rollbackSnapshot: (node: string, vmid: number, name: string) =>
    post<TaskResponse>(`/lxc/${node}/${vmid}/snapshot/${name}/rollback`),
  deleteSnapshot: (node: string, vmid: number, name: string) =>
    del<TaskResponse>(`/lxc/${node}/${vmid}/snapshot/${name}`),

  /* 监控 */
  rrddata: (node: string, vmid: number, timeframe: RrdTimeframe = 'hour') =>
    get<RrdPoint[]>(`/lxc/${node}/${vmid}/rrddata`, { params: { timeframe } }),

  /* 待生效配置 */
  pending: (node: string, vmid: number) =>
    get<Array<{ key: string; value?: string; pending?: string; delete?: number }>>(
      `/lxc/${node}/${vmid}/pending`,
    ),

  /* 控制台代理（只保留 VNC） */
  vncProxy: (node: string, vmid: number) =>
    post<VncProxyResponse>(`/lxc/${node}/${vmid}/console/vncproxy`),

  /* 归属指派（管理员） */
  getOwner: (node: string, vmid: number, connectionId?: string) =>
    get<{ node: string; vmid: number; owner: string | null }>(
      `/lxc/${node}/${vmid}/owner`,
      { params: connectionId ? { connection_id: connectionId } : {} },
    ),
  assignOwner: (
    node: string,
    vmid: number,
    username: string | null,
    connectionId?: string,
  ) =>
    put<{ node: string; vmid: number; owner: string | null }>(
      `/lxc/${node}/${vmid}/owner`,
      { username, connection_id: connectionId || null },
    ),
};

/** 容器 VNC WebSocket 地址 */
export function lxcVncWsUrl(
  node: string,
  vmid: number,
  port: number,
  ticket: string,
): string {
  return wsUrl(`/lxc/${node}/${vmid}/console/vncws`, {
    port: String(port),
    vncticket: ticket,
  });
}



/* ---------------------------------------------------------------------------
   站内通知 / 全局搜索
   --------------------------------------------------------------------------- */

export const notificationsApi = {
  /** 消息列表 + 未读数（一次拿全，角标与列表不会对不上） */
  list: (params: { limit?: number; unread_only?: boolean } = {}) =>
    get<NotificationListResult>('/notifications', { params }),
  /** 只取未读数：铃铛每 30 秒轮询一次，不必把整页消息拉回来 */
  unread: () => get<{ unread: number }>('/notifications/unread'),
  /** 标记已读：给 ids 或 all=true */
  markRead: (body: { ids?: number[]; all?: boolean }) =>
    post<{ marked: number; unread: number }>('/notifications/read', body),
};

export const searchApi = {
  /** 跨资源搜索（虚拟机 / 节点 / 存储 / 用户），按资源类型分组返回 */
  query: (q: string, limit?: number) =>
    get<SearchResult>('/search', {
      params: { q, ...(limit ? { limit } : {}) },
    }),
};

/* ---------------------------------------------------------------------------
   后台作业（调度器，见后端 app/scheduler.py）
   --------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   用户界面偏好（按用户存服务端，见后端 app/prefs.py）
   --------------------------------------------------------------------------- */

export const prefsApi = {
  /** 当前用户的全部偏好（仪表盘布局等） */
  list: () => get<PrefsPayload>('/prefs'),
  /** 覆盖写一条偏好 */
  save: (key: string, value: unknown) =>
    put<{ key: string; value: unknown }>(`/prefs/${key}`, { value }),
  /** 清除一条偏好，回到「未设置」（前端随即用默认值） */
  reset: (key: string) => del<{ key: string; removed: boolean }>(`/prefs/${key}`),
};

export const schedulerApi = {
  /** 全部作业及其运行状态 */
  list: () => get<SchedulerOverview>('/scheduler'),
  /** 改间隔 / 启停（改完立刻重算下次唤醒时刻） */
  configure: (id: string, body: { interval?: number; enabled?: boolean }) =>
    put<SchedulerJob>(`/scheduler/${id}`, body),
  /** 立即执行一次并等结果 —— 这个按钮就是拿来看错误信息的 */
  runNow: (id: string) => post<SchedulerJob>(`/scheduler/${id}/run`, {}),
  /** 恢复该作业的代码默认间隔与启用状态 */
  reset: (id: string) => post<SchedulerJob>(`/scheduler/${id}/reset`, {}),
};

/* ---------------------------------------------------------------------------
   个人 API Token（脚本 / 外部系统对接，见后端 app/apitokens.py）
   --------------------------------------------------------------------------- */

export const tokensApi = {
  /** 我的令牌列表 + 配额与功能开关 */
  list: () => get<ApiTokenList>('/tokens'),
  /**
   * 创建令牌。响应里的 `token` 是明文唯一一次出现的地方。
   *
   * 后端要求二次确认（403 + X-Step-Up: required），axios 拦截器会自动弹框
   * 重放，调用方不用自己处理。
   */
  create: (body: { name: string; ttl_days?: number }) =>
    post<ApiTokenCreated>('/tokens', body),
  /** 吊销（软删除，列表里仍置灰可见，便于事后追溯） */
  revoke: (id: number) => del<{ ok: boolean; revoked: number; active: number }>(`/tokens/${id}`),
};

/* ---------------------------------------------------------------------------
   备份
   --------------------------------------------------------------------------- */

export const backupsApi = {
  /**
   * 备份归档列表。
   *
   * ``connectionId`` 对**节点作用域**的接口是必需的：不带时后端会落到「面板当前
   * 连接」，选出别的 PVE 上的节点名就会变成在错误的主机上找节点 —— PVE 直接回
   * ``hostname lookup 'pve9' failed``。页面从聚合节点列表里取该节点自己的连接。
   */
  list: (
    params: { node?: string; storage?: string; vmid?: number } = {},
    connectionId?: string,
  ) => get<BackupItem[]>('/backups', { params, ...scoped(connectionId) }),
  /** 最近 N 天的备份任务成败统计，跨所有已保存的 PVE（本身就汇总，不带连接） */
  stats: (days = 7) =>
    get<BackupStats>('/backups/stats', { params: { days } }),
  create: (body: BackupCreateRequest, connectionId?: string) =>
    post<TaskResponse>('/backups', body, scoped(connectionId)),
  restore: (body: BackupRestoreRequest, connectionId?: string) =>
    post<TaskResponse>('/backups/restore', body, scoped(connectionId)),
  /** 删除备份归档（后端按 notes 归属标记做用户隔离） */
  remove: (
    params: { node: string; storage: string; volid: string },
    connectionId?: string,
  ) => del<{ deleted: string }>('/backups', { params, ...scoped(connectionId) }),
  jobs: (connectionId?: string) =>
    get<BackupJob[]>('/backups/jobs', scoped(connectionId)),
  createJob: (body: BackupJobInput, connectionId?: string) =>
    post<{ job_id: string | number }>('/backups/jobs', body, scoped(connectionId)),
  deleteJob: (jobId: string | number, connectionId?: string) =>
    del<{ ok: boolean }>(`/backups/jobs/${jobId}`, scoped(connectionId)),
  /**
   * 下载直链（浏览器直接打开：会话在 HttpOnly Cookie 里，链接带不了请求头）。
   *
   * 因为带不了 ``X-PVE-Connection``，连接只能从 URL 参数推断：已知就传
   * ``connectionId``，否则后端按节点归属自己找。``node`` / ``storage`` 也**必须**
   * 带上 —— 归档在宿主机上的路径是 ``<存储路径>/dump/<归档名>``，只有 volid
   * 拼不出来（后端的 ``/storage`` 才拿得到存储的 path）。
   */
  downloadUrl: (params: {
    node: string;
    storage: string;
    volid: string;
    connectionId?: string;
  }) => {
    const query = new URLSearchParams({
      node: params.node,
      storage: params.storage,
      volid: params.volid,
    });
    if (params.connectionId) query.set('connection', params.connectionId);
    return `${http.defaults.baseURL}/backups/download?${query.toString()}`;
  },
};

/* ---------------------------------------------------------------------------
   任务
   --------------------------------------------------------------------------- */

export const tasksApi = {
  /**
   * `node` 可选：UPID 本身已编码节点名，后端会自动解析。
   * 仅在极少数无法解析的场景才需要显式传入。
   */
  detail: (upid: string, node?: string) =>
    get<TaskDetail>(`/tasks/${encodeURIComponent(upid)}`, {
      params: node ? { node } : {},
    }),
  remove: (upid: string, node?: string) =>
    del<{ ok: boolean }>(`/tasks/${encodeURIComponent(upid)}`, {
      params: node ? { node } : {},
    }),
  stop: (upid: string, node?: string) =>
    post<{ ok: boolean }>(`/tasks/${encodeURIComponent(upid)}/stop`, undefined, {
      params: node ? { node } : {},
    }),
  list: (params: { node?: string; limit?: number; running_only?: boolean } = {}) =>
    get<TaskInfo[]>('/tasks', { params }),
};

/* ---------------------------------------------------------------------------
   面板用户
   --------------------------------------------------------------------------- */

export const usersApi = {
  /** status 给定时只返回该审批状态的账号（审批队列用） */
  list: (status?: UserAccountStatus) =>
    get<UserOut[]>('/users', status ? { params: { status } } : undefined),
  create: (body: {
    username: string;
    password: string;
    role: string;
    email?: string;
    comment?: string;
    /** 用户级权限覆盖：不传 = 继承角色；传数组（含空数组）= 以它为准 */
    permissions?: string[] | null;
  }) => post<UserOut>('/users', body),
  update: (
    username: string,
    body: {
      role?: string;
      email?: string;
      enabled?: boolean;
      password?: string;
      permissions?: string[] | null;
      /** 只有为 true 时才改动用户级覆盖（用于区分「不改」与「清空覆盖」） */
      set_permissions?: boolean;
      /** 审批状态；管理员可借此恢复被拒绝的注册 */
      status?: UserAccountStatus;
    },
  ) => put<UserOut>(`/users/${username}`, body),
  remove: (username: string) => del<{ deleted?: boolean; username?: string }>(`/users/${username}`),
  /** 角色目录（含 admin 自建角色） */
  roles: () => get<RoleOut[]>('/users/roles'),
  /** 审批通过注册申请，同时定下角色与权限 */
  approve: (
    username: string,
    body: {
      role: string;
      permissions?: string[] | null;
      set_permissions?: boolean;
    },
  ) => post<UserOut>(`/users/${username}/approve`, body),
  /** 拒绝注册申请（账号保留，状态置为 rejected） */
  reject: (username: string, reason?: string) =>
    post<UserOut>(`/users/${username}/reject`, { reason: reason ?? '' }),
};

/* ---------------------------------------------------------------------------
   角色与权限目录
   --------------------------------------------------------------------------- */

export const rolesApi = {
  /** 按域分组的权限清单，供勾选界面渲染 */
  catalog: () => get<PermissionGroup[]>('/permissions/catalog'),
  list: () => get<RoleOut[]>('/roles'),
  create: (body: {
    id?: string;
    name: string;
    description?: string;
    permissions: string[];
  }) => post<RoleOut>('/roles', body),
  update: (
    id: string,
    body: { name?: string; description?: string; permissions: string[] },
  ) => put<RoleOut>(`/roles/${id}`, body),
  remove: (id: string) => del<{ deleted: string }>(`/roles/${id}`),
};

/* ---------------------------------------------------------------------------
   审计日志
   --------------------------------------------------------------------------- */

export const auditApi = {
  list: (params: AuditQuery = {}) =>
    get<Paginated<AuditEntry>>('/audit', { params }),
};

/* ---------------------------------------------------------------------------
   模板
   --------------------------------------------------------------------------- */

export const templatesApi = {
  /**
   * 集群内的模板（不按归属过滤 —— 模板是共享资源，普通用户也能用于部署）。
   * connectionId 可选：指定在另一台 PVE 主机上读取。
   * guestType 可选：只取某一类（虚拟机克隆源只要 qemu；模板页两类都要，不传）。
   */
  list: (connectionId?: unknown, guestType?: 'qemu' | 'lxc') =>
    get<TemplateItem[]>('/templates', {
      ...(guestType ? { params: { guest_type: guestType } } : {}),
      ...scoped(connectionId),
    }),
  /** 某节点上可用的 cloud 镜像（.img/.qcow2）*/
  images: (node: string, connectionId?: unknown) =>
    get<CloudImageItem[]>('/templates/images', {
      params: { node },
      ...scoped(connectionId),
    }),
  /** 流水线：从 cloud 镜像构建模板（后端逐步执行并等待每步完成）*/
  buildFromImage: (body: TemplateFromImageRequest) =>
    post<TemplateBuildResult>('/templates/from-image', body),
  /** 把现有虚拟机转换为模板（必要时自动关机）*/
  convertVm: (body: { node: string; vmid: number; shutdown?: boolean; shutdown_timeout?: number }) =>
    post<TemplateBuildResult>('/templates/from-vm', body),
  /** 从模板部署新虚拟机，支持 cloud-init 个性化 */
  /** 从模板部署新虚拟机；connectionId 指定该模板所在的 PVE 主机 */
  clone: (body: TemplateCloneRequest, connectionId?: unknown) =>
    post<TemplateCloneResult>('/templates/clone', body, scoped(connectionId)),
};

/* ---------------------------------------------------------------------------
   仪表盘
   --------------------------------------------------------------------------- */

export const dashboardApi = {
  summary: () => get<DashboardSummary>('/dashboard/summary'),
  top: (limit = 5) =>
    get<DashboardTop>('/dashboard/top', { params: { limit } }),
  capacity: (timeframe: 'week' | 'month' | 'year' = 'month') =>
    get<CapacityForecast>('/dashboard/capacity', { params: { timeframe } }),
};

/* ---------------------------------------------------------------------------
   ISO / cloud 镜像
   --------------------------------------------------------------------------- */

export const isoApi = {
  list: (node: string) => get<IsoItem[]>('/storages/iso', { params: { node } }),
};

/* ---------------------------------------------------------------------------
   WebSocket
   --------------------------------------------------------------------------- */

/**
 * 通用 WebSocket 地址构造（同源，自动匹配 ws/wss）。
 *
 * 鉴权走 HttpOnly Cookie：浏览器在 WS 握手上会把同源 Cookie 一起带上，
 * 所以不再把令牌拼进查询串 —— URL 会漏进 Nginx access log、浏览器历史与
 * Referer。脚本客户端仍可在 extra 里显式传 token。
 */
export function wsUrl(path: string, extra?: Record<string, string>): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = http.defaults.baseURL ?? '/api';
  const entries = Object.entries(extra ?? {}).filter(([, v]) => v !== '');
  const query = new URLSearchParams(entries).toString();
  return `${proto}//${window.location.host}${base}${path}${query ? `?${query}` : ''}`;
}

/**
 * 导出直链（供 window.open / <a download> 使用）。
 *
 * 服务端流式吐 CSV，覆盖全量数据、不受分页限制 —— 合规归档要的是「这张表里的
 * 全部记录」，前端那 50 条一页导出来没有意义。
 *
 * 鉴权同样走 HttpOnly Cookie：浏览器打开链接会带上同源 Cookie，所以不把令牌
 * 拼进查询串（URL 会进 Nginx access log、浏览器历史与 Referer）。
 * 空值参数一律丢掉，后端按「未筛选」处理。
 */
export function exportUrl(
  resource: 'audit' | 'tasks' | 'vms' | 'alerts',
  params?: Record<string, string | number | boolean | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return `${http.defaults.baseURL}/export/${resource}${query ? `?${query}` : ''}`;
}

/** 任务进度 WebSocket 地址 */
export function taskWsUrl(): string {
  return wsUrl('/ws/tasks');
}

/** 实时节点指标 WebSocket 地址 */
export function metricsWsUrl(): string {
  return wsUrl('/ws/metrics');
}

/** VNC WebSocket 地址（ticket 仍是查询参数，那是 PVE 的一次性凭据） */
export function vncWsUrl(
  node: string,
  vmid: number,
  port: number,
  ticket: string,
): string {
  return wsUrl(`/vms/${node}/${vmid}/console/vncws`, {
    port: String(port),
    vncticket: ticket,
  });
}



/* ---------------------------------------------------------------------------
   聚合 API 对象（方便 import）
   --------------------------------------------------------------------------- */

export const api = {
  auth: authApi,
  health: healthApi,
  config: configApi,
  cluster: clusterApi,
  nodes: nodesApi,
  storages: storagesApi,
  vms: vmsApi,
  templates: templatesApi,
  dashboard: dashboardApi,
  iso: isoApi,
  backups: backupsApi,
  tasks: tasksApi,
  users: usersApi,
  roles: rolesApi,
  audit: auditApi,
  ipPools: ipPoolsApi,
  nodeNotes: nodeNotesApi,
  connections: connectionsApi,
};

/* ---------------------------------------------------------------------------
   面板本地设置（localStorage）
   --------------------------------------------------------------------------- */

const SETTINGS_KEY = 'pve_panel_settings';

export const defaultSettings: PanelSettings = {
  refreshInterval: Number(import.meta.env.VITE_REFRESH_INTERVAL) || 10_000,
  pageSize: Number(import.meta.env.VITE_PAGE_SIZE) || 20,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
};

export function loadSettings(): PanelSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings;
    const parsed = JSON.parse(raw) as Partial<PanelSettings>;
    return { ...defaultSettings, ...parsed };
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(settings: PanelSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 忽略 */
  }
}

/* ---------------------------------------------------------------------------
   内网穿透（frp 客户端）—— 按职责拆为服务端（admin）+ 规则（按用户归属）

   - frpApi.server.{get,save,start,stop,install}: 仅 admin 可写
   - frpApi.rules.{list,create,update,remove}: 任何 frp.manage 用户可写自己的
   - frpApi.effective(): 任何人可读，查看 server + 所有规则的合并渲染
   - frpApi.status() / logs(): 进程级状态与日志
   --------------------------------------------------------------------------- */

export const frpApi = {
  server: {
    get: () => get<FrpServer>("/frp/server"),
    save: (payload: {
      server_addr?: string;
      server_port?: number;
      token?: string;
      token_clear?: boolean;
    }) =>
      put<
        FrpServer & { restarted?: boolean; restart_error?: string }
      >("/frp/server", payload),
    start: () => post<FrpStatus>("/frp/server/start"),
    /** 停止 frpc。后端会同时关掉「自动拉起」，返回值里的 auto_restart 即最新状态 */
    stop: () => post<FrpStatus>("/frp/server/stop"),
    install: () => post<{ binary: string }>("/frp/server/install"),
    /**
     * 开关「frpc 停止后自动拉起」。开启时若 frpc 当前没在跑会**立刻**拉起一次，
     * 不用等看护的下一个周期；失败原因在 start_error 里。
     */
    autoRestart: (enabled: boolean) =>
      post<FrpStatus & { started?: boolean; start_error?: string }>(
        "/frp/server/auto-restart",
        { enabled },
      ),
  },
  rules: {
    list: () => get<FrpRuleList>("/frp/rules"),
    create: (payload: FrpRuleInput & { username?: string }) =>
      post<FrpRule>("/frp/rules", payload),
    update: (id: string, payload: Partial<FrpRuleInput>) =>
      put<FrpRule>(`/frp/rules/${id}`, payload),
    remove: (id: string) =>
      del<{ deleted: string }>(`/frp/rules/${id}`),
  },
  effective: () => get<FrpEffective>("/frp/effective"),
  status: () => get<FrpStatus>("/frp/status"),
  logs: () => get<{ logs: string[] }>("/frp/logs"),
};

export const alertsApi = {
  get: () => get<AlertsOverview>("/alerts"),
  saveFeishu: (cfg: any) => put<any>("/alerts/feishu", cfg),
  /** 推送来源开关（全局，管理员）。只传要改的来源即可，其余保持不变。 */
  saveNotifySources: (cfg: Record<string, boolean>) =>
    put<Pick<AlertsOverview, "notify_sources" | "notify_enabled">>(
      "/alerts/notify-sources",
      cfg,
    ),
  /** 保存当前用户的通用 Webhook（地址与签名密钥加密存储） */
  saveWebhook: (cfg: any) => put<any>("/alerts/webhook", cfg),
  /** 保存当前用户的告警邮件收件人（只影响自己那一份） */
  saveEmail: (cfg: AlertEmailConfig) =>
    put<{ email: AlertEmailConfig; mail_ready: boolean }>("/alerts/email", cfg),
  saveRules: (rules: AlertRule[]) => put<{ rules: AlertRule[] }>("/alerts/rules", rules),
  /** 发测试通知；channel 默认飞书，通用 Webhook 传 "webhook" */
  test: (channel: "feishu" | "webhook" = "feishu") =>
    post<any>(`/alerts/test?channel=${channel}`),
  check: () => post<{ fired: AlertRecord[]; count: number }>("/alerts/check"),
  clearHistory: () =>
    del<{ removed: number; detail: string }>("/alerts/history"),
};

/* ---------------------------------------------------------------------------
   网站证书（腾讯云免费证书）
   --------------------------------------------------------------------------- */

export interface CertsOverview {
  tencent: TencentCertConfig;
  secret_set: boolean;
  sites: CertSite[];
  logs: CertDeployLog[];
  options: CertOptions;
  /** 当前登录用户名 */
  own_username?: string;
  /** 是否管理员：管理员可见全部用户的站点与日志 */
  is_admin?: boolean;
}

export const certsApi = {
  get: () => get<CertsOverview>("/certs"),
  saveTencent: (cfg: Partial<TencentCertConfig> & { secret_key_clear?: boolean }) =>
    put<{ tencent: TencentCertConfig; secret_set: boolean }>("/certs/tencent", cfg),
  testTencent: () =>
    post<{ total: number; detail: string }>("/certs/tencent/test"),
  remoteList: (search = "") =>
    get<{ certificates: RemoteCertificate[]; count: number }>(
      "/certs/tencent/list",
      { params: { search } },
    ),
  createSite: (site: Partial<CertSite>) =>
    post<{ site: CertSite }>("/certs/sites", site),
  updateSite: (id: string, site: Partial<CertSite>) =>
    put<{ site: CertSite }>(`/certs/sites/${id}`, site),
  removeSite: (id: string) =>
    del<{ removed: boolean; detail: string }>(`/certs/sites/${id}`),
  apply: (id: string, domain?: string) =>
    post<{ cert_id: string; detail: string; site: CertSite }>(
      `/certs/sites/${id}/apply`,
      domain ? { domain } : {},
    ),
  deploy: (id: string) =>
    post<{ ok: boolean; detail: string; site: CertSite }>(
      `/certs/sites/${id}/deploy`,
    ),
  sync: (id: string) =>
    post<{ site: CertSite }>(`/certs/sites/${id}/sync`),
  bind: (id: string, certId: string) =>
    post<{ detail: string; site: CertSite }>(`/certs/sites/${id}/bind`, {
      cert_id: certId,
    }),
  syncAll: () => post<{ sites: CertSite[] }>("/certs/sync"),
  clearLogs: () => del<{ removed: number; detail: string }>("/certs/logs"),
};

/* ---------------------------------------------------------------------------
   飞书机器人（指令控制）
   --------------------------------------------------------------------------- */

export const feishuApi = {
  get: () =>
    get<{ config: BotConfig; event_url: string; commands: BotCommand[] }>(
      "/feishu/config",
    ),
  save: (cfg: Record<string, unknown>) =>
    put<{ config: BotConfig }>("/feishu/config", cfg),
  test: (chatId: string) =>
    post<{ detail: string }>("/feishu/test", { chat_id: chatId }),
};

/* ---------------------------------------------------------------------------
   防火墙（PVE 原生：集群 / 节点 / 虚拟机 + 安全组 / IP 集合 / 规则模板）
   --------------------------------------------------------------------------- */

/** 作用域参数：集群级不需要 node/vmid，节点级要 node，虚拟机级要 node+vmid */
function fwScope(
  scope: FirewallScope,
  node?: string,
  vmid?: number,
): { params: Record<string, string | number> } {
  const params: Record<string, string | number> = {};
  if (scope !== 'cluster' && node) params.node = node;
  if (scope === 'vm' && vmid !== undefined) params.vmid = vmid;
  return { params };
}

export const firewallApi = {
  /* ---- 规则 ----
     统一参数顺序：(scope, node, vmid, ...载荷)，用途是让页面能直接
     `fwApi.createRule(...scopeParams, rule)` 这样展开，不必每个调用点记两套顺序。 */
  rules: (scope: FirewallScope, node?: string, vmid?: number) =>
    get<FirewallRule[]>(`/firewall/${scope}/rules`, fwScope(scope, node, vmid)),
  createRule: (
    scope: FirewallScope,
    node: string | undefined,
    vmid: number | undefined,
    body: FirewallRuleInput,
  ) =>
    post<{ ok: boolean }>(
      `/firewall/${scope}/rules`,
      body,
      fwScope(scope, node, vmid),
    ),
  updateRule: (
    scope: FirewallScope,
    node: string | undefined,
    vmid: number | undefined,
    pos: number,
    body: FirewallRuleInput,
  ) =>
    put<{ ok: boolean }>(
      `/firewall/${scope}/rules/${pos}`,
      body,
      fwScope(scope, node, vmid),
    ),
  deleteRule: (
    scope: FirewallScope,
    node: string | undefined,
    vmid: number | undefined,
    pos: number,
  ) =>
    del<{ ok: boolean }>(
      `/firewall/${scope}/rules/${pos}`,
      fwScope(scope, node, vmid),
    ),
  /** 调整优先级：防火墙先匹配先生效 */
  moveRule: (
    scope: FirewallScope,
    node: string | undefined,
    vmid: number | undefined,
    pos: number,
    to: number,
  ) =>
    post<{ ok: boolean }>(`/firewall/${scope}/rules/${pos}/move`, undefined, {
      params: { to, ...fwScope(scope, node, vmid).params },
    }),

  /* ---- 选项（开关 / 默认策略 / 日志级别）---- */
  options: (scope: FirewallScope, node?: string, vmid?: number) =>
    get<FirewallOptions>(`/firewall/${scope}/options`, fwScope(scope, node, vmid)),
  saveOptions: (
    scope: FirewallScope,
    node: string | undefined,
    vmid: number | undefined,
    body: FirewallOptions,
  ) =>
    put<{ ok: boolean }>(
      `/firewall/${scope}/options`,
      body,
      fwScope(scope, node, vmid),
    ),

  /* ---- 编辑器用的引用清单 ---- */
  refs: () => get<FirewallRefs>('/firewall/refs'),

  /* ---- 安全组 ---- */
  groups: () => get<FirewallGroup[]>('/firewall/groups'),
  createGroup: (group: string, comment: string) =>
    post<{ ok: boolean }>('/firewall/groups', { group, comment }),
  deleteGroup: (group: string) =>
    del<{ ok: boolean }>(`/firewall/groups/${group}`),
  groupRules: (group: string) =>
    get<FirewallRule[]>(`/firewall/groups/${group}/rules`),
  createGroupRule: (group: string, body: FirewallRuleInput) =>
    post<{ ok: boolean }>(`/firewall/groups/${group}/rules`, body),
  updateGroupRule: (group: string, pos: number, body: FirewallRuleInput) =>
    put<{ ok: boolean }>(`/firewall/groups/${group}/rules/${pos}`, body),
  deleteGroupRule: (group: string, pos: number) =>
    del<{ ok: boolean }>(`/firewall/groups/${group}/rules/${pos}`),

  /* ---- IP 集合 ---- */
  ipsets: () => get<FirewallIpset[]>('/firewall/ipsets'),
  createIpset: (name: string, comment: string) =>
    post<{ ok: boolean }>('/firewall/ipsets', { name, comment }),
  deleteIpset: (name: string) => del<{ ok: boolean }>(`/firewall/ipsets/${name}`),
  createIpsetEntry: (
    name: string,
    body: { cidr: string; comment: string; nomatch: boolean },
  ) => post<{ ok: boolean }>(`/firewall/ipsets/${name}/entries`, body),
  deleteIpsetEntry: (name: string, cidr: string) =>
    del<{ ok: boolean }>(
      `/firewall/ipsets/${name}/entries/${encodeURIComponent(cidr)}`,
    ),

  /* ---- 规则模板 ---- */
  templates: () => get<FirewallTemplate[]>('/firewall/templates'),
  saveTemplate: (body: FirewallTemplate) =>
    post<{ ok: boolean; template: FirewallTemplate }>('/firewall/templates', body),
  deleteTemplate: (id: string) =>
    del<{ ok: boolean }>(`/firewall/templates/${id}`),
  /** 批量下发到多台虚拟机（需要二次确认） */
  applyTemplate: (
    id: string,
    targets: Array<{ node: string; vmid: number; type?: string }>,
    replace: boolean,
  ) =>
    post<FirewallApplyResult>(`/firewall/templates/${id}/apply`, {
      targets,
      replace,
    }),
};

/* ---------------------------------------------------------------------------
   SSH 登录安全
   --------------------------------------------------------------------------- */

export const sshApi = {
  /** 概览：日志源、失败排行、fail2ban 状态与当前策略 */
  overview: (hours?: number) =>
    get<SshOverview>('/ssh/overview', hours ? { params: { hours } } : undefined),
  /** 失败来源明细 */
  failures: (hours = 24, minCount = 1) =>
    get<{
      source: SshLogSource;
      since: number;
      generated_at: number;
      summary: SshSummary;
      top_users: Array<{ user: string; count: number }>;
      failures: SshFailureRow[];
    }>('/ssh/failures', { params: { hours, min_count: minCount } }),
  /** 成功登录记录（面板每次检查时落库） */
  logins: (limit = 100) =>
    get<{ logins: SshLoginRow[]; known_ips: number }>('/ssh/logins', {
      params: { limit },
    }),

  /* ---- 已知 IP（消掉「陌生 IP 登录」告警）---- */
  knownIps: () => get<SshKnownIp[]>('/ssh/known-ips'),
  trustIp: (ip: string, note = '') => post<{ ok: boolean }>('/ssh/known-ips', { ip, note }),
  forgetIp: (ip: string) =>
    del<{ ok: boolean; removed: number }>(`/ssh/known-ips/${encodeURIComponent(ip)}`),

  /* ---- fail2ban ---- */
  fail2ban: () => get<Fail2banStatus>('/ssh/fail2ban'),
  ban: (jail: string, ip: string) =>
    post<{ ok: boolean; detail: string; jail: string; ip: string }>('/ssh/fail2ban/ban', {
      jail,
      ip,
    }),
  unban: (jail: string, ip: string) =>
    post<{ ok: boolean; detail: string; jail: string; ip: string }>(
      '/ssh/fail2ban/unban',
      { jail, ip },
    ),
  /** 自定义封禁策略：写 /etc/fail2ban/jail.d/panel-<jail>.local 并 reload */
  saveJail: (body: { jail: string; maxretry: number; findtime: number; bantime: number }) =>
    put<{ ok: boolean; path: string; config: string; detail: string }>(
      '/ssh/fail2ban/jail',
      body,
    ),

  /* ---- 策略与手动检测 ---- */
  savePolicy: (policy: SshPolicy) =>
    put<{ policy: SshPolicy }>('/ssh/policy', policy),
  check: () => post<SshCheckResult>('/ssh/check'),
};

/* ---- 受管主机 + 多机聚合 ---- */
export const sshFleetApi = {
  hosts: () => get<SshHost[]>('/ssh/hosts'),
  createHost: (body: Record<string, unknown>) =>
    post<{ host: SshHost }>('/ssh/hosts', body),
  updateHost: (id: string, body: Record<string, unknown>) =>
    put<{ host: SshHost }>(`/ssh/hosts/${id}`, body),
  deleteHost: (id: string) => del<{ ok: boolean; removed: number }>(`/ssh/hosts/${id}`),
  testHost: (id: string) =>
    post<{ host: SshHost; result: SshHostTestResult }>(`/ssh/hosts/${id}/test`),
  /**
   * 指派受管主机的归属（管理员）。``username`` 留空 = 收回，
   * 收回后这台主机只有管理员可见。
   */
  assignOwner: (id: string, username: string) =>
    put<{ ok: boolean; host_id: string; owner: string }>(`/ssh/hosts/${id}/owner`, {
      username,
    }),
  /** 确认并记住主机指纹（首次连接后必须做一次） */
  trustHost: (id: string) =>
    post<{ host: SshHost; ok: boolean; fingerprint: string; detail?: string }>(
      `/ssh/hosts/${id}/trust`,
    ),

  overview: (hours?: number) =>
    get<FleetOverview>('/ssh/fleet', hours ? { params: { hours } } : undefined),
  failures: (hostId: string, hours = 24, minCount = 1) =>
    get<{
      source: SshLogSource;
      summary: SshSummary;
      top_users: Array<{ user: string; count: number }>;
      failures: SshFailureRow[];
    }>(`/ssh/fleet/${hostId}/failures`, {
      params: { hours, min_count: minCount },
    }),
  ban: (hostId: string, jail: string, ip: string) =>
    post<{ ok: boolean; detail: string }>(`/ssh/fleet/${hostId}/fail2ban/ban`, { jail, ip }),
  unban: (hostId: string, jail: string, ip: string) =>
    post<{ ok: boolean; detail: string }>(`/ssh/fleet/${hostId}/fail2ban/unban`, {
      jail,
      ip,
    }),
  saveJail: (
    hostId: string,
    body: { jail: string; maxretry: number; findtime: number; bantime: number },
  ) =>
    put<{ ok: boolean; path: string; config: string; detail: string }>(
      `/ssh/fleet/${hostId}/fail2ban/jail`,
      body,
    ),
};

/* ---- 面板 SSH 密钥对 ----
   面板下发虚拟机时用它把公钥写进 cloud-init。私钥加密落库、永不回传，
   所以只有两个动作：看公钥、轮换。 */
export const sshPanelKeyApi = {
  state: () => get<PanelKeyState>('/ssh/panel-key'),
  /**
   * 轮换密钥对。**旧公钥立即失效** —— 已用它接入的机器会连不上，
   * 返回里的 `affected` 就是这些机器的数量。
   */
  rotate: () =>
    post<{ ok: boolean; key: PanelKeyState; affected: number }>(
      '/ssh/panel-key/rotate',
    ),
};

/* ---- 面板本机（导入 / 移出）----
   本机默认不在管控范围内。state() 特意**不要求已导入** —— 否则未导入时前端
   连「该不该显示导入按钮」都问不出来。 */
export const sshLocalApi = {
  state: () => get<LocalHostState>('/ssh/local'),
  /** 导入本机（需要二次确认，后端会校验 step-up） */
  importLocal: () => post<{ ok: boolean; local: LocalHostState }>('/ssh/local'),
  /** 移出本机；不删已有数据，只是不再采集 */
  removeLocal: () => del<{ ok: boolean; local: LocalHostState }>('/ssh/local'),
};

/* ---------------------------------------------------------------------------
   主机登录审计
   --------------------------------------------------------------------------- */

export const hostAuditApi = {
  hosts: () => get<HostAuditHost[]>('/host-audit/hosts'),
  logins: (hostId = 'local', kind: 'success' | 'failed' = 'success', limit = 200) =>
    get<HostLoginsResult>('/host-audit/logins', {
      params: { host_id: hostId, kind, limit },
    }),
  sudo: (hostId = 'local', hours = 24) =>
    get<HostSudoResult>('/host-audit/sudo', { params: { host_id: hostId, hours } }),
  cursors: () => get<HostAuditCursor[]>('/host-audit/cursors'),
  importNow: (hostId?: string) =>
    post<{ hosts: number; imported: number; details: Array<{ host: string; ok: boolean; imported?: number; error?: string }> }>(
      '/host-audit/import',
      undefined,
      hostId ? { params: { host_id: hostId } } : undefined,
    ),
  vm: (node: string, vmid: number, hours = 24) =>
    get<VmAuditResult>(`/host-audit/vm/${node}/${vmid}`, { params: { hours } }),
  actions: () => get<Record<string, string>>('/host-audit/actions'),
};

/* ---------------------------------------------------------------------------
   安全基线（面板所在主机的体检与一键加固）
   --------------------------------------------------------------------------- */

export const baselineApi = {
  /** 可体检的服务器清单（本机 + 受管主机）；不触发体检 */
  targets: () => get<{ hosts: BaselineHost[] }>('/baseline/targets'),
  /**
   * 全平台总览：并发体检所有服务器，只回摘要（最需要处理的排最前）。
   *
   * 后端对这份报告有一层 2 分钟的 TTL 缓存（同一时刻的重复打开只跑一轮体检），
   * `refresh` = 绕过缓存强制重新体检 —— 页面上的「重新体检」用它。
   *
   * `stale` = 有旧值（哪怕已过期）就先返回、真扫放到后台 —— 首页工作台用它：
   * 一轮体检要 SSH 每台主机（实测 3 秒，主机不可达时几十秒），不该让首页等着。
   * 体检报告**不要**传这个参数，那边要的是准确数据。
   */
  fleet: (refresh = false, stale = false) =>
    get<BaselineFleetReport>(
      refresh
        ? '/baseline/fleet?refresh=1'
        : stale
          ? '/baseline/fleet?stale=1'
          : '/baseline/fleet',
    ),
  /** 单台服务器的完整体检报告（hostId 为 local 或受管主机 id） */
  host: (hostId: string) =>
    get<BaselineReport>(`/baseline/hosts/${encodeURIComponent(hostId)}`),
  /** 本机完整报告（等价于 host('local')，保留给「只看面板本机」的场景） */
  report: () => get<BaselineReport>('/baseline/report'),
  /** 单项加固（改动服务器配置，需 baseline.manage + 二次确认） */
  fix: (key: string, hostId = 'local') =>
    post<BaselineFixResult>('/baseline/fix', { key, host_id: hostId }),
  /** 批量加固；keys 为空时自动挑出所有可安全自动处理的失败项 */
  fixAll: (hostId = 'local', keys: string[] = []) =>
    post<BaselineFixAllResult>('/baseline/fix-all', { host_id: hostId, keys }),
};

/* ---------------------------------------------------------------------------
   端口 / 进程异常检测
   --------------------------------------------------------------------------- */

export const portsApi = {
  /** 可巡检的服务器清单；不触发巡检 */
  hosts: () => get<{ hosts: BaselineHost[] }>('/ports/hosts'),
  /**
   * 全平台总览（最需要看的排最前）。
   *
   * 后端对这份报告有一层 2 分钟的 TTL 缓存（同一时刻的重复打开只跑一轮巡检），
   * `refresh` = 绕过缓存强制重新巡检 —— 页面上的「重新巡检」用它。
   */
  overview: (refresh = false) =>
    get<PortOverview>(refresh ? '/ports/overview?refresh=1' : '/ports/overview'),
  /** 单台服务器详情（监听端口 + 可疑进程） */
  host: (hostId: string) =>
    get<PortReport>(`/ports/hosts/${encodeURIComponent(hostId)}`),
  policy: () => get<{ policy: PortPolicy }>('/ports/policy'),
  savePolicy: (policy: PortPolicy) =>
    put<{ policy: PortPolicy }>('/ports/policy', policy),
  /** 立即巡检并按策略推送告警 */
  check: () =>
    post<{ fired: number; items: unknown[] }>('/ports/check', {}),

  /* ---- 人工处置：确认 / 忽略 / 加白 ---- */
  dispositions: {
    list: (hostId: string) =>
      get<{ host_id: string; items: PortDispositionItem[] }>(
        `/ports/dispositions?host_id=${encodeURIComponent(hostId)}`,
      ),
    create: (body: {
      host_id: string;
      fingerprint: string;
      action: 'ack' | 'ignore' | 'whitelist';
      note?: string;
      ttl_days?: number | null;
      detail?: Record<string, unknown>;
    }) => post<{ record: PortDisposition; policy: PortPolicy }>('/ports/dispositions', body),
    remove: (hostId: string, fingerprint: string) =>
      del<{ deleted: boolean }>(
        `/ports/dispositions?host_id=${encodeURIComponent(hostId)}&fingerprint=${encodeURIComponent(fingerprint)}`,
      ),
  },
};

/* ---------------------------------------------------------------------------
   应急响应：虚拟机隔离
   --------------------------------------------------------------------------- */

export interface QuarantineInput {
  snapshot?: boolean;
  cut_network?: boolean;
  /** none 只断网 / shutdown 优雅关机 / stop 强制关机 */
  power_action?: 'none' | 'shutdown' | 'stop';
  protect?: boolean;
  note?: string;
}

export interface QuarantineReleaseInput {
  restore_network?: boolean;
  unprotect?: boolean;
  power_on?: boolean;
  note?: string;
}

export const isolationApi = {
  /** 当前隔离状态（断了几张网卡、是否保护、有哪些取证快照） */
  status: (node: string, vmid: number) =>
    get<QuarantineStatus>(`/vms/${node}/${vmid}/quarantine`),
  /** 一键隔离（需 vm.isolate + 二次确认） */
  quarantine: (node: string, vmid: number, body: QuarantineInput) =>
    post<QuarantineResult>(`/vms/${node}/${vmid}/quarantine`, body),
  /** 解除隔离 */
  release: (node: string, vmid: number, body: QuarantineReleaseInput) =>
    post<QuarantineResult>(`/vms/${node}/${vmid}/quarantine/release`, body),
};

/* ---------------------------------------------------------------------------
   备份防护（防删 / 防篡改核对）
   --------------------------------------------------------------------------- */

export const protectedBackupsApi = {
  list: (verify = false) =>
    get<ProtectedBackupList>('/backups/protected', { params: { verify } }),
  protect: (body: {
    node: string;
    storage: string;
    volid: string;
    vmid?: number | null;
    note?: string;
  }) => post<{ ok: boolean; detail: string }>('/backups/protected', body),
  unprotect: (volid: string) =>
    del<{ ok: boolean; detail: string }>('/backups/protected', {
      params: { volid },
    }),
  verify: (push = true) =>
    post<ProtectedVerifyResult>('/backups/protected/verify', {}, { params: { push } }),
};
