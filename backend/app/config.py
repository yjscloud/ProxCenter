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
    # 出站访问 Proxmox 时是否校验服务端证书。**生产默认开启**：默认关闭等于
    # 任何人在这台机器与 PVE 之间做个中间人就能拿到 API Token、劫持虚拟机。
    # PVE 默认安装用的是自签证书（或证书过期）时置为 false，或在设置页里
    # 对单条连接关闭并填 PVE 自签 CA。这是新建连接的默认值，已保存的连接
    # 始终按自己存的值走。
    pve_verify_ssl: bool = True
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

    # --- Database ----------------------------------------------------------
    # 面板只使用 MySQL：建表与补列在启动时自动完成。
    db_host: str = "127.0.0.1"
    db_port: int = 3306
    db_user: str = ""
    db_password: str = ""
    db_name: str = ""
    # 连接池上限（面板是单进程异步服务，8 足够）
    db_pool_size: int = 8

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

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def totp_required_role_list(self) -> List[str]:
        """必须开启两步验证的角色（TOTP_REQUIRED_ROLES，逗号分隔）。"""
        return [r.strip() for r in self.totp_required_roles.split(",") if r.strip()]

    @property
    def secure_cookie(self) -> bool:
        """refresh cookie 是否只走 HTTPS：COOKIE_SECURE 留空则跟随 FORCE_HTTPS。"""
        if self.cookie_secure is None:
            return bool(self.force_https)
        return bool(self.cookie_secure)


settings = Settings()
