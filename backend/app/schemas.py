"""Request/response models for the panel API."""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, Field, field_validator, model_validator

from .config import settings


# ------------------------------------------------------------------- auth
class LoginRequest(BaseModel):
    username: str
    password: str
    # 图形验证码；验证方式为「关闭」时不校验，字段可缺省
    captcha_id: str = ""
    captcha_code: str = ""
    # 滑块验证码：拖动结束时拼图块的水平位置（展示坐标 px）。
    # 与 captcha_code 二选一，用哪个由服务端的登录验证方式决定。
    captcha_x: Optional[float] = None


class UserOut(BaseModel):
    id: Optional[int] = None
    username: str
    role: str
    email: str = ""
    enabled: bool = True
    # 账号审批状态：active / pending / rejected
    status: str = "active"
    permissions: List[str] = Field(default_factory=list)
    # 是否已绑定两步验证（密钥本身永不返回）
    totp_enabled: bool = False


class LoginResponse(BaseModel):
    """登录结果。

    开了两步验证的账号第一次只拿到 ``mfa_token``（5 分钟内有效），要去
    ``POST /api/auth/login/2fa`` 补一次动态码才换得到 access_token。
    """

    # 需要第二步验证时为空
    access_token: str = ""
    token_type: str = "bearer"
    # 需要第二步验证时无 user
    user: Optional[UserOut] = None
    # 密码正确，但还要动态码
    mfa_required: bool = False
    # 第二步验证用的临时凭据
    mfa_token: str = ""
    # 该角色被要求开启两步验证但还没绑定，登录后先去绑定
    totp_setup_required: bool = False


class LoginMfaRequest(BaseModel):
    """登录第二步：mfa_token + 动态码（或一次性恢复码）。"""

    mfa_token: str
    code: str


class TotpCodeIn(BaseModel):
    code: str


class TotpDisableIn(BaseModel):
    """关闭两步验证：口令 + 当前动态码双确认（防止 token 被盗后直接关掉）。"""

    password: str
    code: str = ""


# ------------------------------------------------------------------ config
class ConnectionConfigIn(BaseModel):
    # 多连接：id/name 用于标识一条保存的 PVE 连接
    id: Optional[str] = None
    name: str = ""
    host: str = ""
    port: int = 8006
    token_id: str = ""
    # "__UNCHANGED__" keeps the stored secret; empty string also keeps it.
    token_secret: Optional[str] = None
    # 默认取 PVE_VERIFY_SSL（生产默认校验证书）；前端表单始终显式传值
    verify_ssl: bool = settings.pve_verify_ssl
    node_default: str = ""
    console_user: str = ""
    console_password: Optional[str] = None


class ConnectionTestIn(BaseModel):
    host: str
    port: int = 8006
    token_id: str = ""
    token_secret: Optional[str] = None
    verify_ssl: bool = settings.pve_verify_ssl


class VmDefaultsIn(BaseModel):
    """面板级创建默认值（目前只有默认 DNS）。空值 = 不干预。"""

    dns: str = ""


class SiteLinkIn(BaseModel):
    """一条友情链接。名称与地址缺一不可，后端会丢掉残缺项。"""

    name: str = ""
    url: str = ""


class MailConfigIn(BaseModel):
    """邮件通知（SMTP）配置。

    ``password`` 留空表示沿用已保存的密码，要清空得显式传 ``password_clear``
    —— 与 PVE 的 token_secret 同一套约定。
    """

    enabled: Optional[bool] = None
    host: Optional[str] = None
    port: Optional[int] = None
    # starttls（587）/ ssl（465）/ none（内网明文）
    tls: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    password_clear: bool = False
    sender: Optional[str] = None
    sender_name: Optional[str] = None
    verify_ssl: Optional[bool] = None
    # 注册 / 审批通知的收件人；留空则发给所有填了邮箱的管理员
    admin_recipients: Optional[str] = None


class ForgotPasswordIn(BaseModel):
    """自助重置密码第 1 步：提交用户名，面板给账号邮箱发一次性链接。"""

    username: str


class ResetTokenIn(BaseModel):
    """只带令牌：用于打开重置页面前先确认链接没失效。"""

    token: str


class ResetPasswordIn(BaseModel):
    """自助重置密码第 2 步：凭链接里的令牌设置新密码。"""

    token: str
    password: str = Field(min_length=8)


class VmQuotaIn(BaseModel):
    """虚拟机下发总配额。``None`` / 不传 value 表示「不限制」。"""

    quota: Optional[int] = None


class MailTestIn(BaseModel):
    """发送测试邮件。``to`` 留空时发给管理员收件人。"""

    to: str = ""


class PanelUrlIn(BaseModel):
    """面板全局地址：邮件等外发内容里拼链接用的对外域名。

    留空 = 清除配置，回落到「本次请求的 Host」（仅适合内网直连场景）。
    """

    url: str = ""


class SiteInfoIn(BaseModel):
    """站点信息（品牌名 / 副标题 / 版权 / 备案号 / 友情链接）。

    品牌三项留空 = 恢复内置默认值；备案号与友情链接留空 = 不展示。
    """

    name: str = ""
    subtitle: str = ""
    copyright: str = ""
    icp: str = ""
    links: List[SiteLinkIn] = Field(default_factory=list)


class FaqItemIn(BaseModel):
    """一条常见问题。问题与答案缺一不可，后端会丢掉残缺项。"""

    q: str = ""
    a: str = ""


class FaqIn(BaseModel):
    """常见问题列表。传空列表 = 关闭官网上的 FAQ 区块。"""

    items: List[FaqItemIn] = Field(default_factory=list)


class LoginCaptchaIn(BaseModel):
    """登录页的验证方式：off / image / slider（见 app/captcha.py）。"""

    mode: str


