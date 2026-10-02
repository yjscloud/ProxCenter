"""VM configuration builders.

These translate the panel's declarative request models into the exact
``key=value`` strings the Proxmox API expects. Keeping this logic in one place
means the create path, the clone path, and the template pipeline all stay
consistent — and it is the part most likely to need tweaking against a real
cluster, so it is isolated and unit-testable.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from .schemas import (
    CloudInitSpec,
    DiskSpec,
    EfiDiskSpec,
    LxcCreateRequest,
    LxcMountSpec,
    LxcNetworkSpec,
    NetworkSpec,
    NumaNodeSpec,
    TpmSpec,
    VmCreateRequest,
)

# Interfaces Proxmox accepts for each bus.
SCSI_PREFIXES = ("scsi", "virtio", "sata", "ide")
VALID_OSTYPES = {
    "l24", "l26", "other", "wxp", "w2k", "w2k3", "w2k8", "wvista",
    "win7", "win8", "win10", "win11", "solaris",
}
# Windows 系客户机。判据只留这一处：有些地方要按系统分流（控制台配置、初始化
# 工具名字），而 `ostype.startswith("win")` 会漏掉 wxp / w2k / wvista 这些老系统。
WINDOWS_OSTYPES = frozenset(
    {"wxp", "w2k", "w2k3", "w2k8", "wvista", "win7", "win8", "win10", "win11"}
)
VALID_CPU_TYPES = {
    "host", "kvm64", "kvm32", "qemu64", "x86-64-v2", "x86-64-v2-AES",
    "x86-64-v3", "x86-64-v4", "Broadwell", "Skylake-Client", "EPYC", "EPYC-Rome",
    "Haswell", "IvyBridge", "SandyBridge", "Nehalem", "Westmere", "max",
}
VALID_SCSIHW = {
    "virtio-scsi-pci", "virtio-scsi-single", "lsi", "lsi53c810",
    "megasas", "pvscsi", "virtio-scsi",
}
VALID_DISK_FORMATS = {"raw", "qcow2", "vmdk"}
VALID_NET_MODELS = {"virtio", "e1000", "e1000e", "rtl8139", "vmxnet3", "i82551"}

_MAC_RE = re.compile(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")


# --------------------------------------------------------------------- utils
def normalize_ostype(value: Optional[str]) -> str:
    value = (value or "l26").strip().lower()
    return value if value in VALID_OSTYPES else "l26"


def is_windows_ostype(value: Optional[str]) -> bool:
    """是不是 Windows 系客户机（归一化之后再比，避免大小写/空值漏判）。"""
    return normalize_ostype(value) in WINDOWS_OSTYPES


def normalize_cpu_type(value: Optional[str]) -> str:
    value = (value or "host").strip()
    # Accept unmapped but plausible CPU types rather than silently downgrading,
    # since new generations appear regularly and PVE validates them itself.
    return value if value else "host"


def normalize_scsihw(value: Optional[str]) -> str:
    value = (value or "virtio-scsi-single").strip()
    return value if value in VALID_SCSIHW else "virtio-scsi-single"


def normalize_net_model(value: Optional[str]) -> str:
    value = (value or "virtio").strip()
    return value if value in VALID_NET_MODELS else "virtio"


# PVE 9 把 boot 的格式改成了
#     [[legacy=]<[acdn]{1,4}>] [,order=<device[;device...]>]
# 也就是**不带键名的值会被当成 ``legacy`` 解析**，而 legacy 只接受 a/c/d/n 这四个
# 字母组成的 1–4 位字符串（软盘/硬盘/光驱/网络）。面板给的是设备名列表
# （``scsi0`` / ``scsi0;net0``），于是 PVE 9 回：
#     boot: invalid format - format error
#     boot.legacy: value does not match the regex pattern
# PVE 8 的格式里没有 legacy 子键，裸写法能过 —— 所以这个坑只在 PVE 9 上暴露，
# 而且只要动手建虚拟机就必然踩到（前端的默认值就是 ``scsi0``）。
_LEGACY_BOOT_RE = re.compile(r"^[acdn]{1,4}$")


def normalize_boot_order(value: Optional[str]) -> str:
    """把「启动顺序」归一成 PVE 9 也认的 ``order=<设备列表>`` 写法。

    三件事：

    * 设备列表（``scsi0`` / ``scsi0; net0``）补上 ``order=``，顺手去掉空段；
    * 已经带 ``order=`` 的原样规整（``order=scsi0;`` 这种多余分号也清掉）；
    * 显式写了多个子键（``order=scsi0,legacy=cdn``）或别的键名时**不碰** ——
      那是用户自己知道在写什么，交给 PVE 校验，别替他猜。

    单独拦下 ``cdn`` 这类纯 a/c/d/n 组合：那是 PVE 旧版语法（先光驱、再硬盘、
    再网络）。补成 ``order=cdn`` 只会让 PVE 回一句「设备 cdn 不存在」，同样看
    不懂，不如在这里说清楚「请写设备名」。
    """
    # 折叠空白：用户从别处粘过来的值常常带换行或多余空格
    text = " ".join((value or "").split())
    if not text:
        raise ValueError("启动顺序不能为空（例如 scsi0;net0）")
    if _LEGACY_BOOT_RE.match(text):
        raise ValueError(
            f"启动顺序 {text!r} 是 PVE 旧版的写法（a/c/d/n 依次表示软盘、硬盘、"
            "光驱、网络）；请直接写设备名，例如 scsi0;net0"
        )

    prefix = "order="
    if "=" not in text:
        body = text
    elif text.startswith(prefix) and "," not in text:
        body = text[len(prefix):]
    else:
        # 多个子键 / 其它键名：原样交给 PVE 校验
        return text

    devices = [item.strip() for item in body.split(";") if item.strip()]
    if not devices:
        raise ValueError("启动顺序不能为空（例如 scsi0;net0）")
    return prefix + ";".join(devices)


def normalize_disk_format(value: Optional[str], storage_type: str = "") -> str:
    value = (value or "raw").strip().lower()
    if value not in VALID_DISK_FORMATS:
        value = "raw"
    # LVM/ZFS/block storages only support raw; qcow2 requires dir-ish storage.
    if storage_type in ("lvm", "lvmthin", "zfspool", "rbd", "zfs"):
        return "raw"
    return value


def format_disk_spec(spec: DiskSpec) -> str:
    """``storage:size`` with optional flags, e.g. ``local-lvm:32,discard=on``."""
    parts = [f"{spec.storage}:{spec.size}"]
    if spec.discard:
        parts.append("discard=on")
    if spec.ssd:
        parts.append("ssd=1")
    return ",".join(parts)


# 文件级存储必须显式给出 format；块存储（LVM/ZFS/RBD）只能用 raw，不带这个参数。
DISK_FORMAT_STORAGE_TYPES = ("dir", "nfs", "cifs", "glusterfs", "btrfs")


def format_disk_config(spec: DiskSpec, storage_type: str) -> str:
    """磁盘 spec → PVE 配置值，按存储类型补上 ``format=``。

    创建虚拟机和后续「新增一块磁盘」共用这一份拼装逻辑，
    否则两条路径对同一块盘的写法会慢慢分叉。
    """
    value = format_disk_spec(spec)
    fmt = normalize_disk_format(spec.format, storage_type)
    if storage_type in DISK_FORMAT_STORAGE_TYPES and fmt:
        return f"{value},format={fmt}"
    return value


def next_free_key(prefix: str, config: Dict[str, Any], maximum: int) -> str:
    """返回 ``config`` 里第一个没被占用的 ``<prefix><n>`` 键名。

    新增磁盘 / 网卡时用来挑槽位。不能按「现有数量」推算（``scsi{len}``）——
    删掉 scsi0 之后再新增，数量推导出来的键会正好撞上已存在的那个。
    """
    used = {
        key
        for key in config
        if key.startswith(prefix) and key[len(prefix) :].isdigit()
    }
    for index in range(maximum):
        candidate = f"{prefix}{index}"
        if candidate not in used:
            return candidate
    raise ValueError(f"{prefix} 槽位已用满（最多 {maximum} 个）")


def format_network_spec(spec: NetworkSpec) -> str:
    """``model=virtio,bridge=vmbr0,tag=10,firewall=1,macaddr=...``"""
    segments = [f"{normalize_net_model(spec.model)}"]
    if spec.bridge:
        segments.append(f"bridge={spec.bridge}")
    if spec.vlan_tag is not None:
        segments.append(f"tag={spec.vlan_tag}")
    if spec.firewall:
        segments.append("firewall=1")
    if spec.macaddr and _MAC_RE.match(spec.macaddr):
        segments.append(f"macaddr={spec.macaddr.upper()}")
    if spec.rate:
        segments.append(f"rate={spec.rate}")
    return ",".join(segments)


def format_ipconfig(spec: CloudInitSpec, index: int) -> Optional[str]:
    """Build ``ipconfigN`` value for the given interface index."""
    if index >= len(spec.ip_configs):
        return "ip=dhcp"

    entry = spec.ip_configs[index]
    raw_ip = (entry.ip or "dhcp").strip()

    if raw_ip.lower() == "dhcp":
        value = "ip=dhcp"
    else:
        value = f"ip={raw_ip}"
        if entry.gateway:
            value += f",gw={entry.gateway}"

    if entry.ipv6:
        value += f",ip6={entry.ipv6}"

    return value


# --------------------------------------------------- 高级硬件：NUMA / EFI / TPM
#
# PVE 的 cpuset 写法：逗号分隔的「单核或区间」，如 ``0``、``0-3``、``0-3,8-11``。
_CPUSET_RE = re.compile(r"^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$")

# numaN 的 memory 分配策略。只有同时给了 hostnodes 才生效。
VALID_NUMA_POLICIES = ("bind", "interleave", "preferred")

# EFI 变量盘的两种格式：4m 才支持 pre-enrolled-keys（Win11 安全启动）。
VALID_EFI_TYPES = ("2m", "4m")
VALID_TPM_VERSIONS = ("v1.2", "v2.0")


def normalize_cpuset(value: Optional[str]) -> Optional[str]:
    """校准 cpuset（``0-3,8`` 这种写法），非法返回 ``None``。

    非法时丢弃而不是原样透传：``affinity`` / ``numaN`` 里一个打错的字符会让
    PVE 在建机时才报错 —— 那时磁盘已经分配了，收尾更麻烦。
    """
    text = (value or "").strip()
    if not text or not _CPUSET_RE.match(text):
        return None
    return text


def resolve_firmware(bios: str, machine: str, needs_efi: bool) -> tuple[str, str]:
    """按是否需要 EFI 校准固件，返回 ``(bios, machine)``。

    EFI 变量盘 / 虚拟 TPM 必须配 OVMF；而 OVMF 在 i440fx 上不可用，机型必须是
    q35。三者不配套时虚拟机建出来直接起不来，因此这里与 ``normalize_ostype``
    等函数同一策略：**悄悄纠正**而不是抛错 —— 前端「Windows 11」预设会把它们
    一起设上，手写 API 的调用方漏掉一个也不该拿到一台废机器。
    """
    resolved_bios = bios if bios in ("seabios", "ovmf") else "seabios"
    resolved_machine = (machine or "pc").strip() or "pc"
    if needs_efi:
        resolved_bios = "ovmf"
        if resolved_machine in ("pc", "pc-i440fx", "i440fx"):
            resolved_machine = "q35"
    return resolved_bios, resolved_machine


def format_numa_node(
    spec: NumaNodeSpec,
    *,
    share_memory: int,
) -> Optional[str]:
    """``numaN`` 的值：``cpus=0-3,memory=4096,hostnodes=0,policy=bind``。

    ``memory`` 在 PVE 里是必填项，留空时按 ``share_memory``（总内存 / 节点数）
    补一个 —— 让「只想钉 CPU、内存随意」的调用方不用自己算。
    """
    cpus = normalize_cpuset(spec.cpus)
    if not cpus:
        return None

    memory = int(spec.memory or 0) or max(int(share_memory), 16)
    parts = [f"cpus={cpus}", f"memory={memory}"]

    hostnodes = normalize_cpuset(spec.hostnodes)
    if hostnodes:
        parts.append(f"hostnodes={hostnodes}")
        # policy 只在绑定物理节点时才有意义，PVE 对无 hostnodes 的 policy 会报错
        if spec.policy in VALID_NUMA_POLICIES:
            parts.append(f"policy={spec.policy}")

    return ",".join(parts)


def build_numa_config(req: VmCreateRequest) -> Dict[str, Any]:
    """NUMA 拓扑与 CPU 亲和性的配置片段。

    创建与克隆两条路径共用：这两项都是纯配置项（不占存储），克隆出来的实例
    同样需要按目标宿主机重新绑定。
    """
    config: Dict[str, Any] = {}
    nodes = list(req.numa_nodes or [])

    # 给了 numaN 就必然要开 numa，否则 PVE 会忽略那些节点定义
    if req.numa or nodes:
        config["numa"] = 1

    if nodes:
        share = max(req.memory // len(nodes), 16)
        for index, spec in enumerate(nodes):
            value = format_numa_node(spec, share_memory=share)
            if value:
                config[f"numa{index}"] = value

    affinity = normalize_cpuset(req.affinity)
    if affinity:
        config["affinity"] = affinity

    return config


def format_efidisk(spec: EfiDiskSpec) -> str:
    """``efidisk0`` 的值：``local-lvm:1,efitype=4m,pre-enrolled-keys=1``。

    用「存储 + 容量」而不是卷 ID：PVE 会自己分配变量盘，与界面勾选「EFI 磁盘」
    等价，不需要先建卷再挂载。
    """
    efitype = spec.efitype if spec.efitype in VALID_EFI_TYPES else "4m"
    parts = [f"{spec.storage}:{int(spec.size)}", f"efitype={efitype}"]
    if efitype == "4m":
        # 2m 格式不支持这个参数，带上会让 PVE 直接拒绝
        parts.append(f"pre-enrolled-keys={1 if spec.pre_enrolled_keys else 0}")
    return ",".join(parts)


def format_tpmstate(spec: TpmSpec) -> str:
    """``tpmstate0`` 的值：``local-lvm:4,version=v2.0``。"""
    version = spec.version if spec.version in VALID_TPM_VERSIONS else "v2.0"
    return f"{spec.storage}:{int(spec.size)},version={version}"


# ------------------------------------------------------------------ builder
def build_vm_config(
    req: VmCreateRequest,
    *,
    vmid: int,
    storage_types: Optional[Dict[str, str]] = None,
    import_disk: bool = False,
) -> Dict[str, Any]:
    """Produce the payload for ``POST /nodes/{node}/qemu``.

    ``storage_types`` maps a storage name to its PVE type so disk formats can
    be normalised correctly. ``import_disk`` is used by the template pipeline,
    where the system disk comes from a cloud image rather than being allocated
    blank.
    """
    storage_types = storage_types or {}
    # EFI 变量盘 / 虚拟 TPM 必须配 OVMF + q35：先算出最终固件再落进配置，
    # 否则会建出一台 BIOS 与磁盘不匹配、根本引导不起来的机器。
    bios, machine = resolve_firmware(
        req.bios, req.machine, needs_efi=bool(req.efi_disk or req.tpm)
    )
    config: Dict[str, Any] = {
        "vmid": vmid,
        "name": req.name,
        "memory": req.memory,
        "cores": req.cores,
        "sockets": req.sockets,
        "cpu": normalize_cpu_type(req.cpu_type),
        "ostype": normalize_ostype(req.ostype),
        "bios": bios,
        "machine": machine,
        "scsihw": normalize_scsihw(req.scsihw),
        "agent": 1 if req.agent else 0,
        "onboot": 1 if req.start_on_boot else 0,
    }

    # 内存气球：不写这个键时 PVE 按「整份内存」处理（balloon = memory），宿主机
    # 收不回客户机的空闲内存；写更低的值才有回收空间。0 也是有效值 —— PVE 用它
    # 显式关掉气球驱动，所以这里只跳过 None，不把 0 当「没填」。
    if req.balloon is not None:
        config["balloon"] = req.balloon

    # ---- 高级硬件：NUMA 拓扑 / CPU 亲和性 ----
    config.update(build_numa_config(req))

    # ---- 高级硬件：EFI 变量盘与虚拟 TPM（Windows 11 必需）----
    # 值用「存储 + 容量」形式，变量盘由 PVE 在建机时一并分配。
    if req.efi_disk:
        config["efidisk0"] = format_efidisk(req.efi_disk)
    if req.tpm:
        config["tpmstate0"] = format_tpmstate(req.tpm)

    if req.description:
        config["description"] = req.description
    if req.tags:
        config["tags"] = req.tags

    # ---- disks ----
    if not import_disk:
        for idx, disk in enumerate(req.disks):
            interface = disk.interface or f"scsi{idx}"
            storage_type = storage_types.get(disk.storage, "")
            config[interface] = format_disk_config(disk, storage_type)

    # ---- networks ----
    for idx, net in enumerate(req.networks):
        config[f"net{idx}"] = format_network_spec(net)

    # ---- ISO / CD-ROM ----
    cd_key = ""
    if req.iso:
        # Place the CD-ROM on the first free IDE slot.
        for slot in range(4):
            key = f"ide{slot}"
            if key not in config:
                config[key] = f"{req.iso},media=cdrom"
                cd_key = key
                break

    # ---- boot order ----
    #
    # 必须把安装光驱也列进去。PVE 只给 ``order=`` 里出现的设备打 ``bootindex``，
    # 并把 ``-boot strict=on`` 一并交给固件 —— 于是 ``order=scsi0`` 的含义是
    # 「**只准从 scsi0 引导**」：新建的机器那块盘是空的、光驱又不在名单里，
    # SeaBIOS 直接报没有可引导设备，用 ISO 装系统永远进不去安装界面。
    # （实测 `qm showcmd`：只有 scsi0 拿到 bootindex，光驱一个都没有。）
    #
    # 顺序照抄 PVE 自己的默认值 ``order=scsi0;ide2;net0``（磁盘 → 光驱 → 网卡）：
    # 盘上装了系统就从盘引导，空盘时落到光驱装系统，两者都没有才走 PXE。
    # OVMF 那套之所以没暴露这个问题，是因为 OVMF 自己枚举所有设备，不看这份名单。
    if req.boot_order:
        # 用户显式写了就照他的来，只做归一（裸设备名在 PVE 9 上会被当成
        # legacy 值而报格式错，见 normalize_boot_order 的说明）。
        config["boot"] = normalize_boot_order(req.boot_order)
    elif import_disk:
        # 导入的云镜像本身就是系统盘，没有安装介质可言
        config["boot"] = "order=scsi0"
    elif req.disks:
        devices = [req.disks[0].interface or "scsi0"]
        if cd_key:
            devices.append(cd_key)
        if req.networks:
            devices.append("net0")
        config["boot"] = f"order={';'.join(devices)}"

    # ---- cloud-init drive ----
    ci = req.cloudinit
    if ci and ci.enabled:
        # Cloud-init needs a small serial device so the console shows output.
        if not import_disk:
            # ide2 must stay free for the cloud-init drive; skip if ISO took it.
            for slot in range(4):
                key = f"ide{slot}"
                if key not in config:
                    config[key] = "cloudinit"
                    break
        config.update(build_cloudinit_config(ci, network_count=len(req.networks)))
        # 这段配置是给 Linux 云镜像看的：它们把内核日志打到 ttyS0，把 vga 指到
        # serial0 才能在 VNC 控制台里看到启动过程。**Windows 不往串口输出**，对它
        # 这么设只会让 VNC 控制台黑屏 —— 而 Windows 客户机的初始化是 Cloudbase-Init，
        # 用户装好它、打开这个开关后第一件事就是去看控制台装系统。
        # 云盘照旧挂载：Cloudbase-Init 也是从这块 config drive 读元数据的。
        if not is_windows_ostype(req.ostype):
            config.setdefault("serial0", "socket")
            config.setdefault("vga", "serial0")

    return config


def build_cloudinit_config(ci: CloudInitSpec, network_count: int = 1) -> Dict[str, Any]:
    """Cloud-init related config keys (ciuser / sshkeys / ipconfigN / ...)."""
    config: Dict[str, Any] = {}

    if ci.user:
        config["ciuser"] = ci.user
    if ci.password:
        config["cipassword"] = ci.password
    if ci.ssh_keys:
        config["sshkeys"] = _encode_ssh_keys(ci.ssh_keys)
    if ci.nameserver:
        config["nameserver"] = ci.nameserver
    if ci.searchdomain:
        config["searchdomain"] = ci.searchdomain

    # 这里曾经有 ci.upgrade → config["ciupgrade"] = 1（PVE 的「每次开机升级软件包」）。
    # 实测它默认关闭、界面里从来没有入口、模板里也没有这个键，留着只会让人误开 ——
    # 一旦打开，每台机器每次开机都会跑一遍 dnf/apt 全量升级，CPU 与内存的尖峰很显眼
    # （客户机内的升级行为另有其事，见 /etc/cloud/cloud.cfg 的 package_upgrade）。

    count = max(network_count, len(ci.ip_configs), 1)
    for idx in range(count):
        value = format_ipconfig(ci, idx)
        if value:
            config[f"ipconfig{idx}"] = value

    return config


def _encode_ssh_keys(raw: str) -> str:
    """PVE expects SSH keys URL-encoded inside the config value.

    Multi-line paste is common, so normalise newlines first.
    """
    from urllib.parse import quote

    cleaned = raw.strip().replace("\r\n", "\n").replace("\r", "\n")
    keys = [line.strip() for line in cleaned.split("\n") if line.strip()]
    joined = "\n".join(keys)
    return quote(joined, safe="")


def build_cloudinit_for_clone(
    *,
    ci_user: Optional[str] = None,
    ci_password: Optional[str] = None,
    ssh_keys: Optional[str] = None,
    ip_config: Optional[str] = None,
    nameserver: Optional[str] = None,
) -> Dict[str, Any]:
    """Config applied to a freshly cloned VM from a template."""
    config: Dict[str, Any] = {}
    if ci_user:
        config["ciuser"] = ci_user
    if ci_password:
        config["cipassword"] = ci_password
    if ssh_keys:
        config["sshkeys"] = _encode_ssh_keys(ssh_keys)
    if ip_config:
        # Accept either a bare value ("ip=dhcp") or a full list.
        for idx, chunk in enumerate(str(ip_config).split(";")):
            chunk = chunk.strip()
            if chunk:
                config[f"ipconfig{idx}"] = chunk
    if nameserver:
        config["nameserver"] = nameserver
    return config


def parse_config_disks(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract disk entries from a VM config dict."""
    disks: List[Dict[str, Any]] = []
    for key, value in (config or {}).items():
        if not isinstance(value, str):
            continue
        if not any(key.startswith(p) for p in SCSI_PREFIXES):
            continue
        # Skip optical/cloud-init entries.
        if "media=cdrom" in value or value == "cloudinit":
            continue
        parsed = _parse_disk_value(key, value)
        if parsed:
            disks.append(parsed)
    disks.sort(key=lambda d: d["interface"])
    return disks


