"""Application settings, loaded from environment / .env file."""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- 安全基线
# 代码与 .env.example 里的占位值。SECRET_KEY 既是登录 JWT 的签名密钥，也是
# 密文存储（crypto.py）的加密根 —— 留默认值等于把两把钥匙印在源码里：拿到
# 仓库就能伪造任意用户的登录态、解出库里所有密文。检测到就拒绝启动。
WEAK_SECRET_KEYS = frozenset(
    {
        "change-me-in-production-please-use-a-long-random-string",
        "change-me-in-production...",
        "change-me-in-production",
        "change-me",
        "changeme",
        "secret",
    }
)

# JWT HS256 的推荐下限；比这更短的随机串离线爆破没有余量。
MIN_SECRET_KEY_LEN = 32

# 首次启动建管理员用的默认口令。留在生产里等于后台敞开。
WEAK_ADMIN_PASSWORDS = frozenset(
    {"admin123", "admin", "admin@123", "password", "passw0rd", "123456", "root"}
)

# 管理员口令长度下限。注意「空口令」也必须拦掉：.env.example 里 ADMIN_PASSWORD
# 就是留空的，只比对弱口令表会让漏配的安装建出空口令管理员。
MIN_ADMIN_PASSWORD_LEN = 12


def is_weak_admin_password(value: object) -> bool:
    """口令是否弱到不能用来建号：空值、过短、或属于上表里的默认值。

    忽略大小写与首尾空白；非字符串（None、数字）一律按弱处理。
    """
    if not isinstance(value, str):
        return True
    stripped = value.strip()
    if len(stripped) < MIN_ADMIN_PASSWORD_LEN:
        return True
    return stripped.lower() in WEAK_ADMIN_PASSWORDS


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Panel HTTP server -------------------------------------------------
    # 默认所有网卡：全新安装的用户第一反应是拿浏览器开 <IP>:8080，绑回环会让人
    # 以为面板没装好（只有本机 curl 得到响应）。上了反向代理之后建议在 .env 里
    # 改回 127.0.0.1，让 8080 只对反代开放。
    host: str = "0.0.0.0"
    port: int = 8080

    # 面板自身不提供 TLS（终结在前面的 Nginx/Caddy）。开启后：所有明文 HTTP
    # 一律 308 到 https://<Host>（本机回环例外，留给健康检查/运维脚本），并且
    # 在 https 响应上加 HSTS。挂在反代后面时务必让反代带上 X-Forwarded-Proto
    # （见 forwarded_allow_ips），否则会来回跳转。
    force_https: bool = False
    # uvicorn 只信任这些来源的 X-Forwarded-Proto。默认仅本机反代 —— 若放宽成
    # 0.0.0.0，公网请求就能自称「我是 https」从而绕过 force_https。
    forwarded_allow_ips: str = "127.0.0.1"

    # --- SSH 入口转发（frp / haproxy）--------------------------------------
    # 面板（以及同网段的其它主机）的 22 端口经 frp 暴露到公网时，sshd 看到的来源
    # 永远是入口机（例如 172.16.149.3），真实攻击者地址被 PROXY protocol 还原后只
    # 落在入口机某条 haproxy frontend 的日志里。填上「入口机在 SSH 远程里的主机 id」
    # 后，导入 host.ssh_failed / host.ssh_login 时会按时间把 IP 换成真实值；匹配
    # 不上就保留原值（还原成功的记录在 detail.forwarded_from 里留下入口机地址）。
    #
    # 成功登录要等会话结束才能配对（haproxy 到连接关闭才写日志行），所以会话中
    # 导入的登录会先挂起，等下一轮导入补写 —— 不会先落一条入口机地址的记录。
    #
    # 只要填了入口机 id 就启用，其它都不用配：面板会去读入口机的 haproxy 配置，
    # 按「frontend -> backend -> server <地址>:22」自动对出「哪台机器走哪条
    # frontend」，同时把入口机自己的地址当作转发机地址（frpc 从它出站回连 sshd）。
    # 换网段、加机器、改 frontend 名字都不用改配置。
    #   SSH_FORWARD_LOG_HOST=hec92c0bc5c
    #
    # 下面三项是**可选覆盖**，只在自动发现不管用的部署里才需要：
    #   SSH_FORWARD_PROXIES  转发机地址（多网卡 / 自动发现拿不到时）
    #   SSH_FORWARD_ROUTES   主机id=frontend[,主机id=frontend]（用 use_backend
    #                        条件分流、或 haproxy 配置读不到时）
    #   SSH_FORWARD_HAPROXY_CFG  haproxy 配置文件路径（默认 /etc/haproxy/haproxy.cfg）
    ssh_forward_log_host: str = ""
    ssh_forward_proxies: str = ""
    ssh_forward_routes: str = ""
    ssh_forward_haproxy_cfg: str = ""

    # --- 公网暴露加固 ------------------------------------------------------
    # 面板准入白名单（逗号分隔的 IP / CIDR，例如
    # "203.0.113.0/24,10.8.0.0/24,192.168.1.10"）。留空 = 不限制来源。
    #
    # 配置后，来源不在名单内的 HTTP / WebSocket 请求在最外层被拒（403 /
    # websocket 1008），面板与 /api/openapi.json 对外都不可见。两个例外：
    #   * 本机回环（127.0.0.0/8、::1）始终放行 —— 否则反代与健康检查会一起失效；
    #   * /api/health 始终放行，留给负载均衡 / 监控探活。
    # 放在 VPN / 零信任网关之后仍建议配置，作为第二道闸；直接暴露公网时
    # 至少要配合 TOTP_REQUIRED_ROLES=admin（见 .env.example）。
    panel_allow_cidrs: str = ""
    # 新来源 IP 登录告警：某个账号第一次从某 IP 成功登录时，给管理员发
    # 站内消息 + 邮件（邮件未配置时只发站内消息）。用于尽早发现凭据泄露。
    login_ip_alert: bool = True
    # 接口文档（/api/docs、/api/redoc、/api/openapi.json）**默认关闭**。
    #
    # 完整的 OpenAPI 定义等于一份全量攻击地图：315 个路径、每个字段的约束、
    # 连「隐藏端点」（导出下载、AI 审批等）都在里面，匿名可读等于把侦察成本
    # 降到零，而面板本身拥有 PVE 全权管理能力。默认关掉，需要时把
    # API_DOCS_ENABLED 打开；打开后这三个地址仍要求「已登录且具备
    # settings.manage 权限」（即管理员），不会是匿名可读。
    api_docs_enabled: bool = False

    # --- Security ----------------------------------------------------------
    # 签发登录 JWT、并作为 crypto.py 密文存储的加密根。留占位值或太短直接
    # 拒绝启动：见文件顶部 WEAK_SECRET_KEYS。随机值可用
    #   python -c "import secrets; print(secrets.token_urlsafe(48))"
    secret_key: str = "change-me-in-production-please-use-a-long-random-string"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 12

    # Bootstrap admin account created on first run.
    # 弱默认口令不会被用来建号：首次启动会直接报错退出（见 store.init_db）。
    admin_username: str = "admin"
    admin_password: str = "admin123"

    # 登录页人机验证（防脚本爆破密码）。默认开启，**具体方式默认「拖动滑块」**
    # （可在「设置 → 登录验证」里切换成图形验证码或关闭，见 app/captcha.py）。
    # 内网纯人用或自动化联调时可设 LOGIN_CAPTCHA=0 彻底关闭。
    login_captcha: bool = True

    # --- 登录失败锁定 ------------------------------------------------------
    # 验证码可以被关掉，光靠它挡不住脚本。这里按「账号」和「来源 IP」双计数：
    # 连续失败 N 次锁一段时间，计数落 MySQL（重启不丢、多进程共享）。
    login_max_failures: int = 5
    # 失败计数窗口：窗口内累计到上限就锁；同时锁定时长也用它。
    login_lockout_minutes: int = 15

    # --- 会话与令牌 --------------------------------------------------------
    # access token 有效期（默认 12 小时）。配合 refresh token 可以调短，
    # 例如 60 —— 调短后前端会在 401 时自动用 refresh cookie 换新。
    access_token_expire_minutes: int = 60 * 12
    # refresh token 有效期：真正的登录时长上限（默认 14 天）。
    refresh_token_expire_days: int = 14
    # 两步验证待验证凭据（mfa_token）的有效期，只够走完一次验证。
    mfa_token_expire_minutes: int = 5
    # refresh cookie 是否带 Secure（只有 https 才回传）。留空 = 跟随 FORCE_HTTPS。
    cookie_secure: Optional[bool] = None

    # --- 敏感操作二次确认（step-up）---------------------------------------
    # 删除虚拟机、修改连接凭据、增删改账号这类高风险操作，要求先用密码
    # （开了 2FA 还要动态码）重新确认一次身份，确认结果只保留几分钟。
    # 即使 token 是从共享电脑 / 日志里捡来的，没有密码也做不了这些操作。
    step_up_required: bool = True
    # 二次确认的有效窗口（分钟）：窗口内重复做敏感操作不必反复输入。
    step_up_window_minutes: int = 5

    # --- 内网穿透（frp）目标白名单 ----------------------------------------
    # frpc 跑在面板后端所在的机器里，规则里的 local_ip 就是它要连的目标。
    # 普通用户默认只能指向**自己名下**的虚机 / 容器 IP；这里还可以显式放行
    # 若干网段（逗号分隔的 IP / CIDR，例如 "10.0.0.0/24,192.168.8.0/24"）。
    # 留空 = 只允许自己名下的机器。
    #
    # 回环、未指定、链路本地、组播、保留地址与**面板自身地址**始终拒绝，
    # 不受这份名单影响 —— 否则等于允许把面板 / PVE API 直接暴露到公网。
    frp_allow_local_cidrs: str = ""
    # 是否禁止指向「面板后端自身所在网段」。默认开启：面板往往与 PVE 管理网
    # 同网段，放开后就等于允许把面板 / PVE API 暴露出去。若业务虚机与面板
    # 同网段、且确实要穿透到该网段的其它服务，可以关掉（面板自身地址仍拒绝）。
    frp_block_panel_subnet: bool = True
    # 公网端口区间的**默认值**。管理员在「内网穿透」页面上设置过就以页面为准，
    # 这里的值只作为初始值 / 兜底（见 frpguard.remote_port_range）。区间内
    # 22 / 80 / 443 / 7000 / 7001 / 8006 等关键端口始终不可占用，与区间无关。
    frp_remote_port_min: int = 40000
    frp_remote_port_max: int = 50000

    # --- 个人 API Token ----------------------------------------------------
    # 允许用户自助创建长期令牌，供脚本 / 外部系统调用（见 apitokens.py）。
    # 令牌继承所属用户的角色与权限覆盖，但**拒绝所有二次确认接口** ——
    # 无人值守的长期凭据不该拥有删机这类不可逆能力。关掉即全站禁用
    # （含已发出的令牌，鉴权时直接拒绝）。
    api_token_enabled: bool = True
    # 每人可同时持有的**有效**令牌上限，防「一人签发几百枚再也收不回来」。
    api_token_max_per_user: int = 10

    # --- 两步验证（TOTP）---------------------------------------------------
    # 认证器 App 里显示的名称，建议写成面板的公网域名。
    totp_issuer: str = "Proxmox Panel"
    # 强制开启两步验证的角色（逗号分隔，如 "admin"）。留空 = 全员可选。
    # 命中列表的角色在完成绑定之前，除 2FA 相关接口外一律 403。
    totp_required_roles: str = ""
    # 允许的时钟漂移步数（1 = 前后各 30 秒）。
    totp_window: int = 1
    # 登录时是否允许勾选「信任设备」（7 天内在同一台浏览器上免输动态码）。
    # 有些环境要求每次登录都必须过第二因子，把它设成 false 即可整体关掉：
    # 前端不再显示这个勾选框，后端即使收到 trust_device=true 也不签发。
    # 关掉只影响**新**签发；已签发的信任记录仍然有效，需要的话由用户在
    # 个人中心「退出所有设备」清掉，或等它们自然过期。
    totp_trust_enabled: bool = True

    # --- 请求限流 ----------------------------------------------------------
    # 全局限流按来源 IP 计数（同样落 MySQL），挡的是脚本扫接口。
    rate_limit_enabled: bool = True
    # 普通 /api 路由：每分钟每 IP 的请求上限。
    rate_limit_per_minute: int = 300
    # 匿名/敏感入口（登录、注册、找回密码、刷新、2FA）：单独一条更紧的线。
    rate_limit_auth_per_minute: int = 30

    # --- Default Proxmox connection (can be overridden at runtime via UI) --
    pve_host: str = ""
    pve_port: int = 8006
    pve_token_id: str = ""       # e.g. "root@pam!panel"
    pve_token_secret: str = ""   # the UUID secret
    # 出站访问 Proxmox 时是否校验服务端证书。**默认关闭**：PVE 出厂是自签证书
    # （cluster CA、CN=pve.local、没有 IP SAN），拿系统信任库校验必然失败 ——
    # 新装面板配连接时会一直「握手失败」，看着像地址或令牌填错。
    #
    # 要安全性就把该集群的证书 PEM 填进单条连接的 ca_cert 做钉扎：钉扎只认那一张
    # 证书，比「信任整个系统 CA」更严格，也不受这个开关影响。这是新建连接的默认
    # 值，已保存的连接始终按自己存的值走。
    pve_verify_ssl: bool = False
    pve_default_node: str = ""

    # Whether outbound PVE requests may be routed through HTTP_PROXY /
    # HTTPS_PROXY from the environment. Defaults to False: Proxmox normally
    # lives on the LAN, and an inherited corporate/sandbox proxy turns every
    # call into a confusing 502. Set to True only if the panel really must
    # reach PVE through a proxy.
    pve_trust_env: bool = False

    # Ticket-auth fallback (required ONLY for VNC/xterm consoles).
    # API tokens cannot open consoles, so the panel needs a real PVE account
    # for console proxying. Leave empty to disable console features.
    pve_console_user: str = ""      # e.g. "root@pam"
    pve_console_password: str = ""

    # --- Behaviour ---------------------------------------------------------
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    task_poll_interval: float = 2.0
    http_timeout: float = 30.0

    # --- 监控历史落库 ------------------------------------------------------
    # 节点与虚拟机的资源指标按固定周期采样进 metrics_history：PVE 的 rrddata
    # 是「实时透传 + 主机自己滚动覆盖」，面板重启、主机重装都会丢；落一份自己的
    # 历史才能查任意区间、出周/月报。详见 metrics.py。
    metrics_history_enabled: bool = True
    # 采样周期（秒）。60s 与告警巡检同档，一天约 1440 点/对象。
    metrics_sample_interval: int = 60
    # 保留天数。采样循环每小时清一次超期行；<= 0 表示永久保留（会一直涨）。
    metrics_retention_days: int = 30

    # --- 巡检快照落库 ------------------------------------------------------
    # 「端口与进程」「安全基线」的现场巡检结果按主机落一张快照表，读接口只读
    # 快照、现场巡检交给后台作业。详见 app/inspection.py。
    # 关掉即回到改造前行为：每次打开都现场巡检（调试 / 排查时可临时关闭）。
    inspection_snapshot_enabled: bool = True
    # 快照预热周期（秒）。与端口巡检同频（5 分钟）足够 —— 它决定「页面上的数据
    # 最多旧多少」，而不是响应速度。
    inspection_warm_interval: int = 300
    # 预热要落哪些语言（逗号分隔）。面板只有中英两种语言，默认都落 —— 否则
    # 英文界面的用户读不到对应语言的快照、每次都要回落真扫（等于没优化）。
    # 代价是每轮多跑一遍巡检；只想优化中文时改成 "zh-CN" 即可。
    inspection_warm_langs: str = "zh-CN,en"
    # 巡检租约时长（秒）：多 worker / 多实例部署时，同一轮预热只让一个进程真正
    # 去扫，其余跳过。单进程部署下它不起作用（也不会有副作用）。
    inspection_lease_seconds: int = 900
    # 客户机 IP 预热周期（秒）。与 guestip 的进程内缓存时长对齐（约 2 分钟），
    # 让虚拟机列表的 IP 列基本总能命中落库结果。
    guest_ip_warm_interval: int = 120

    # --- Database ----------------------------------------------------------
    # 面板只使用 MySQL：建表与补列在启动时自动完成。
    db_host: str = "127.0.0.1"
    db_port: int = 3306
    db_user: str = ""
    db_password: str = ""
    db_name: str = ""
    # 连接池上限（面板是单进程异步服务，8 足够）
    db_pool_size: int = 8
    # 空闲连接回收秒数。MySQL 默认 wait_timeout 是 8 小时，但中间的网络设备
    # 往往更早掐断空闲连接；定时回收一轮，避免借到一条已经死掉的连接。
    db_pool_recycle: int = 3600

    @model_validator(mode="after")
    def _reject_weak_secret_key(self) -> "Settings":
        """占位值 / 过短的 SECRET_KEY 直接拒绝启动，逼运维先配好再上线。"""
        key = (self.secret_key or "").strip()
        if not key or key in WEAK_SECRET_KEYS:
            raise ValueError(
                "SECRET_KEY 仍是源码或 .env.example 里的占位默认值，拒绝启动。"
                "它既是登录 JWT 的签名密钥，也是 crypto.py 密文存储的加密根 —— "
                "留默认值等于任何人都能伪造登录态、解出库里的密文。"
                ' 请在 backend/.env 里设置随机值：python -c "import secrets; '
                'print(secrets.token_urlsafe(48))"'
            )
        if len(key) < MIN_SECRET_KEY_LEN:
            raise ValueError(
                f"SECRET_KEY 只有 {len(key)} 位，短于 {MIN_SECRET_KEY_LEN} 位下限，拒绝启动。"
                "随机串可用：python -c \"import secrets; print(secrets.token_urlsafe(48))\""
            )
        return self

    @model_validator(mode="after")
    def _reject_allowlist_with_wildcard_proxy(self) -> "Settings":
        """白名单 + ``FORWARDED_ALLOW_IPS=*`` 是自欺欺人，直接拒绝启动。

        ``*`` 意味着任何客户端都能自己填 X-Forwarded-For；uvicorn 会据此改写
        ``scope["client"]``，白名单拿到的「来源 IP」完全由攻击者决定。与其让
        运维以为配了白名单，不如把矛盾在启动时摆出来。
        """
        allow = (self.panel_allow_cidrs or "").strip()
        proxies = {
            item.strip()
            for item in (self.forwarded_allow_ips or "").split(",")
            if item.strip()
        }
        if allow and "*" in proxies:
            raise ValueError(
                "PANEL_ALLOW_CIDRS 已启用，但 FORWARDED_ALLOW_IPS 含 '*'："
                "任何客户端都能伪造 X-Forwarded-For，白名单会被绕过。"
                "请把 FORWARDED_ALLOW_IPS 改成反向代理的实际地址（如 127.0.0.1 "
                "或 Docker 网关 172.18.0.1），再重启面板。"
            )
        return self

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def totp_required_role_list(self) -> List[str]:
        """必须开启两步验证的角色（TOTP_REQUIRED_ROLES，逗号分隔）。"""
        return [r.strip() for r in self.totp_required_roles.split(",") if r.strip()]

    @property
    def inspection_warm_lang_list(self) -> List[str]:
        """巡检快照预热要落库的语言（INSPECTION_WARM_LANGS，逗号分隔）。"""
        langs = [item.strip() for item in self.inspection_warm_langs.split(",") if item.strip()]
        return langs or ["zh-CN"]

    @property
    def secure_cookie(self) -> bool:
        """refresh cookie 是否只走 HTTPS：COOKIE_SECURE 留空则跟随 FORCE_HTTPS。"""
        if self.cookie_secure is None:
            return bool(self.force_https)
        return bool(self.cookie_secure)


settings = Settings()