class UiPrefsIn(BaseModel):
    """面板级界面开关（服务端，全局生效，见 app/ui.py）。

    ``nav_disabled``：这些路径对应的导航栏入口被关闭（隐藏 + 路由弹回）。

    允许缺省（``None`` = 保持当前值），这样前端只提交改过的那一项也不会把
    其余设置重置。
    """

    nav_disabled: Optional[List[str]] = None


# -------------------------------------------------------------------- vms
class DiskSpec(BaseModel):
    storage: str
    size: int = Field(gt=0, description="Size in GB")
    interface: str = "scsi0"
    format: str = "raw"
    discard: bool = False
    ssd: bool = False


class NetworkSpec(BaseModel):
    bridge: str = "vmbr0"
    model: str = "virtio"
    vlan_tag: Optional[int] = None
    firewall: bool = False
    macaddr: Optional[str] = None
    rate: Optional[float] = None


class VmAddDisk(DiskSpec):
    """给已有虚拟机新增一块磁盘。

    ``interface`` 留空时由后端挑第一个空闲的 scsi 槽位 —— 前端不需要知道
    这台机器现有的磁盘占了哪些槽，也就不会出现「删掉 scsi0 再新增」时撞键。
    """

    interface: Optional[str] = None


class VmAddNetwork(NetworkSpec):
    """给已有虚拟机新增一张网卡，键名（netN）同样由后端挑空位。"""

    interface: Optional[str] = None


class IpConfig(BaseModel):
    ip: str = "dhcp"          # "dhcp" or "192.168.1.50/24"
    gateway: Optional[str] = None
    ipv6: Optional[str] = None


class CloudInitSpec(BaseModel):
    enabled: bool = False
    user: Optional[str] = None
    password: Optional[str] = None
    ssh_keys: Optional[str] = None
    ip_configs: List[IpConfig] = Field(default_factory=list)
    nameserver: Optional[str] = None
    searchdomain: Optional[str] = None


class CloneSpec(BaseModel):
    vmid: int
    node: str
    # 默认链接克隆：以源磁盘为 backing file 增量生成，秒级完成、几乎不占空间
    full: bool = False
    target_storage: Optional[str] = None
    target_node: Optional[str] = None
    # 克隆完成后是否自动开机（默认开）。
    start: bool = True


class NumaNodeSpec(BaseModel):
    """一个 NUMA 节点的绑定（对应 PVE 的 ``numaN``）。

    真实部署里「把虚拟机的 vCPU 钉在宿主机的某几个 NUMA 节点上」是绕不开的：
    不钉的话调度器会让 vCPU 跨节点访存，延迟敏感型负载（数据库、缓存）的尾延迟
    会抖得很厉害。``cpus`` 是必填的 —— PVE 要求每个 NUMA 节点显式声明自己拿到
    哪些逻辑 CPU。
    """

    # 本节点分到的逻辑 CPU，如 "0-3,8-11"（PVE 的 cpuset 写法）
    cpus: str
    # 本节点的内存（MB）。留空时按 NUMA 节点数均分虚拟机总内存
    memory: Optional[int] = Field(default=None, gt=0)
    # 绑定的宿主机 NUMA 节点，如 "0" / "0-1"。留空 = 只做虚拟机内部拓扑，不绑定物理节点
    hostnodes: Optional[str] = None
    # 内存分配策略（bind / interleave / preferred），仅在给了 hostnodes 时有意义
    policy: Optional[str] = None


class EfiDiskSpec(BaseModel):
    """EFI 变量盘（PVE 的 ``efidisk0``）。Windows 11 必需。

    走的是「存储 + 容量」形式（``local-lvm:1``）而不是卷 ID：PVE 会自己开一块
    变量盘，与界面上勾「EFI 磁盘」等价，不需要像导入镜像那样先分配卷再挂载。
    """

    storage: str
    # 4m 才能用 pre-enrolled-keys（Win11 的安全启动依赖它）
    efitype: str = "4m"
    pre_enrolled_keys: bool = True
    # EFI 变量盘极小，1MB 足够
    size: int = Field(default=1, ge=1, le=64)


class TpmSpec(BaseModel):
    """虚拟 TPM（PVE 的 ``tpmstate0``）。Windows 11 必需。"""

    storage: str
    version: str = "v2.0"
    # PVE 的 TPM 状态盘最小 4MB
    size: int = Field(default=4, ge=4, le=64)