def parse_config_networks(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract NIC entries from a VM config dict.

    A PVE net line looks like ``virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=10``.
    The model appears as a bare segment whose value is a MAC address; anything
    else bare (``e1000``) is the model too. We normalise to a ``model`` key and
    keep the MAC under ``macaddr``.
    """
    networks: List[Dict[str, Any]] = []
    for key, value in (config or {}).items():
        if not isinstance(value, str) or not re.match(r"^net\d+$", key):
            continue
        entry: Dict[str, Any] = {"interface": key, "raw": value}
        for segment in value.split(","):
            segment = segment.strip()
            if not segment:
                continue
            if "=" in segment:
                k, _, v = segment.partition("=")
                k, v = k.strip(), v.strip()
                if k == "virtio":  # "virtio=AA:BB:.." — model plus MAC
                    entry["model"] = "virtio"
                    entry["macaddr"] = v
                else:
                    entry[k] = v
            elif _MAC_RE.match(segment):
                entry["macaddr"] = segment
            else:
                entry["model"] = segment
        entry.setdefault("model", "virtio")
        networks.append(entry)
    networks.sort(key=lambda n: n["interface"])
    return networks


def _parse_disk_value(key: str, value: str) -> Optional[Dict[str, Any]]:
    """Parse ``local-lvm:vm-100-disk-0,size=32G`` into a dict."""
    segments = value.split(",")
    if not segments:
        return None

    head = segments[0]
    if ":" not in head:
        return None

    storage, _, volid = head.partition(":")
    entry: Dict[str, Any] = {
        "interface": key,
        "storage": storage,
        "volid": volid,
        "size": "",
    }

    for segment in segments[1:]:
        if "=" in segment:
            k, _, v = segment.partition("=")
            entry[k.strip()] = v.strip()

    _attach_size(entry, volid)
    return entry


_SIZE_RE = re.compile(r"size=(\d+(?:\.\d+)?)([KMGTP])", re.IGNORECASE)


def _attach_size(entry: Dict[str, Any], volid: str) -> None:
    """Derive a human-readable disk size.

    PVE only embeds the size in the config line for some storage types, so we
    leave it blank when it is absent and let the caller fill it from the
    storage content listing.
    """
    match = _SIZE_RE.search(volid)
    if match:
        entry["size"] = f"{match.group(1)}{match.group(2).upper()}"
    elif isinstance(entry.get("size"), str) and entry["size"]:
        pass


def disk_size_to_gb(size: str) -> Optional[float]:
    """Convert a PVE size string such as ``32G`` / ``512M`` into GB."""
    if not size:
        return None
    match = re.match(r"^(\d+(?:\.\d+)?)\s*([KMGTP])?$", str(size).strip(), re.IGNORECASE)
    if not match:
        return None
    value = float(match.group(1))
    unit = (match.group(2) or "G").upper()
    factors = {"K": 1 / 1024 / 1024, "M": 1 / 1024, "G": 1, "T": 1024, "P": 1024 * 1024}
    return round(value * factors.get(unit, 1), 2)


# ===========================================================================
# LXC（容器）
#
# 容器的配置键与虚拟机只差在几处，但每一处都会让「照抄 qemu」静默失败：
#   * 系统盘是 ``rootfs``，创建时写「存储:GiB」，创建后 PVE 才换成 volid；
#   * 网卡的 ``name`` 是容器内的接口名，IP 直接写在网卡行里 —— 没有 cloud-init；
#   * 初始化只有 ``password`` 与 ``ssh-public-keys`` 两个键。
# ===========================================================================

LXC_VALID_FEATURES = ("nesting", "keyctl", "fuse", "mknod", "mount")


def format_lxc_network_spec(spec: LxcNetworkSpec, index: int = 0) -> str:
    """``name=eth0,bridge=vmbr0,ip=dhcp,firewall=1,tag=10``"""
    name = (spec.name or "").strip() or f"eth{index}"
    segments = [f"name={name}"]
    if spec.bridge:
        segments.append(f"bridge={spec.bridge}")

    ip = (spec.ip or "dhcp").strip()
    segments.append(f"ip={ip}" if ip else "ip=dhcp")
    if spec.gateway and ip not in ("dhcp", "manual"):
        segments.append(f"gw={spec.gateway}")

    ip6 = (spec.ip6 or "").strip()
    if ip6:
        segments.append(f"ip6={ip6}")
        if spec.gateway6:
            segments.append(f"gw6={spec.gateway6}")

    if spec.vlan_tag is not None:
        segments.append(f"tag={spec.vlan_tag}")
    if spec.firewall:
        segments.append("firewall=1")
    if spec.hwaddr and _MAC_RE.match(spec.hwaddr):
        segments.append(f"hwaddr={spec.hwaddr.upper()}")
    if spec.rate:
        segments.append(f"rate={spec.rate}")
    if spec.mtu:
        segments.append(f"mtu={spec.mtu}")
    return ",".join(segments)


def format_lxc_mount_spec(spec: LxcMountSpec) -> str:
    """``local-lvm:8,mp=/data,backup=1``"""
    segments = [f"{spec.storage}:{spec.size}"]
    path = (spec.mp or "").strip()
    if path:
        segments.append(f"mp={path}")
    if spec.backup:
        segments.append("backup=1")
    if spec.acl:
        segments.append("acl=1")
    return ",".join(segments)


def _join_ssh_keys(raw: str) -> str:
    """多行公钥 → 换行分隔的单串。

    与 QEMU 的 ``sshkeys`` 不同：容器的 ``ssh-public-keys`` 就是普通的多行
    字符串，表单编码会负责转义换行，这里**不要**再做一次 URL 编码（否则
    PVE 收到的是 ``%0A`` 字面量，容器里会出现一行坏掉的公钥）。
    """
    cleaned = raw.strip().replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.strip() for line in cleaned.split("\n") if line.strip())


def build_lxc_config(
    req: LxcCreateRequest,
    *,
    vmid: int,
    storage_types: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Produce the payload for ``POST /nodes/{node}/lxc``."""
    config: Dict[str, Any] = {
        "vmid": vmid,
        "ostemplate": req.ostemplate,
        "storage": req.storage,
        "rootfs": f"{req.storage}:{req.rootfs}",
        "hostname": req.hostname,
        "memory": req.memory,
        "swap": req.swap,
        "cores": req.cores,
        "unprivileged": 1 if req.unprivileged else 0,
        "onboot": 1 if req.start_on_boot else 0,
        "protection": 1 if req.protection else 0,
        # 让 PVE 自己把容器拉起来，省掉前端再发一次开机请求
        "start": 1 if req.start else 0,
    }

    if req.cpulimit:
        config["cpulimit"] = req.cpulimit
    if req.cpuunits:
        config["cpuunits"] = req.cpuunits
    if req.ostype:
        config["ostype"] = req.ostype
    if req.tags:
        config["tags"] = req.tags
    if req.description:
        config["description"] = req.description

    features = [f for f in (req.features or []) if f in LXC_VALID_FEATURES]
    if features:
        config["features"] = ",".join(f"{f}=1" for f in features)

    for idx, net in enumerate(req.networks):
        config[f"net{idx}"] = format_lxc_network_spec(net, index=idx)

    # 没填网卡时至少给一张：没有 net0 的容器起不来也没有网络
    if not req.networks:
        config["net0"] = format_lxc_network_spec(LxcNetworkSpec(), index=0)

    for idx, mount in enumerate(req.mounts):
        interface = mount.interface or f"mp{idx}"
        config[interface] = format_lxc_mount_spec(mount)

    setup = req.setup
    if setup:
        if setup.password:
            config["password"] = setup.password
        if setup.ssh_keys:
            config["ssh-public-keys"] = _join_ssh_keys(setup.ssh_keys)
        if setup.nameserver:
            config["nameserver"] = setup.nameserver
        if setup.searchdomain:
            config["searchdomain"] = setup.searchdomain

    return config


def parse_lxc_rootfs(config: Dict[str, Any]) -> Dict[str, Any]:
    """解析 ``rootfs``，形如 ``local-lvm:vm-100-disk-0,size=8G``。"""
    raw = (config or {}).get("rootfs") or ""
    if not isinstance(raw, str) or ":" not in raw:
        return {"interface": "rootfs", "storage": "", "volid": "", "size": "", "raw": raw}

    storage, _, volid = raw.split(",", 1)[0].partition(":")
    entry: Dict[str, Any] = {
        "interface": "rootfs",
        "storage": storage,
        "volid": volid,
        "size": "",
        "raw": raw,
    }
    segments = raw.split(",")[1:]
    for segment in segments:
        if "=" in segment:
            k, _, v = segment.partition("=")
            entry[k.strip()] = v.strip()
    if not entry.get("size"):
        match = re.search(r"(\d+(?:\.\d+)?)([KMGTP])", volid, re.IGNORECASE)
        if match:
            entry["size"] = f"{match.group(1)}{match.group(2).upper()}"
    return entry


def parse_lxc_mounts(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """解析 ``mp0..mpN`` 挂载点。"""
    mounts: List[Dict[str, Any]] = []
    for key, value in (config or {}).items():
        if not isinstance(value, str) or not re.match(r"^mp\d+$", key):
            continue
        head = value.split(",", 1)[0]
        storage, _, volid = head.partition(":")
        entry: Dict[str, Any] = {
            "interface": key,
            "storage": storage,
            "volid": volid,
            "size": "",
            "raw": value,
        }
        for segment in value.split(",")[1:]:
            if "=" in segment:
                k, _, v = segment.partition("=")
                entry[k.strip()] = v.strip()
        mounts.append(entry)
    mounts.sort(key=lambda m: m["interface"])
    return mounts


def parse_lxc_networks(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """解析 ``net0..netN``。

    与 QEMU 不同：容器网卡行是**全键值对**（``name=eth0,bridge=vmbr0``），
    没有裸的「型号」段，也没有 MAC 隐式跟在型号后面。
    """
    networks: List[Dict[str, Any]] = []
    for key, value in (config or {}).items():
        if not isinstance(value, str) or not re.match(r"^net\d+$", key):
            continue
        entry: Dict[str, Any] = {"interface": key, "raw": value}
        for segment in value.split(","):
            segment = segment.strip()
            if not segment:
                continue
            if "=" in segment:
                k, _, v = segment.partition("=")
                entry[k.strip()] = v.strip()
            else:
                # 极少数旧配置只有裸值，至少别丢信息
                entry["name"] = segment
        networks.append(entry)
    networks.sort(key=lambda n: n["interface"])
    return networks