class VmCreateRequest(BaseModel):
    """Create a VM: blank, from a cloud image, or as a clone.

    A few fields accept aliases so the frontend's camelCase spelling and the
    backend's snake_case spelling both work — the API contract is consumed by
    two codebases and a mismatch here silently skips a feature.
    """

    model_config = {"populate_by_name": True}

    node: str
    vmid: Optional[int] = None
    name: str
    memory: int = Field(default=2048, ge=16)
    cores: int = Field(default=2, ge=1)
    sockets: int = Field(default=1, ge=1)
    cpu_type: str = "host"
    ostype: str = "l26"
    bios: str = "seabios"
    machine: str = "pc"
    scsihw: str = Field(default="virtio-scsi-single", alias="scsi_hw")
    disks: List[DiskSpec] = Field(default_factory=list)
    networks: List[NetworkSpec] = Field(default_factory=list)
    iso: Optional[str] = None
    boot_order: Optional[str] = None
    start_on_boot: bool = False
    agent: bool = True
    # 内存气球的最低保留量（MiB）。PVE 在配置里没有这个键时按「整份内存」算 ——
    # 宿主机即使看到客户机空闲也收不回内存（实测 qemu/109 的 balloon = maxmem）。
    # 语义：None = 不下发，沿用 PVE 默认（不回收）；0 = 显式关掉气球驱动；
    # 其它值 = 保留这么多，余量可在宿主机内存紧张时收回（客户机需装气球驱动）。
    balloon: Optional[int] = None
    tags: Optional[str] = None
    description: Optional[str] = None
    cloudinit: Optional[CloudInitSpec] = None
    clone_from: Optional[CloneSpec] = None

    # ---- 高级硬件（都可选）-------------------------------------------------
    # 开启 NUMA（对应 PVE 的 numa=1）。只开这个 = 给客户机呈现 NUMA 拓扑，
    # 不把 vCPU 钉到宿主机的具体节点上。
    numa: bool = False
    # 逐节点的绑定（numa0 / numa1 / ...）。给了这个就必然开 numa。
    numa_nodes: List[NumaNodeSpec] = Field(default_factory=list)
    # CPU 亲和性（PVE 的 affinity）：整台虚拟机允许落在哪些逻辑 CPU 上，如 "0-7"。
    # 与 NUMA 是两件事 —— 它是整机级别的宿主 CPU 限定，不含内存绑定。
    affinity: Optional[str] = None
    # Windows 11 必需的两件套：EFI 变量盘 + 虚拟 TPM。
    # 给任一项时后端会把固件校准成 OVMF + q35（否则机器建出来起不来）。
    efi_disk: Optional[EfiDiskSpec] = None
    tpm: Optional[TpmSpec] = None

    # When true the created VM is converted into a template after setup.
    template_mode: bool = Field(default=False, alias="templateMode")
    # Optional cloud image to import as the system disk (template pipeline).
    # Accepts either spelling.
    cloud_image: Optional[str] = Field(default=None, alias="source_image")

    @field_validator("name")
    @classmethod
    def _name_valid(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("虚拟机名称不能为空")
        if len(cleaned) > 63:
            raise ValueError("虚拟机名称不能超过 63 个字符")
        return cleaned


class VmConfigUpdate(BaseModel):
    """Arbitrary PVE config keys; validated by Proxmox itself."""

    model_config = {"extra": "allow"}

    memory: Optional[int] = None
    cores: Optional[int] = None
    sockets: Optional[int] = None
    cpu: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[str] = None
    onboot: Optional[int] = None
    protection: Optional[int] = None
    boot: Optional[str] = None

    # 下面这些原本靠 extra:allow 也能透传，显式列出来是为了让 OpenAPI 文档
    # 与详情页的「可编辑项」对得上 —— 否则前端加的字段在后端 schema 里查无此物。
    balloon: Optional[int] = None
    cpuunits: Optional[int] = None
    ostype: Optional[str] = None
    scsihw: Optional[str] = None
    bios: Optional[str] = None
    machine: Optional[str] = None
    # NUMA / 亲和性：numa 是开关，numaN 是逐节点定义（值形如
    # "cpus=0-3,memory=4096,hostnodes=0,policy=bind"，带逗号，按字符串透传）
    numa: Optional[int] = None
    numa0: Optional[str] = None
    numa1: Optional[str] = None
    numa2: Optional[str] = None
    numa3: Optional[str] = None
    affinity: Optional[str] = None
    # EFI 变量盘 / 虚拟 TPM：值同样是 PVE 的复合串（"local-lvm:1,efitype=4m,..."）
    efidisk0: Optional[str] = None
    tpmstate0: Optional[str] = None


class VmOwnerIn(BaseModel):
    """把虚拟机指派给某个用户。"""

    # 空字符串 / null 表示清除归属（回到无主状态）
    username: Optional[str] = None
    # 目标 PVE 连接；不传则用当前连接
    connection_id: Optional[str] = None


class ResizeRequest(BaseModel):
    disk: str
    size: str  # e.g. "20G" or "+10G"


class MoveDiskRequest(BaseModel):
    disk: str
    storage: str
    delete_source: bool = True


class MigrateRequest(BaseModel):
    target_node: str
    online: bool = True


class PowerRequest(BaseModel):
    timeout: Optional[int] = None
    force_stop: bool = False


class CloneRequest(BaseModel):
    newid: int
    name: Optional[str] = None
    full: bool = True
    target_storage: Optional[str] = None
    target_node: Optional[str] = None
    description: Optional[str] = None


class IpConfigRequest(BaseModel):
    ipconfig0: Optional[str] = None
    ipconfig1: Optional[str] = None
    ipconfig2: Optional[str] = None
    ipconfig3: Optional[str] = None
    nameserver: Optional[str] = None
    searchdomain: Optional[str] = None
    ciuser: Optional[str] = None
    cipassword: Optional[str] = None
    sshkeys: Optional[str] = None

    model_config = {"extra": "allow"}


# ------------------------------------------------------------------- lxc
class LxcNetworkSpec(BaseModel):
    """容器网卡（``net0``）。

    与虚拟机网卡最大的差别：容器没有「网卡型号」——``name`` 是**容器内的**
    接口名（eth0 / eth1 …），IP 直接写在网卡行里（``ip=`` / ``ip6=``），
    因为容器没有 cloud-init 去下发地址。
    """

    bridge: str = "vmbr0"
    # 容器内的接口名；留空由后端按序号分配 eth0 / eth1 …
    name: str = ""
    # dhcp | manual | 192.168.1.50/24
    ip: str = "dhcp"
    gateway: Optional[str] = None
    # dhcp | auto | static | <IPv6/CIDR>；留空表示不配 IPv6
    ip6: str = ""
    gateway6: Optional[str] = None
    vlan_tag: Optional[int] = None
    firewall: bool = False
    hwaddr: Optional[str] = None
    rate: Optional[float] = None
    mtu: Optional[int] = None


class LxcMountSpec(BaseModel):
    """容器挂载点（``mp0``）—— 给容器额外挂一块数据盘。"""

    storage: str
    size: int = Field(gt=0, description="Size in GB")
    mp: str = Field(description="容器内的挂载路径，如 /data")
    interface: Optional[str] = None
    backup: bool = False
    acl: bool = False


class LxcSetupSpec(BaseModel):
    """容器初始化。没有 cloud-init，只能给 root 口令与 SSH 公钥。"""

    password: Optional[str] = None
    # 多行粘贴；后端按 PVE 要求做 URL 编码后写 ssh-public-keys
    ssh_keys: Optional[str] = None
    nameserver: Optional[str] = None
    searchdomain: Optional[str] = None


class LxcCreateRequest(BaseModel):
    """创建 LXC 容器。

    必需项与 ``pct create`` 一致：``ostemplate``（模板 volid）+ ``storage``
    （rootfs 落在哪个存储）+ ``rootfs`` 容量。
    """

    model_config = {"populate_by_name": True}

    node: str
    vmid: Optional[int] = None
    # 容器主机名。同时接受 name（前端习惯）与 hostname（PVE 命名）
    hostname: str = Field(default="", alias="name")
    # 系统模板，形如 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst
    ostemplate: str
    storage: str
    # rootfs 容量，单位 GB
    rootfs: int = Field(default=8, gt=0)
    memory: int = Field(default=512, ge=16)
    swap: int = Field(default=0, ge=0)
    cores: int = Field(default=1, ge=1)
    cpulimit: Optional[float] = None
    cpuunits: Optional[int] = None
    unprivileged: bool = True
    features: List[str] = Field(default_factory=list)
    ostype: Optional[str] = None
    networks: List[LxcNetworkSpec] = Field(default_factory=list)
    mounts: List[LxcMountSpec] = Field(default_factory=list)
    setup: Optional[LxcSetupSpec] = None
    start_on_boot: bool = False
    protection: bool = False
    tags: Optional[str] = None
    description: Optional[str] = None
    # 创建完成后是否立即启动
    start: bool = True

    @field_validator("hostname")
    @classmethod
    def _hostname_valid(cls, value: str) -> str:
        cleaned = (value or "").strip()
        # 前端按 VmCreateRequest 的习惯传 name，两种拼写都要能落到 hostname
        if not cleaned:
            raise ValueError("容器名称不能为空")
        if len(cleaned) > 63:
            raise ValueError("容器名称不能超过 63 个字符")
        return cleaned

    @field_validator("features")
    @classmethod
    def _features_valid(cls, value: List[str]) -> List[str]:
        allowed = {"nesting", "keyctl", "fuse", "mknod", "mount"}
        return [v for v in value if v in allowed]


class LxcConfigUpdate(BaseModel):
    """任意 PVE 容器配置键；合法性交给 Proxmox 自己校验。"""

    model_config = {"extra": "allow"}

    hostname: Optional[str] = None
    memory: Optional[int] = None
    swap: Optional[int] = None
    cores: Optional[int] = None
    cpulimit: Optional[float] = None
    cpuunits: Optional[int] = None
    description: Optional[str] = None
    tags: Optional[str] = None
    onboot: Optional[int] = None
    protection: Optional[int] = None
    nameserver: Optional[str] = None
    searchdomain: Optional[str] = None


class LxcAddNetwork(LxcNetworkSpec):
    """给已有容器加一张网卡，键名（netN）由后端挑空位。"""

    interface: Optional[str] = None


class LxcAddMount(LxcMountSpec):
    """给已有容器加一个挂载点，键名（mpN）由后端挑空位。"""

    interface: Optional[str] = None


class LxcResizeRequest(BaseModel):
    """扩容 rootfs / mpN。size 支持绝对值（20G）与增量（+10G）。"""

    disk: str = "rootfs"
    size: str


class LxcMoveRequest(BaseModel):
    volume: str = "rootfs"
    storage: str
    delete_source: bool = True


class LxcMigrateRequest(BaseModel):
    target_node: str
    online: bool = True
    restart: bool = False


class LxcCloneRequest(BaseModel):
    newid: int
    hostname: Optional[str] = None
    target_storage: Optional[str] = None
    target_node: Optional[str] = None
    description: Optional[str] = None


# ---------------------------------------------------------------- snapshots
class SnapshotCreate(BaseModel):
    name: str
    description: str = ""
    vmstate: bool = False

    @field_validator("name")
    @classmethod
    def _snap_valid(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("快照名称不能为空")
        if not all(c.isalnum() or c in "-_" for c in cleaned):
            raise ValueError("快照名称只能包含字母、数字、连字符和下划线")
        return cleaned


# ------------------------------------------------------------------ bulk ops
class BulkTarget(BaseModel):
    """批量操作的一台目标机器。"""

    node: str
    vmid: int
    # qemu / lxc。留空时后端按 PVE 探测 —— 前端列表里已经有 type，带上能省一轮请求
    type: Optional[str] = None
    # 仅用于结果回显，不参与定位
    name: Optional[str] = None


class BulkParams(BaseModel):
    """按 action 取用的附加参数；用不到的字段留空即可。"""

    # power（stop / shutdown）
    timeout: Optional[int] = None
    force_stop: bool = False
    # delete
    purge: bool = True
    # tag
    tags: Optional[str] = None
    # replace = 覆盖原标签；append = 在原有标签后追加
    tag_mode: str = "replace"
    # balloon：内存气球的最低保留量（MiB）。0 = 关掉气球驱动；只对虚拟机有效
    balloon: Optional[int] = None
    # migrate
    target_node: Optional[str] = None
    online: bool = True
    # snapshot
    name: Optional[str] = None
    description: str = ""
    vmstate: bool = False


class BulkRequest(BaseModel):
    """对一批虚拟机 / 容器执行同一个操作。

    与其它写接口不同，这个接口**不抛整批失败**：逐台执行、逐台回报，
    HTTP 200 表示「请求本身合法」，成败看 ``results`` 里每一项的 ``ok``。
    """

    action: str
    targets: List[BulkTarget]
    params: BulkParams = BulkParams()

    @field_validator("action")
    @classmethod
    def _action_valid(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("操作不能为空")
        return cleaned

    @field_validator("targets")
    @classmethod
    def _targets_valid(cls, value: List[BulkTarget]) -> List[BulkTarget]:
        if not value:
            raise ValueError("请至少选择一台机器")
        if len(value) > 200:
            raise ValueError("单次批量操作最多 200 台，请分批执行")
        seen = set()
        for item in value:
            key = (item.node, item.vmid)
            if key in seen:
                raise ValueError(f"目标重复：{item.node}/{item.vmid}")
            seen.add(key)
        return value


# ------------------------------------------------------------------ network
class NetworkUpsert(BaseModel):
    iface: str
    type: str = "bridge"          # bridge | bond | eth | vlan | OVSBridge
    address: Optional[str] = None
    netmask: Optional[str] = None
    cidr: Optional[str] = None
    gateway: Optional[str] = None
    bridge_ports: Optional[str] = None
    bridge_vlan_aware: Optional[bool] = None
    bond_mode: Optional[str] = None
    bond_slaves: Optional[str] = None
    vlan_id: Optional[int] = None
    vlan_raw_device: Optional[str] = None
    autostart: bool = True
    comments: Optional[str] = None
    mtu: Optional[int] = None


class IpPool(BaseModel):
    """一段可分配给虚拟机的静态地址范围（不依赖 DHCP/SDN）。

    ``subnet`` 决定地址掩码（如 192.168.1.0/24），``start``/``end`` 限定的
    区间内未被占用的地址，会在创建 / 克隆虚拟机时作为下拉选项给出。
    """

    id: str = ""
    name: str = ""
    bridge: str = ""
    subnet: str = ""          # 192.168.1.0/24
    gateway: str = ""
    start: str = ""           # 192.168.1.100
    end: str = ""             # 192.168.1.200
    dns: str = ""


# ---------------------------------------------------------------- firewall
# PVE 原生防火墙的入参模型。字段名刻意与 PVE API 一致（proto / dport / source…），
# 免得每次调用再翻译一层；取值也照着 PVE 的枚举收紧，把明显写错的规则挡在入口。
FW_ACTIONS = ("ACCEPT", "DROP", "REJECT")
FW_TYPES = ("in", "out", "group")
FW_PROTOS = (
    "",
    "tcp",
    "udp",
    "icmp",
    "ipv6-icmp",
    "igmp",
    "esp",
    "ah",
    "gre",
    "sctp",
    "udplite",
    "dccp",
)
FW_LOG_LEVELS = ("nolog", "emerg", "alert", "crit", "err", "warning", "notice", "info", "debug")
# PVE 的端口写法：单个、逗号分隔、或 start:end 区间（可混用）
_PORT_RE = re.compile(r"^\d+(?::\d+)?(?:,\d+(?::\d+)?)*$")
# 安全组名：PVE 要求以字母开头，只允许字母数字与 _ -
_GROUP_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,17}$")
_IPSET_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,17}$")


def _check_ports(value: str, field: str) -> str:
    text = (value or "").strip()
    if not text:
        return ""
    if not _PORT_RE.match(text):
        raise ValueError(f"{field} 只能是端口、逗号分隔或 start:end 区间，如 22 或 8000:8100")
    return text


class FirewallRuleIn(BaseModel):
    """一条防火墙规则（集群 / 节点 / 虚拟机 / 安全组通用）。

    ``type=group`` 表示「引用某个安全组」，此时 ``group`` 必填，其余匹配字段忽略。
    """

    type: str = "in"
    action: str = "ACCEPT"
    enable: bool = True
    proto: str = ""
    dport: str = ""
    sport: str = ""
    source: str = ""
    dest: str = ""
    macro: str = ""
    iface: str = ""
    log: str = "nolog"
    comment: str = ""
    group: str = ""
    # 插入到第几条（PVE 的 pos 从 0 开始）；留空 = 追加到末尾
    pos: Optional[int] = Field(default=None, ge=0)

    @field_validator("type")
    @classmethod
    def _type(cls, v: str) -> str:
        text = (v or "").strip().lower()
        if text not in FW_TYPES:
            raise ValueError(f"规则方向只能是 {'/'.join(FW_TYPES)}")
        return text

    @field_validator("action")
    @classmethod
    def _action(cls, v: str) -> str:
        text = (v or "").strip().upper()
        if text not in FW_ACTIONS:
            raise ValueError(f"动作只能是 {'/'.join(FW_ACTIONS)}")
        return text

    @field_validator("proto")
    @classmethod
    def _proto(cls, v: str) -> str:
        text = (v or "").strip().lower()
        if text not in FW_PROTOS:
            raise ValueError(f"不支持的协议：{v}（留空表示任意）")
        return text

    @field_validator("log")
    @classmethod
    def _log(cls, v: str) -> str:
        text = (v or "").strip().lower() or "nolog"
        if text not in FW_LOG_LEVELS:
            raise ValueError(f"不支持的日志级别：{v}")
        return text

    @field_validator("dport", "sport")
    @classmethod
    def _ports(cls, v: str, info) -> str:
        return _check_ports(v, "端口")

    @field_validator("macro")
    @classmethod
    def _macro(cls, v: str) -> str:
        # 保留原样大小写：PVE 的宏名区分大小写（MySQL 不是 MYSQL）
        text = (v or "").strip()
        if text and not re.match(r"^[A-Za-z0-9_-]{1,64}$", text):
            raise ValueError("宏名称只能是字母、数字、下划线或短横线")
        return text

    @field_validator("comment")
    @classmethod
    def _comment(cls, v: str) -> str:
        return (v or "").strip()[:255]

    @field_validator("source", "dest", "iface", "group")
    @classmethod
    def _short(cls, v: str) -> str:
        return (v or "").strip()[:128]

    @model_validator(mode="after")
    def _group_required(self) -> "FirewallRuleIn":
        if self.type == "group":
            if not self.group:
                raise ValueError("引用安全组时必须指定安全组名")
            if not _GROUP_RE.match(self.group):
                raise ValueError("安全组名非法：以字母开头，只允许字母、数字、_ 和 -")
        # 端口/协议只在非安全组引用时才有意义，避免把无效组合写进集群
        if self.type == "group":
            self.proto = ""
            self.dport = ""
            self.sport = ""
        return self


class FirewallOptionsIn(BaseModel):
    """作用域级开关与默认策略。只提交需要改的字段（None = 不动）。"""

    enable: Optional[bool] = None
    policy_in: Optional[str] = None
    policy_out: Optional[str] = None
    log_level_in: Optional[str] = None
    log_level_out: Optional[str] = None
    # 节点 / 集群
    ebtables: Optional[bool] = None
    # 虚拟机 / 容器
    dhcp: Optional[bool] = None
    ipfilter: Optional[bool] = None
    macfilter: Optional[bool] = None
    ndp: Optional[bool] = None
    radv: Optional[bool] = None

    @field_validator("policy_in", "policy_out")
    @classmethod
    def _policy(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        text = v.strip().upper()
        if text not in FW_ACTIONS:
            raise ValueError(f"默认策略只能是 {'/'.join(FW_ACTIONS)}")
        return text

    @field_validator("log_level_in", "log_level_out")
    @classmethod
    def _level(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        text = v.strip().lower()
        if text not in FW_LOG_LEVELS:
            raise ValueError(f"不支持的日志级别：{v}")
        return text


class FirewallGroupIn(BaseModel):
    group: str
    comment: str = ""

    @field_validator("group")
    @classmethod
    def _name(cls, v: str) -> str:
        text = (v or "").strip()
        if not _GROUP_RE.match(text):
            raise ValueError("安全组名以字母开头，最长 18 位，只允许字母、数字、_ 和 -")
        return text

    @field_validator("comment")
    @classmethod
    def _comment(cls, v: str) -> str:
        return (v or "").strip()[:255]


class FirewallIpsetIn(BaseModel):
    name: str
    comment: str = ""

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        text = (v or "").strip()
        if not _IPSET_RE.match(text):
            raise ValueError("IP 集合名以字母开头，最长 18 位，只允许字母、数字、_ 和 -")
        return text

    @field_validator("comment")
    @classmethod
    def _comment(cls, v: str) -> str:
        return (v or "").strip()[:255]


class FirewallIpsetEntryIn(BaseModel):
    cidr: str
    comment: str = ""
    # 取反匹配（PVE 的 nomatch）
    nomatch: bool = False

    @field_validator("cidr")
    @classmethod
    def _cidr(cls, v: str) -> str:
        text = (v or "").strip()
        if not text:
            raise ValueError("请填写 IP 或网段，如 10.0.0.5 或 10.0.0.0/24")
        return text[:128]


class FirewallTemplateIn(BaseModel):
    """规则模板：面板自己存的一组规则，可批量下发到多台虚拟机。"""

    id: str = ""
    name: str = ""
    description: str = ""
    # 下发时是否同时打开目标 VM 的防火墙开关
    enable: bool = True
    policy_in: Optional[str] = None
    policy_out: Optional[str] = None
    rules: List[FirewallRuleIn] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        text = (v or "").strip()
        if not text:
            raise ValueError("请填写模板名称")
        return text[:64]

    @field_validator("description")
    @classmethod
    def _desc(cls, v: str) -> str:
        return (v or "").strip()[:255]

    @field_validator("policy_in", "policy_out")
    @classmethod
    def _policy(cls, v: Optional[str]) -> Optional[str]:
        if v is None or not v.strip():
            return None
        text = v.strip().upper()
        if text not in FW_ACTIONS:
            raise ValueError(f"默认策略只能是 {'/'.join(FW_ACTIONS)}")
        return text


class FirewallTarget(BaseModel):
    """批量下发的目标：一台虚拟机（容器同样适用）。"""

    node: str
    vmid: int
    # qemu / lxc；留空由面板查集群资源判断
    type: str = ""


class FirewallApplyIn(BaseModel):
    targets: List[FirewallTarget]
    # 是否先清空目标机现有的规则（默认覆盖式下发）
    replace: bool = True

    @field_validator("targets")
    @classmethod
    def _targets(cls, v: List[FirewallTarget]) -> List[FirewallTarget]:
        if not v:
            raise ValueError("请至少选择一台虚拟机")
        if len(v) > 200:
            raise ValueError("一次最多下发 200 台虚拟机")
        return v


# ------------------------------------------------------------------ backups
class BackupCreate(BaseModel):
    node: str
    vmid: Optional[int] = None
    storage: str
    mode: str = "snapshot"
    compress: str = "zstd"
    notes: Optional[str] = None
    all: bool = False


class BackupRestore(BaseModel):
    node: str
    volid: str
    vmid: int
    storage: Optional[str] = None
    force: bool = True
    start: bool = False


class BackupJobCreate(BaseModel):
    schedule: str = "02:00"
    storage: str
    node: Optional[str] = None
    vmid: Optional[str] = None      # comma-separated list
    mode: str = "snapshot"
    compress: str = "zstd"
    enabled: bool = True
    notes: Optional[str] = None
    all: bool = False
    comment: Optional[str] = None
    mailnotification: Optional[str] = None
    prune_backups: Optional[str] = None
    dow: Optional[str] = None
    starttime: Optional[str] = None


# -------------------------------------------------------------------- users
class UserCreate(BaseModel):
    username: str
    # 与注册 / 自助改密同一套强度（security.password_policy_error 还会再校验
    # 字母 + 数字与常见弱口令）；以前这里只要求 6 位，比注册还弱，等于后门。
    password: str = Field(min_length=8, max_length=128)
    # 角色 id（内置 admin/operator/viewer 或 admin 自建的角色）
    role: str = "viewer"
    email: str = ""
    # 用户级权限覆盖：不传 = 继承角色；传列表（含空列表）= 以它为准
    permissions: Optional[List[str]] = None


class UserUpdate(BaseModel):
    role: Optional[str] = None
    email: Optional[str] = None
    enabled: Optional[bool] = None
    # 留空 = 不改密码；给了值就按统一强度校验（见 users.update_user）
    password: Optional[str] = Field(default=None, min_length=8, max_length=128)
    permissions: Optional[List[str]] = None
    # 与 permissions 配对：仅当它为 true 时才改动用户级覆盖
    # （用于区分「不改」和「清空覆盖、回到继承角色」）
    set_permissions: bool = False
    # 审批状态：active / pending / rejected。管理员可用它恢复已被拒绝的注册。
    status: Optional[str] = None


class RegisterRequest(BaseModel):
    """自助注册。建出来的账号是 pending，管理员审批通过后才能登录。"""

    username: str
    # 与管理员建号 / 改密同一套强度：8 位起，且要字母 + 数字、不是常见弱口令
    password: str = Field(min_length=8, max_length=128)
    # 必填：审批结果（通过 / 拒绝）会发到这个邮箱
    email: str


class ApprovalRequest(BaseModel):
    """管理员审批注册申请：通过的同时直接定好角色与权限。"""

    role: str = "viewer"
    # 与 UserUpdate 同义：None = 继承角色；列表（含空列表）= 以它为准
    permissions: Optional[List[str]] = None
    set_permissions: bool = False
    # 拒绝时的理由，写进审计日志
    reason: str = ""


class ProfileUpdate(BaseModel):
    """自助修改个人信息（仅邮箱；用户名与角色由管理员维护）。"""

    email: str = ""


class StepUpRequest(BaseModel):
    """敏感操作前的二次确认：登录密码（开了 2FA 还要动态码 / 一张恢复码）。"""

    password: str
    totp_code: Optional[str] = None


class PasswordChange(BaseModel):
    """自助修改密码：必须提供当前密码，新密码至少 8 位且含字母与数字。

    开了两步验证的账号还要带一次动态码 —— 密码是「改密」这件事的第一重，
    动态码是第二重：只有一枚被盗的 access token 不足以接管账号。
    """

    current_password: str
    new_password: str = Field(min_length=8)
    totp_code: str = ""


class RoleIn(BaseModel):
    """自定义角色：角色 = 一组权限的命名预设。"""

    id: Optional[str] = None
    name: str = ""
    description: str = ""
    permissions: List[str] = Field(default_factory=list)


# ----------------------------------------------------------------- template
class TemplateFromImage(BaseModel):
    """Build a cloud-init template from an uploaded/downloaded cloud image."""

    node: str
    name: str
    vmid: Optional[int] = None
    image: str                      # volid of the .img on a PVE storage
    storage: str                    # where the VM disk lands
    memory: int = 2048
    cores: int = 2
    # 内存气球的最低保留量（MiB）。模板设了它，克隆出来的机器才有可回收的余量
    balloon: Optional[int] = None
    cpu_type: str = "host"
    ostype: str = "l26"
    disk_size: Optional[int] = None  # GB, to grow the imported disk
    bridge: str = "vmbr0"
    net_model: str = "virtio"
    scsihw: str = "virtio-scsi-single"
    bios: str = "seabios"
    machine: str = "pc"
    ci_user: str = "ubuntu"
    ci_password: Optional[str] = None
    ssh_keys: Optional[str] = None
    nameserver: Optional[str] = None
    tags: str = "template,cloud-init"
    description: str = ""
    start_on_boot: bool = False


class TemplateFromVm(BaseModel):
    node: str
    vmid: int
    shutdown: bool = True
    shutdown_timeout: int = 120


class TemplateClone(BaseModel):
    source_node: str
    source_vmid: int
    target_node: Optional[str] = None
    newid: Optional[int] = None
    name: str
    # 模板克隆默认链接克隆（依赖模板磁盘，模板删除后克隆体不可用）
    full: bool = False
    storage: Optional[str] = None
    memory: Optional[int] = None
    cores: Optional[int] = None
    # 内存气球的最低保留量（MiB）：模板/来源机器自带的值会绑死克隆体，这里可覆盖
    balloon: Optional[int] = None
    ci_user: Optional[str] = None
    ci_password: Optional[str] = None
    ssh_keys: Optional[str] = None
    ip_config: Optional[str] = None      # e.g. "ip=dhcp" or "ip=10.0.0.5/24,gw=10.0.0.1"
    nameserver: Optional[str] = None
    description: Optional[str] = None
    start: bool = True


# -------------------------------------------------------------------- ssh
class SshPolicyIn(BaseModel):
    """SSH 异常登录策略（面板级，管理员维护）。"""

    enabled: bool = True
    window_hours: int = Field(default=24, ge=1, le=168)
    max_failures: int = Field(default=20, ge=1, le=10000)
    alert_unknown_ip: bool = True
    cooldown_minutes: int = Field(default=60, ge=1, le=1440)
    # 告警接收人（留空 = 第一个管理员）
    notify_user: str = ""
    # fail2ban 里要操作的 jail
    jail: str = ""
    # 不参与统计的来源（跳板机、监控探针等），逗号分隔
    ignore_ips: str = ""


class SshHostOwnerIn(BaseModel):
    """指派受管主机的归属。``username`` 留空 = 收回（收回后仅管理员可见）。"""

    username: str = ""


class SshHostIn(BaseModel):
    """一台受管主机（远程节点的 SSH 凭据）。

    ``secret`` 留空表示沿用旧值：口令与私钥一样是密钥，接口永远不回传明文。
    """

    id: Optional[str] = None
    name: str = ""
    host: str = ""
    port: int = Field(default=22, ge=1, le=65535)
    username: str = ""
    auth_type: str = Field(default="key", pattern="^(key|password)$")
    secret: str = ""
    use_sudo: bool = False
    log_source: str = Field(default="auto", pattern="^(auto|journalctl|secure|auth.log)$")
    enabled: bool = True
    known_host: str = ""


class SshJailPolicyIn(BaseModel):
    """自定义 fail2ban 封禁策略：写面板托管的 jail 片段并 reload。"""

    jail: str = Field(min_length=1, max_length=32)
    maxretry: int = Field(default=5, ge=1, le=100)
    findtime: int = Field(default=600, ge=60, le=86400, description="统计窗口（秒）")
    bantime: int = Field(default=3600, ge=60, le=31536000, description="封禁时长（秒）")


class SshTargetIn(BaseModel):
    """对某个 jail 里的某个 IP 做操作。"""

    jail: str = Field(min_length=1, max_length=32)
    ip: str = Field(min_length=3, max_length=45)


class SshKnownIpIn(BaseModel):
    """把 IP 标记为已知（消掉「陌生 IP 登录」告警）。"""

    ip: str = Field(min_length=3, max_length=45)
    note: str = ""


# ---------------------------------------------------------------- 安全基线
class BaselineFixIn(BaseModel):
    """一键加固单个检查项。``host_id`` 为 ``local``（面板所在主机）或受管主机 id。"""

    key: str = Field(min_length=1, max_length=64)
    host_id: str = Field(default="local", max_length=64)


class BaselineFixAllIn(BaseModel):
    """批量加固：``keys`` 为空表示自动挑出所有可修复的失败项。"""

    keys: List[str] = Field(default_factory=list)
    host_id: str = Field(default="local", max_length=64)


# ---------------------------------------------------------------- 应急隔离
class QuarantineIn(BaseModel):
    """一键隔离一台可疑虚拟机。默认「先取证快照，再断网，再优雅关机」。"""

    # 取证快照：必须在处置之前拍，否则机器一关，现场就没了
    snapshot: bool = True
    cut_network: bool = True
    # none = 只断网不关机；shutdown = 优雅关机；stop = 强制关机（可能丢数据）
    power_action: str = Field(default="shutdown", pattern="^(none|shutdown|stop)$")
    # 给 VM 打上保护标记，防止慌乱中把证据机误删
    protect: bool = True
    note: str = Field(default="", max_length=500)


class QuarantineReleaseIn(BaseModel):
    """解除隔离。"""

    restore_network: bool = True
    unprotect: bool = True
    power_on: bool = False
    note: str = Field(default="", max_length=500)


# ---------------------------------------------------------------- 备份防护
class BackupProtectIn(BaseModel):
    """把一个备份卷登记为「受保护」（面板层禁止删除 + 定期核对告警）。"""

    node: str = Field(min_length=1, max_length=128)
    storage: str = Field(min_length=1, max_length=128)
    volid: str = Field(min_length=1, max_length=255)
    vmid: Optional[int] = None
    note: str = Field(default="", max_length=255)


# ------------------------------------------------------------ 端口 / 进程巡检
class PortDispositionIn(BaseModel):
    """一条人工处置：确认 / 忽略 / 加白。

    ``detail`` 只是给处置记录留一个「当时处置的是什么」的说明快照
    （名称、命令行等），加白时还用它生成白名单条目。
    """

    host_id: str = Field(default="local", max_length=64)
    # 指纹：端口是 "port:8080"，进程是 "proc:bash|/usr/bin/bash|rebound_shell_i"
    fingerprint: str = Field(min_length=1, max_length=300)
    # ack = 确认；ignore = 忽略（有时效）；whitelist = 加白（永久，写进策略）
    action: str = Field(default="ack", max_length=16)
    note: str = Field(default="", max_length=200)
    # 仅 ignore 生效：多少天后重新提示（留空用默认 7 天）
    ttl_days: Optional[int] = Field(default=None, ge=1, le=365)
    detail: Dict[str, Any] = Field(default_factory=dict)


class PortPolicyIn(BaseModel):
    """端口巡检策略：预期端口与进程白名单是压掉误报的主要手段。"""

    enabled: bool = True
    alert_open_ports: bool = True
    alert_suspicious: bool = True
    cooldown_minutes: int = Field(default=60, ge=1, le=1440)
    # 告警接收人（留空 = 第一个管理员）
    notify_user: str = Field(default="", max_length=64)
    # 预期对外开放的端口：可写 "22" / "0.0.0.0:80" / "*:443"
    expected_ports: List[str] = Field(default_factory=list)
    # 进程白名单（正则，匹配命令行即忽略）
    process_whitelist: List[str] = Field(default_factory=list)


# -------------------------------------------------------------------- tasks
class TaskRef(BaseModel):
    task: str


# -------------------------------------------------------------------- misc
class HealthOut(BaseModel):
    status: str
    pve_connected: bool
    version: Optional[str] = None
    pve_version: Optional[str] = None
    node_count: int = 0
    error: Optional[str] = None


JsonDict = Dict[str, Any]
MaybeInt = Union[int, str, None]
