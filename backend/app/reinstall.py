"""虚拟机重装系统：用 Cloud-Init 模板的系统盘替换掉机器原有的系统盘。

**新系统盘怎么来**：默认走**链接克隆**（与「快速部署」同一套机制）—— 借道克隆
API 把模板克隆成一台临时机器，把它的系统盘从临时机器上摘下来挂到目标机器，再删掉
临时机器。秒级完成、几乎不占额外空间；代价是这块盘以模板母盘为基点，模板被删这台
机器也就起不来了（所以界面上必须说清楚，见 VmReinstallWizard 的存储提示）。

做不到时回退到**整盘复制**（这条是实测出来的，不是推测）：PVE 9.2 的磁盘参数支持

    <目标存储>:0,import-from=<源卷>

其中 ``import-from`` 接受**卷 ID**，PVE 会把源卷的内容复制成这台机器的新盘。
实测把模板的只读 base 卷（``local:102/base-102-disk-0.qcow2``）作为源，
新机拿到的是 ``local:110/vm-110-disk-0.qcow2``（100G，已用数据被完整复制）。
跨存储时只能这样 —— 链接卷靠 backing file 指向母盘，换个存储就没有基点了。

两种方式都保持 VMID、网卡与 MAC、CPU/内存、磁盘拓扑不变，这才叫重装而不是重建。

**顺序上的取舍**：新盘先建在**空闲盘位**上（此时旧盘原封不动），全部就绪后才
做「新盘换成系统盘 + 摘掉旧盘」这一步。任何一步失败，旧盘都还在配置里，
回滚代价接近零；反过来若先删旧盘再建新盘，中途失败就是一台没有系统盘的机器。
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Set, Tuple
from urllib.parse import quote

from . import alerting, i18n, notifications, security, vmconfig
from .pve import ProxmoxError, client_for_connection

logger = logging.getLogger(__name__)

# 磁盘总线键（与 vmtransfer 里同一套规则）
_DISK_PREFIXES = ("scsi", "virtio", "sata", "ide")
# 链接克隆是秒级的：真在跑就不会超过一两分钟，给宽一点避免慢存储误判
CLONE_TIMEOUT = 600.0
# 导入几十 GB 的系统盘可能要十几分钟
IMPORT_TIMEOUT = 3600.0


class ReinstallError(RuntimeError):
    """可以直接展示给用户的重装错误。"""


def _is_disk_key(key: str) -> bool:
    return any(
        key.startswith(prefix) and key[len(prefix) :].isdigit() for prefix in _DISK_PREFIXES
    )


def _volid_of(value: Any) -> str:
    text = str(value or "")
    if not text or text.startswith("none"):
        return ""
    if "media=cdrom" in text or "cloudinit" in text:
        return ""
    volid = text.split(",", 1)[0].strip()
    return volid if ":" in volid else ""


def _disk_keys(config: Dict[str, Any]) -> List[str]:
    keys = [str(k) for k in (config or {}) if _is_disk_key(str(k))]
    # scsi0 < scsi1 < … < virtio0 …：让「哪块是系统盘」的判定稳定（0 号优先）
    keys.sort(key=lambda k: (k.rstrip("0123456789"), int(k[len(k.rstrip("0123456789")) :] or 0)))
    return keys


def boot_disk(config: Dict[str, Any]) -> Tuple[str, str]:
    """当前配置里的系统盘：返回 ``(盘位, 卷 ID)``；没有则空串。

    判定顺序与 PVE 的直觉一致：boot order 里点名的盘优先，否则用第一个数据盘。
    """
    boot = str(config.get("boot") or "")
    ordered: List[str] = []
    if "order=" in boot:
        spec = boot.split("order=", 1)[1].split(",", 1)[0]
        ordered = [piece.strip() for piece in spec.split(";") if piece.strip()]

    for key in ordered:
        if _is_disk_key(key):
            volid = _volid_of(config.get(key))
            if volid:
                return key, volid
    for key in _disk_keys(config):
        volid = _volid_of(config.get(key))
        if volid:
            return key, volid
    return "", ""


def free_slot(config: Dict[str, Any]) -> str:
    """找一个空闲盘位（优先 scsi，其次 virtio / sata）。

    为什么还要找空位而不是「先删旧盘再建新盘」：见模块开头的顺序说明 ——
    新盘落在旁边，旧盘全程不动，失败可以原地退回。
    """
    for prefix in ("scsi", "virtio", "sata"):
        for index in range(0, 31):
            key = f"{prefix}{index}"
            if key not in config:
                return key
    raise ReinstallError("这台虚拟机的盘位已用满，没有地方放新的系统盘")


async def list_templates(client: Any, node: str) -> List[Dict[str, Any]]:
    """本节点上可作为重装来源的模板。

    只列**同节点**的模板：``import-from`` 的源卷必须能被执行导入的节点读到，
    跨节点的本地盘读不到（共享存储才行）。与其列出来再让用户撞一次错，
    不如一开始就只给能用的。
    """
    try:
        vms = await client.get(f"/nodes/{node}/qemu")
    except ProxmoxError as exc:
        raise ReinstallError(f"读取虚拟机列表失败：{exc.message}") from exc

    out: List[Dict[str, Any]] = []
    for item in vms or []:
        vmid = item.get("vmid")
        if not vmid:
            continue
        try:
            cfg = await client.get(f"/nodes/{node}/qemu/{vmid}/config")
        except ProxmoxError:
            continue
        if not cfg.get("template"):
            continue
        _, volid = boot_disk(cfg)
        out.append(
            {
                "node": node,
                "vmid": int(vmid),
                "name": str(cfg.get("name") or item.get("name") or vmid),
                "ostype": str(cfg.get("ostype") or ""),
                "disk": volid,
                "size": int(item.get("maxdisk") or 0),
                "used": int(item.get("disk") or 0),
                "cloudinit": bool(cfg.get("ciuser") or cfg.get("citype")),
            }
        )
    out.sort(key=lambda row: row["vmid"])
    return out


async def _volids(client: Any, node: str, storage: str, vmid: int) -> Set[str]:
    try:
        items = await client.storage_content(node, storage, content="images") or []
    except ProxmoxError:
        return set()
    return {
        str(item.get("volid"))
        for item in items
        if item.get("vmid") == vmid and item.get("volid")
    }


async def _wait(client: Any, result: Any, timeout: float = IMPORT_TIMEOUT) -> None:
    upid = result if isinstance(result, str) else (result or {}).get("task", "")
    if isinstance(upid, str) and upid.startswith("UPID:"):
        await client.wait_for_task(upid, timeout=timeout)


async def _delete_volume(client: Any, node: str, volid: str) -> Tuple[bool, str]:
    """删掉一个卷。失败不抛，交给调用方决定是降级保留还是报错。"""
    storage = volid.split(":", 1)[0]
    try:
        await client.delete(
            f"/nodes/{node}/storage/{storage}/content/{quote(volid, safe='')}"
        )
        return True, ""
    except ProxmoxError as exc:
        return False, exc.message


async def _volume_exists(client: Any, node: str, volid: str) -> bool:
    """这块卷现在还在不在。

    用**单卷查询**而不是列存储内容：PVE 的卷列表有十几秒缓存，刚发生的删除在里面
    还看不见 —— 拿它判断会把「已经没了」读成「还在」，然后给机器挂上一块空盘。
    """
    storage = volid.split(":", 1)[0]
    try:
        await client.get(
            f"/nodes/{node}/storage/{storage}/content/{quote(volid, safe='')}"
        )
        return True
    except ProxmoxError:
        return False


#: ``ipconfigN`` 里的 ``ip=`` / ``gw=``（重装要「沿用原网络」，得连掩码一起读回来）
_IPCONFIG_IP_RE = re.compile(r"(?:^|,)\s*ip=([^,]+)")
_IPCONFIG_GW_RE = re.compile(r"(?:^|,)\s*gw=([^,]+)")


def network_from_config(cfg: Dict[str, Any]) -> Dict[str, str]:
    """读出原虚拟机在用的网络参数，重装时默认沿用它。

    返回 ``{"mode": "static"|"dhcp"|"", "ip": "10.0.0.10/24", "gateway": "10.0.0.1"}``
    —— ``mode`` 为空串表示这台机器没配过 cloud-init 网络（老机器手工配的地址不在
    PVE 里），界面自己决定用什么兜底。

    为什么 ``ip=`` 整段原样带回、连 ``/24`` 都不拆：``ipconfigN`` 的语法是
    ``ip=<地址>/<掩码>`` 加一段独立的 ``gw=``。拆开再拼回去，掩码这份唯一的信息就
    没了 —— 结果是重装后机器掉进另一个网段、网关不通，而用户盯着界面上那个熟悉的
    地址，怎么也想不通问题出在后缀上。

    只看虚拟机的 ``ipconfigN``（容器的 ``netN`` 用不上：这里是虚拟机的流水线）。
    """
    for key in sorted(k for k in (cfg or {}) if re.match(r"^ipconfig\d+$", str(k))):
        raw = str((cfg or {}).get(key) or "")
        match = _IPCONFIG_IP_RE.search(raw)
        if not match:
            continue
        value = match.group(1).strip()
        if not value:
            continue
        low = value.lower()
        if low in ("dhcp", "auto"):
            return {"mode": "dhcp", "ip": "", "gateway": ""}
        if low in ("manual", "none"):
            # 手工配置：里面写的地址面板管不着，接着看下一张网卡有没有静态的
            continue
        gateway = _IPCONFIG_GW_RE.search(raw)
        return {
            "mode": "static",
            "ip": value,
            "gateway": gateway.group(1).strip() if gateway else "",
        }
    return {"mode": "", "ip": "", "gateway": ""}


async def _wipe_data_disks(
    client: Any,
    *,
    node: str,
    vmid: int,
    config: Dict[str, Any],
    boot_key: str,
    record: Callable[[str, bool, str], None],
) -> None:
    """删掉系统盘之外的所有数据盘（连卷一起）。

    只认真正的磁盘键（``scsi*`` / ``virtio*`` / ``sata*`` / ``ide*``）：

    * ``efidisk0`` / ``tpmstate0`` 是**固件盘**，删了机器直接起不来 —— 它们不匹配
      这些前缀，天然被排除；
    * 带 ``media=cdrom`` 的是光驱（ISO 与 cloud-init 盘），不是数据盘。

    顺序不能反：**先从配置里摘掉引用，再逐个删卷**。反过来的话 PVE 会因为「卷仍被
    引用」拒绝删除；而只摘引用不删卷，则会在存储上留下没人认领的孤儿卷。
    """
    targets: List[Tuple[str, str]] = []
    for key, value in (config or {}).items():
        if not _is_disk_key(str(key)) or str(key) == boot_key:
            continue
        if "media=cdrom" in str(value):
            continue
        volid = _volid_of(value)
        if volid:
            targets.append((str(key), volid))

    if not targets:
        record("删除数据盘", True, "机器上没有额外数据盘")
        return

    try:
        await client.put(
            f"/nodes/{node}/qemu/{vmid}/config",
            data={"delete": ",".join(key for key, _ in targets)},
        )
    except ProxmoxError as exc:
        record("删除数据盘", False, f"从配置里摘除失败：{exc.message}")
        return

    kept: List[str] = []
    for _key, volid in targets:
        ok, message = await _delete_volume(client, node, volid)
        if not ok:
            kept.append(f"{volid}（{message}）")
    if kept:
        record(
            "删除数据盘",
            False,
            "以下卷删除失败，已作为未使用磁盘留在机器上：" + "、".join(kept),
        )
    else:
        record("删除数据盘", True, "、".join(volid for _, volid in targets))



#: 重建后要从旧机器写回来的配置键。用**白名单**而不是排除法：PVE 的配置键会随
#: 版本增减，黑名单一旦漏掉一个（比如将来多出某个磁盘前缀），旧磁盘就会被带回
#: 新机器上 —— 而那些卷已经随旧机器删掉了，轻则挂载失败，重则盘位撞车。
_KEEP_KEYS = (
    "cores", "sockets", "cpu", "cpulimit", "cpuunits", "vcpus",
    "memory", "balloon", "shares",
    "numa", "affinity", "machine", "bios", "ostype", "scsihw",
    "kvm", "acpi", "tablet", "vga", "args", "hugepages", "localtime",
    "onboot", "startup", "protection", "hookscript", "agent",
    "tags", "description", "smbios1",
    # 刻意不含 vmgenid：PVE 只允许 root 设它（API token 权限再高也不行），
    # 而它本来就是 PVE 生成的随机标识，重装后换一个没有实际影响
)
#: 同上，按前缀匹配（net0 / hostpci0 / usb0 / serial0 / rng0 / numa0 …）
_KEEP_PREFIXES = ("net", "hostpci", "usb", "serial", "rng", "audio", "numa")


def identity_overrides(old_config: Dict[str, Any]) -> Dict[str, Any]:
    """重建后要写回新机器的「身份」：网卡（含 MAC）、CPU/内存、标签、直通设备…

    刻意**不含**磁盘与 cloud-init：磁盘已经随旧机器删掉了，cloud-init 则由这次
    重装的参数重新下发。``efidisk0`` / ``tpmstate0`` 单独处理（见
    :func:`firmware_overrides`）—— 它们也是盘，但少了机器起不来。
    """
    out: Dict[str, Any] = {}
    for key, value in (old_config or {}).items():
        name = str(key)
        if name in _KEEP_KEYS or name.startswith(_KEEP_PREFIXES):
            out[name] = value
    return out


def firmware_overrides(old_config: Dict[str, Any]) -> Dict[str, Any]:
    """EFI 变量盘 / TPM 状态盘：也是磁盘，会随旧机器一起消失，重建时得重新开一块。

    不重建的后果很实在：UEFI 启动的机器（以及 Windows 11）重装完直接起不来。
    参数里的卷 ID 换成「存储 + 大小」形式，交给 PVE 自己分配新卷。
    """
    out: Dict[str, Any] = {}
    efi = str((old_config or {}).get("efidisk0") or "")
    if efi:
        storage = efi.split(":", 1)[0]
        efitype = "4m" if "efitype=4m" in efi else "2m"
        pre = "1" if "pre-enrolled-keys=1" in efi else "0"
        out["efidisk0"] = f"{storage}:1,efitype={efitype},pre-enrolled-keys={pre}"
    tpm = str((old_config or {}).get("tpmstate0") or "")
    if tpm:
        storage = tpm.split(":", 1)[0]
        version = "v2.0" if "version=v2.0" in tpm else "v1.2"
        out["tpmstate0"] = f"{storage}:4,version={version}"
    return out


async def _apply_cloudinit(
    client: Any,
    *,
    node: str,
    vmid: int,
    hostname: Optional[str],
    ci_user: Optional[str],
    ci_password: Optional[str],
    ssh_keys: Optional[str],
    ip_mode: str,
    ip: Optional[str],
    gateway: Optional[str],
    dns: Optional[str],
    record: Callable[[str, bool, str], None],
) -> None:
    """把账号 / 网络 / 主机名写进 cloud-init。两条重装路线都要走这一步。"""
    ci: Dict[str, Any] = {}
    if hostname:
        # PVE 的 cloud-init 用虚拟机名做客户机 hostname，没有独立的 hostname 参数
        ci["name"] = hostname
    if ci_user:
        ci["ciuser"] = ci_user
    if ci_password:
        ci["cipassword"] = ci_password
    if ssh_keys:
        try:
            ci["sshkeys"] = vmconfig._encode_ssh_keys(ssh_keys)
        except Exception as exc:  # noqa: BLE001 - 公钥格式不对时别把整个重装搞失败
            record("注入 SSH 公钥", False, str(exc))
    net, nameserver = _ip_config(ip_mode, ip, gateway, dns)
    ci.update(net)
    if nameserver:
        ci["nameserver"] = nameserver
    if not ci:
        return
    try:
        await _wait(
            client,
            await client.put(f"/nodes/{node}/qemu/{vmid}/config", data=ci),
        )
        record("注入 cloud-init", True, "、".join(k for k in ci if k != "cipassword"))
    except ProxmoxError as exc:
        # 系统盘已经换好了，cloud-init 失败不该让整件事看起来失败
        record("注入 cloud-init", False, f"{exc.message}（系统盘已替换，可手工补配置）")


async def _wait_guest_gone(
    client: Any, *, node: str, vmid: int, timeout: float = 60.0
) -> None:
    """等 PVE 把这台机器的配置真正删掉。

    ``DELETE .../qemu/{vmid}`` 返回得很快，配置文件的收尾却要一会儿。紧接着的
    克隆会以「unable to create VM xxx: config file already exists」直接失败 ——
    而那一刻旧机器已经被删掉了，代价最大。所以宁可在这里多等几秒。
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            await client.get(f"/nodes/{node}/qemu/{vmid}/config")
        except ProxmoxError:
            return  # 已经读不到了，删干净
        await asyncio.sleep(0.5)
    raise ReinstallError(
        f"删除后等了 {int(timeout)} 秒，VMID {vmid} 仍被占用，重建中止。请稍后重试。"
    )


async def _start_guest(
    client: Any, *, node: str, vmid: int, record: Callable[[str, bool, str], None]
) -> None:
    """可选启动，失败只记一步。"""
    try:
        await _wait(
            client,
            await client.post(f"/nodes/{node}/qemu/{vmid}/status/start"),
            timeout=300,
        )
        record("启动虚拟机", True)
    except ProxmoxError as exc:
        record("启动虚拟机", False, exc.message)


async def _reclone(
    client: Any,
    *,
    node: str,
    vmid: int,
    old_config: Dict[str, Any],
    old_name: str,
    template_node: str,
    template_vmid: int,
    target_storage: str,
    hostname: Optional[str],
    ci_user: Optional[str],
    ci_password: Optional[str],
    ssh_keys: Optional[str],
    ip_mode: str,
    ip: Optional[str],
    gateway: Optional[str],
    dns: Optional[str],
    start: bool,
    record: Callable[[str, bool, str], None],
) -> Dict[str, Any]:
    """删掉这台机器，再用**同一个 VMID** 从模板链接克隆一台回来。

    为什么非要是「删了重建」，而不是「把模板的系统盘挪过来」：PVE 在 dir 存储上
    不让 linked 卷离开它出生的那台机器 —— 清掉引用会被当成「释放这块盘」，留着
    引用则会被删机器时一起带走（两条路都实测过，报的是
    `volume '...' does not exist`）。唯一能让卷「生来就属于这台机器」的路径，
    就是让 PVE 自己以这个 VMID 做一次克隆。

    代价必须说在明处：**删除之后、克隆成功之前，这台机器不存在**。所以克隆失败
    时会立刻用完整克隆再试一次（不需要同存储，慢但能成）—— 绝不让用户回来看到
    一台凭空消失的机器。
    """
    old_key, old_volid = boot_disk(old_config)

    # ---- 1. 删除旧机器：旧系统盘与数据盘一并清除 ----------------------
    try:
        await client.delete(
            f"/nodes/{node}/qemu/{vmid}?purge=1&destroy-unreferenced-disks=1"
        )
    except ProxmoxError as exc:
        raise ReinstallError(
            f"删除旧机器失败：{exc.message}。这台机器还没有被动过。"
        ) from exc
    record("删除旧机器", True, f"{node}/{vmid}（旧磁盘一并清除）")

    # 等配置文件真的消失再克隆：DELETE 只是「已受理」，收尾还要一会儿，
    # 而这期间克隆会直接失败 —— 那一刻机器已经没了，绝不能卡在这儿
    await _wait_guest_gone(client, node=node, vmid=vmid)

    # ---- 2. 以同一个 VMID 链接克隆回来 --------------------------------
    linked = False
    try:
        await _wait(
            client,
            await client.qemu_clone(
                template_node, template_vmid, vmid, name=old_name, full=False
            ),
            timeout=CLONE_TIMEOUT,
        )
        linked = True
        record(
            "链接克隆",
            True,
            f"模板 {template_node}/{template_vmid} → {node}/{vmid}",
        )
    except Exception as exc:  # noqa: BLE001 - 换一条路再试，不让机器就这么没了
        detail = " ".join(str(exc).split())
        record("链接克隆", False, f"{detail}（改用完整克隆）")

    if not linked:
        try:
            await _wait(
                client,
                await client.qemu_clone(
                    template_node,
                    template_vmid,
                    vmid,
                    name=old_name,
                    full=True,
                    target_storage=target_storage,
                ),
                timeout=IMPORT_TIMEOUT,
            )
            record(
                "完整克隆",
                True,
                f"模板 {template_node}/{template_vmid} → {node}/{vmid}（{target_storage}）",
            )
        except ProxmoxError as exc:
            raise ReinstallError(
                f"重建失败：旧机器已删除，克隆也没能成功（{exc.message}）。"
                f"请到模板页手动克隆一台 VMID 为 {vmid} 的机器。"
            ) from exc

    # ---- 3. 把「身份」写回去 -------------------------------------------
    restored = {**identity_overrides(old_config), **firmware_overrides(old_config)}
    if restored:
        try:
            await client.qemu_set_config(node, vmid, restored)
            record("恢复原有配置", True, "、".join(sorted(restored)))
        except ProxmoxError as exc:
            # PVE 对少数参数是「只有 root 能设」的硬限制（args / hookscript / 直通
            # 设备之类），API token 权限再高也过不去。整批写一次就全废 —— 连网卡
            # MAC 都跟着丢，所以这里退化成逐项：能恢复多少恢复多少。
            detail = " ".join(str(exc).split())
            ok_keys: List[str] = []
            bad_keys: List[str] = []
            for key, value in sorted(restored.items()):
                try:
                    await client.qemu_set_config(node, vmid, {key: value})
                    ok_keys.append(key)
                except ProxmoxError:
                    bad_keys.append(key)
            if ok_keys:
                record("恢复原有配置", True, "、".join(ok_keys))
            if bad_keys:
                record(
                    "恢复原有配置",
                    False,
                    f"以下项需要更高权限，没能恢复：{'、'.join(bad_keys)}（{detail}）",
                )

    # ---- 4. cloud-init 与启动 -----------------------------------------
    await _apply_cloudinit(
        client,
        node=node,
        vmid=vmid,
        hostname=hostname,
        ci_user=ci_user,
        ci_password=ci_password,
        ssh_keys=ssh_keys,
        ip_mode=ip_mode,
        ip=ip,
        gateway=gateway,
        dns=dns,
        record=record,
    )
    if start:
        await _start_guest(client, node=node, vmid=vmid, record=record)

    new_config = await client.get(f"/nodes/{node}/qemu/{vmid}/config") or {}
    new_key, new_volid = boot_disk(new_config)
    return {
        "node": node,
        "vmid": vmid,
        "template": {"node": template_node, "vmid": template_vmid},
        "old_volume": old_volid,
        "new_volume": new_volid,
        "system_disk": new_key or old_key,
        "steps": [],
    }


async def _linked_clone_disk(
    client: Any,
    *,
    template_node: str,
    template_vmid: int,
    target_node: str,
    target_vmid: int,
    source_volid: str,
    target_storage: str,
    slot: str,
    record: Callable[[str, bool, str], None],
) -> Optional[str]:
    """借道链接克隆造一块新系统盘，成功返回卷 ID；做不到返回 None（调用方回退整盘复制）。

    PVE 没有「把某个卷链接克隆到一台已有虚拟机」的接口 —— 克隆 API 只能产出**一台
    新虚拟机**。所以这里借道：先把模板链接克隆成一台临时机器（产物正是那块以模板
    母盘为 backing file / thin snapshot 的链接卷），把它的系统盘从临时机器上摘下来
    （先 detach 成 unused，再删掉这条引用 —— 卷本身留着），挂到目标机器的盘位上，
    最后删掉临时机器。

    两条硬约束：
    * **必须与模板同存储**：链接卷靠 backing file 指向母盘，换个存储就没有基点了，
      PVE 也会直接拒绝；
    * **中途任何一步失败都要把自己造的东西收拾干净**（临时机器、临时盘位、已经挂上
      的卷），否则用户会平白多出一台名字奇怪的机器和一个没人认领的卷。
    """
    source_storage = source_volid.split(":", 1)[0]
    if source_storage != target_storage:
        record(
            "链接克隆",
            False,
            f"模板磁盘在 {source_storage}、目标存储是 {target_storage}，"
            "链接克隆要求同存储（已自动改用整盘复制）",
        )
        return None

    tmp_vmid = 0
    created_volid = ""
    attached = False
    try:
        nextid = await client.get("/cluster/nextid")
        tmp_vmid = int(str(nextid or "").strip())
        # full=False 即链接克隆：以模板母盘为基点增量生成，秒级完成、几乎不占空间
        await _wait(
            client,
            await client.qemu_clone(
                template_node,
                template_vmid,
                tmp_vmid,
                name=f"proxcenter-reinstall-{target_vmid}",
                full=False,
            ),
            timeout=CLONE_TIMEOUT,
        )

        tmp_cfg = await client.get(f"/nodes/{target_node}/qemu/{tmp_vmid}/config") or {}
        disk_key, created_volid = boot_disk(tmp_cfg)
        if not created_volid:
            record("链接克隆", False, "临时机器上没有系统盘，改用整盘复制")
            return None

        # 1) 先把目标盘从临时机器上摘下来 —— 它会变成这块临时机器上的 unused 卷。
        await client.put(
            f"/nodes/{target_node}/qemu/{tmp_vmid}/config", data={"delete": disk_key}
        )

        # 2) 紧接着把它挂到目标机器上。
        await client.put(
            f"/nodes/{target_node}/qemu/{target_vmid}/config",
            data={slot: f"{created_volid},discard=on"},
        )
        attached = True

        # 3) 删掉临时机器。
        #
        # 这里刻意**不**先去清它 config 里留下的那条 unused 引用：实测
        # `delete unusedN` 会把卷连同数据一起释放掉 —— 哪怕目标机器正引用着它
        # （删完再挂，得到的就是 `volume '...' does not exist`）。留下一条悬空
        # 引用只是让 destroy 少删一块盘，两害相权取其轻。
        await client.delete(
            f"/nodes/{target_node}/qemu/{tmp_vmid}?purge=1&destroy-unreferenced-disks=0"
        )
        tmp_vmid = 0  # 已经删掉了，finally 里不必再删一次

        # 4) 确认这块盘真的活下来了。PVE 的存储「列表」有十几秒缓存，所以用单卷
        #    查询。没保住就摘掉目标机器上的盘、回退整盘复制 —— 绝不能让一台机器
        #    挂着一块不存在的盘（那比慢几分钟严重得多）。
        if not await _volume_exists(client, target_node, created_volid):
            record("链接克隆", False, "临时机器删除后链接卷没能保住，改用整盘复制")
            try:
                await client.put(
                    f"/nodes/{target_node}/qemu/{target_vmid}/config",
                    data={"delete": slot},
                )
            except ProxmoxError:
                pass
            return None
        record(
            "链接克隆系统盘",
            True,
            f"{created_volid}（盘位 {slot}，基点 {source_volid}）",
        )
        return created_volid
    except Exception as exc:  # noqa: BLE001 - 任何一步失败都回退整盘复制，不让重装因此失败
        # PVE 的报错自带换行，直接拼后缀会断成两行（看起来像两条记录）。
        # 压成一行，并把「改用整盘复制」放在括号里 —— 它是这行的结论，不是另一条步骤。
        detail = " ".join(str(exc).split())
        record("链接克隆", False, f"{detail}（已自动改用整盘复制）")
        if attached:
            try:
                await client.put(
                    f"/nodes/{target_node}/qemu/{target_vmid}/config",
                    data={"delete": slot},
                )
            except ProxmoxError:
                pass
        if created_volid:
            await _delete_volume(client, target_node, created_volid)
        return None
    finally:
        if tmp_vmid:
            # 删临时机器。destroy-unreferenced-disks=0：这时卷已经不在它名下，
            # 不能让 PVE 顺手把目标机器马上要用的盘删了
            try:
                await client.delete(
                    f"/nodes/{target_node}/qemu/{tmp_vmid}"
                    "?purge=1&destroy-unreferenced-disks=0"
                )
            except ProxmoxError:
                logger.warning(
                    "重装用的临时机器 %s 清理失败，请在虚拟机列表里手工删除", tmp_vmid
                )


def _ip_config(
    ip_mode: str,
    ip: Optional[str],
    gateway: Optional[str],
    dns: Optional[str],
) -> Tuple[Dict[str, Any], Optional[str]]:
    """把向导里的网络选择翻成 PVE 的 cloud-init 参数。"""
    if ip_mode == "static":
        if not ip:
            raise ReinstallError("选了静态 IP，但没填地址")
        value = f"ip={ip}"
        if gateway:
            value += f",gw={gateway}"
        return {"ipconfig0": value}, dns
    return {"ipconfig0": "ip=dhcp"}, dns


async def reinstall(
    client: Any,
    *,
    node: str,
    vmid: int,
    template_node: str,
    template_vmid: int,
    target_storage: str,
    hostname: Optional[str] = None,
    ci_user: Optional[str] = None,
    ci_password: Optional[str] = None,
    ssh_keys: Optional[str] = None,
    ip_mode: str = "dhcp",
    ip: Optional[str] = None,
    gateway: Optional[str] = None,
    dns: Optional[str] = None,
    start: bool = False,
    wipe_data_disks: bool = True,
    on_step: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """执行重装，返回每一步的结果（供界面展示与审计）。

    ``on_step`` 每记下一步就回调一次：后台作业靠它把进度实时写进作业记录，用户
    中途打开界面能看到「正在复制系统盘」，而不是一个不知道在干什么的转圈。
    回调是旁路 —— 它抛异常只记日志，绝不能让重装本身失败。
    """
    steps: List[Dict[str, Any]] = []

    def record(step: str, ok: bool, detail: str = "") -> None:
        item = {"step": step, "ok": ok, "detail": detail}
        steps.append(item)
        if on_step is not None:
            try:
                on_step(item)
            except Exception:  # noqa: BLE001 - 记进度坏了不该影响重装
                logger.warning("重装进度回调失败", exc_info=True)

    # ---- 1. 前置校验：必须关机 --------------------------------------
    try:
        status = await client.get(f"/nodes/{node}/qemu/{vmid}/status/current")
    except ProxmoxError as exc:
        raise ReinstallError(f"读取虚拟机状态失败：{exc.message}") from exc
    if str((status or {}).get("status") or "") != "stopped":
        raise ReinstallError(
            "虚拟机正在运行，无法重装。重装会替换整块系统盘：请先关机，再回来操作。"
        )

    # ---- 2. 模板与源卷 ----------------------------------------------
    try:
        tpl_cfg = await client.get(f"/nodes/{template_node}/qemu/{template_vmid}/config")
    except ProxmoxError as exc:
        raise ReinstallError(f"读取模板失败：{exc.message}") from exc
    if not tpl_cfg.get("template"):
        raise ReinstallError("所选虚拟机的类型不是「模板」，不能作为重装来源")
    _, source_volid = boot_disk(tpl_cfg)
    if not source_volid:
        raise ReinstallError("这个模板没有系统盘，无法作为重装来源")
    record("校验模板", True, f"{template_node}/{template_vmid} → {source_volid}")

    # ---- 3. 当前配置 / 旧系统盘 --------------------------------------
    try:
        config = await client.get(f"/nodes/{node}/qemu/{vmid}/config")
    except ProxmoxError as exc:
        raise ReinstallError(f"读取虚拟机配置失败：{exc.message}") from exc
    old_key, old_volid = boot_disk(config)
    if not old_key:
        raise ReinstallError("这台虚拟机当前没有系统盘，请改用「新建」或「导入」")

    # ---- 4a. 默认路线：删掉这台机器，用同一个 VMID 链接克隆回来 --------
    #
    # 链接克隆要求卷「生来就属于这台机器」，而 PVE 只在自己克隆新机器时才这么干，
    # 所以「把模板的盘挪过来」那条路是走不通的（见 _reclone 的说明）。代价是：
    # 删除之后、克隆成功之前机器不存在 —— 因此克隆失败会自动改用完整克隆兜底。
    #
    # 只有「要保留数据盘」时才走下面的换盘路线：那种情况下机器不能删，也就只能
    # 老老实实整盘复制系统盘。
    if wipe_data_disks:
        result = await _reclone(
            client,
            node=node,
            vmid=vmid,
            old_config=config,
            old_name=str(config.get("name") or f"VM {vmid}"),
            template_node=template_node,
            template_vmid=template_vmid,
            target_storage=target_storage,
            hostname=hostname,
            ci_user=ci_user,
            ci_password=ci_password,
            ssh_keys=ssh_keys,
            ip_mode=ip_mode,
            ip=ip,
            gateway=gateway,
            dns=dns,
            start=start,
            record=record,
        )
        result["steps"] = steps
        return result

    # ---- 4b. 保留数据盘的路线：换盘（整盘复制系统盘） ------------------
    slot = free_slot(config)
    # 首选链接克隆：秒级完成、几乎不占空间。做不到时（跨存储、存储不支持 backing
    # file / thin snapshot）回退到整盘复制 —— 慢，但不会让重装因此失败。
    new_volid = await _linked_clone_disk(
        client,
        template_node=template_node,
        template_vmid=template_vmid,
        target_node=node,
        target_vmid=vmid,
        source_volid=source_volid,
        target_storage=target_storage,
        slot=slot,
        record=record,
    ) or ""
    if not new_volid:
        before = await _volids(client, node, target_storage, vmid)
        try:
            await _wait(
                client,
                await client.put(
                    f"/nodes/{node}/qemu/{vmid}/config",
                    data={slot: f"{target_storage}:0,import-from={source_volid},discard=on"},
                ),
            )
        except ProxmoxError as exc:
            raise ReinstallError(
                f"从模板复制系统盘失败：{exc.message}。"
                "请确认目标存储可用空间足够（复制期间新旧两份盘同时存在），"
                "以及模板所在节点能访问它的磁盘。"
            ) from exc
        after = await _volids(client, node, target_storage, vmid)
        new_volids = sorted(after - before)
        new_volid = new_volids[-1] if new_volids else ""
        if not new_volid:
            raise ReinstallError(
                "新系统盘没有出现在存储上，重装中止（原系统盘未受影响）"
            )
        record("复制模板系统盘", True, f"{new_volid}（盘位 {slot}）")

    # ---- 5. 换盘：新盘接到原系统盘位，摘掉临时盘位 --------------------
    try:
        await _wait(
            client,
            await client.put(
                f"/nodes/{node}/qemu/{vmid}/config",
                data={old_key: f"{new_volid},discard=on", "delete": slot},
            ),
        )
        await _wait(
            client,
            await client.put(
                f"/nodes/{node}/qemu/{vmid}/config",
                data={"boot": f"order={old_key}"},
            ),
        )
    except ProxmoxError as exc:
        # 换盘失败：把新盘从盘位上摘掉，原样退回（旧盘一直在 old_key 上没动过）
        try:
            await client.put(
                f"/nodes/{node}/qemu/{vmid}/config",
                data={"delete": slot},
            )
        except ProxmoxError:
            pass
        await _delete_volume(client, node, new_volid)
        raise ReinstallError(
            f"切换系统盘失败：{exc.message}。已回滚到原来的系统盘。"
        ) from exc
    record("切换系统盘", True, f"{old_key} → {new_volid}")

    # ---- 6. 旧盘：连卷一起删除 ---------------------------------------
    # 刻意不给「保留旧盘以便回滚」这个选项：用户真正想回滚的场景只有「刚装完
    # 发现参数填错了」，而那再做一次重装就够了；反过来说，留一块几十 GB 的
    # 旧盘挂在机器上，才是「空间被悄悄吃掉、还没人记得是谁留的」的常见来源。
    # 唯一的例外见下面 base- 那段：模板母盘不能删。
    if old_volid and old_volid != new_volid:
        if old_volid.split("/", 1)[-1].startswith("base-"):
            # 模板的 base 卷是所有克隆共享的只读母盘 —— 删掉它会毁掉整个模板
            record("删除旧系统盘", False, f"{old_volid} 是模板母盘（base-），已保留")
        else:
            ok, message = await _delete_volume(client, node, old_volid)
            record("删除旧系统盘", ok, old_volid if ok else f"删除失败，已保留：{message}")

    # ---- 6b. 数据盘：默认一起删掉 ------------------------------------
    # 「重装」的语义是这台机器回到干净状态，所以额外挂的数据盘默认也清掉 ——
    # 要留数据的用户可以在向导里把开关取消（见 VmReinstallWizard）。
    if wipe_data_disks:
        await _wipe_data_disks(
            client, node=node, vmid=vmid, config=config, boot_key=old_key, record=record
        )

    # ---- 7. cloud-init：账号 / 网络 / 主机名 --------------------------
    await _apply_cloudinit(
        client,
        node=node,
        vmid=vmid,
        hostname=hostname,
        ci_user=ci_user,
        ci_password=ci_password,
        ssh_keys=ssh_keys,
        ip_mode=ip_mode,
        ip=ip,
        gateway=gateway,
        dns=dns,
        record=record,
    )

    # ---- 8. 可选启动 --------------------------------------------------
    if start:
        await _start_guest(client, node=node, vmid=vmid, record=record)

    return {
        "node": node,
        "vmid": vmid,
        "template": {"node": template_node, "vmid": template_vmid},
        "old_volume": old_volid,
        "new_volume": new_volid,
        "system_disk": old_key,
        "steps": steps,
    }


# ===========================================================================
# 后台作业：提交即返回，复制系统盘那几分钟在服务端跑
# ===========================================================================
#
# 为什么非要这一层：重装的绝大部分时间花在「复制模板的系统盘」上（几十 GB 的镜像
# 是几分钟起步）。把它放在一个 HTTP 请求里跑完，用户就只能盯着一个转圈的弹窗 ——
# 关掉就再也不知道结果，刷新更是什么都看不见。作业化之后提交瞬间返回，进度留在
# 服务端，界面随时可以回来查。


class ReinstallJob:
    """一次重装的作业记录。

    和导出作业一样只存在进程内存里：重启面板会丢记录，但机器上的改动是真实发生
    过的，丢的只是「这次跑到哪了」的展示。
    """

    def __init__(
        self,
        *,
        owner: str,
        connection: str,
        node: str,
        vmid: int,
        name: str,
        template: str,
        storage: str,
    ) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.owner = owner
        self.connection = connection
        self.node = node
        self.vmid = vmid
        self.name = name
        self.template = template
        self.storage = storage
        self.status = "running"          # running / success / failed
        self.stage = ""                  # 当前正在做的一步（给界面看）
        self.detail = ""                 # 失败原因；成功时是新系统盘卷名
        self.steps: List[Dict[str, Any]] = []
        self.old_volume = ""
        self.new_volume = ""
        self.created = time.time()
        self.finished = 0.0
        self.task: Optional[asyncio.Task[Any]] = None

    def add_step(self, item: Dict[str, Any]) -> None:
        """收下重装流水线的一步（由 ``reinstall`` 的 on_step 回调驱动）。"""
        self.steps.append(item)
        self.stage = str(item.get("step") or self.stage)

    def public(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "owner": self.owner,
            "connection": self.connection,
            "node": self.node,
            "vmid": self.vmid,
            "name": self.name,
            "template": self.template,
            "storage": self.storage,
            "status": self.status,
            "stage": self.stage,
            "detail": self.detail,
            "steps": self.steps,
            "old_volume": self.old_volume,
            "new_volume": self.new_volume,
            "created": self.created,
            "finished": self.finished,
        }


#: 进程内作业表（同导出作业：只留最近 50 条，多出来的从最旧的开始淘汰）
_JOBS: Dict[str, ReinstallJob] = {}
_MAX_JOBS = 50


def get_job(job_id: str) -> Optional[ReinstallJob]:
    return _JOBS.get(job_id)


def list_jobs() -> List[ReinstallJob]:
    return sorted(_JOBS.values(), key=lambda job: job.created, reverse=True)


def _prune_jobs() -> None:
    if len(_JOBS) <= _MAX_JOBS:
        return
    for job in sorted(_JOBS.values(), key=lambda item: item.created):
        if job.status == "running":
            # 正在跑的绝不能淘汰：那会让用户以为重装没发生过
            continue
        _JOBS.pop(job.id, None)
        if len(_JOBS) <= _MAX_JOBS:
            break


async def start_reinstall(
    client: Any,
    *,
    owner: str,
    connection: str,
    node: str,
    vmid: int,
    template_node: str,
    template_vmid: int,
    target_storage: str,
    hostname: Optional[str] = None,
    ci_user: Optional[str] = None,
    ci_password: Optional[str] = None,
    ssh_keys: Optional[str] = None,
    ip_mode: str = "dhcp",
    ip: Optional[str] = None,
    gateway: Optional[str] = None,
    dns: Optional[str] = None,
    start: bool = False,
    wipe_data_disks: bool = True,
) -> ReinstallJob:
    """提交一次重装：**先当场校验，再扔到后台跑**。

    校验刻意留在这里而不是后台协程里。能立刻发现的拒绝（机器还开着、参数不对）
    必须立刻告诉用户 —— 否则他填完参数、点了开始、弹窗也关了，过几秒才收到一条
    「虚拟机正在运行」，那些参数等于白填一遍。
    """
    try:
        status = await client.get(f"/nodes/{node}/qemu/{vmid}/status/current")
    except ProxmoxError as exc:
        raise ReinstallError(f"读取虚拟机状态失败：{exc.message}") from exc
    if str((status or {}).get("status") or "") != "stopped":
        raise ReinstallError(
            "虚拟机正在运行，无法重装。重装会替换整块系统盘：请先关机，再回来操作。"
        )

    # 同一台机器不许有两份重装作业同时在跑：两条流水线会各自复制一块新盘、各自往
    # 同一个系统盘位上加盘，最后谁接上去说不准 —— 用户看到的可能是一台「装了一半」
    # 的机器。以前同步接口天然没有这个问题（第二次请求要排在第一次后面），改成
    # 后台作业之后，连点两下按钮就真的会并发。
    for existing in _JOBS.values():
        if (
            existing.status == "running"
            and existing.connection == connection
            and existing.node == node
            and existing.vmid == vmid
        ):
            raise ReinstallError(
                f"这台机器已经有一个重装作业在进行中（作业 {existing.id}）：等它结束后再重试。"
            )

    job = ReinstallJob(
        owner=owner,
        connection=connection,
        node=node,
        vmid=vmid,
        # 名字用**原来**的名字：用户认的是它。重装后改叫什么，那是另一回事
        name=str((status or {}).get("name") or f"{vmid}"),
        template=f"{template_node}/{template_vmid}",
        storage=target_storage,
    )
    kwargs: Dict[str, Any] = {
        "node": node,
        "vmid": vmid,
        "template_node": template_node,
        "template_vmid": template_vmid,
        "target_storage": target_storage,
        "hostname": hostname,
        "ci_user": ci_user,
        "ci_password": ci_password,
        "ssh_keys": ssh_keys,
        "ip_mode": ip_mode,
        "ip": ip,
        "gateway": gateway,
        "dns": dns,
        "start": start,
        "wipe_data_disks": wipe_data_disks,
    }
    _JOBS[job.id] = job
    _prune_jobs()
    # task 挂在作业上：事件循环对 create_task 的结果只持弱引用，被回收掉的话，
    # 一次跑到一半的重装会无声无息地消失
    job.task = asyncio.create_task(_run_reinstall(job, kwargs))
    return job


async def _run_reinstall(job: ReinstallJob, kwargs: Dict[str, Any]) -> None:
    """后台真正干活的地方。

    **这里不在 HTTP 请求里**：``get_client()`` 依赖请求级的 contextvar，早就被重置
    了，所以拿提交时记下的连接 id 重新取一个客户端（与导出作业同一套办法）。
    """
    try:
        client = client_for_connection(job.connection or "")
        result = await reinstall(client, on_step=job.add_step, **kwargs)
    except ReinstallError as exc:
        job.status = "failed"
        job.detail = str(exc)
    except ProxmoxError as exc:
        job.status = "failed"
        job.detail = exc.message
    except Exception as exc:  # noqa: BLE001 - 后台任务没人接异常，漏出去就是永远 running
        job.status = "failed"
        job.detail = f"{type(exc).__name__}: {exc}"
        logger.exception("重装作业 %s 异常结束", job.id)
    else:
        job.status = "success"
        job.old_volume = str(result.get("old_volume") or "")
        job.new_volume = str(result.get("new_volume") or "")
        job.detail = job.new_volume
    finally:
        job.finished = time.time()
        job.stage = ""
        # 结束的审计只能在这里写：提交那一条记的是「提交了」，而用户最关心的
        # 「到底换成功没有」发生在请求之外。没有 request 就没有客户端地址。
        await security.audit(
            None,
            {"username": job.owner},
            "vm.reinstall",
            # 与提交时同一种格式（「来源 -> 目标」）：详情页的「来源模板」就读这条，
            # job.template 是当时用的模板，换了模板这里自然就是新模板。
            target=f"{job.template} -> {job.node}/{job.vmid}",
            result="success" if job.status == "success" else "failed",
            detail=(
                f"作业 {job.id}：{job.template} → "
                f"{job.old_volume or '（无）'} ⇒ {job.new_volume or job.detail}"
            )[:400],
        )
        await _notify_job(job)


async def _notify_job(job: ReinstallJob) -> None:
    """把作业结果写进消息中心（并按该用户的邮件设置发一封）。

    界面上那个失败弹窗只在页面开着时有效，而「这次是链接克隆还是整盘复制」「新盘
    依赖不依赖模板」这类信息，恰恰决定用户事后能不能安全地删掉那个模板 —— 所以
    结果要落到一个他能回头查的地方。与告警邮件共用同一个用户开关：没开就不发。
    """
    if not job.owner:
        return
    ok = job.status == "success"
    try:
        async with alerting.recipient_language(job.owner):
            title = i18n.pick(
                f"{'已重装' if ok else '重装失败'}：{job.name}",
                f"{'Reinstalled' if ok else 'Reinstall failed'}: {job.name}",
            )
            rows = [
                i18n.pick(
                    f"位置：{job.node} / {job.vmid}",
                    f"Location: {job.node} / {job.vmid}",
                ),
                i18n.pick(
                    f"结果：{'成功' if ok else '失败'}",
                    f"Result: {'success' if ok else 'failed'}",
                ),
            ]
            if job.new_volume:
                rows.append(
                    i18n.pick(
                        f"新系统盘：{job.new_volume}",
                        f"New system disk: {job.new_volume}",
                    )
                )
            if not ok and job.detail:
                rows.append(i18n.pick(f"原因：{job.detail}", f"Reason: {job.detail}"))
            rows.append("")
            rows.append(i18n.pick("执行记录：", "Steps:"))
            for step in job.steps:
                mark = "✔" if step.get("ok") else "✘"
                detail = str(step.get("detail") or "")
                rows.append(
                    f"{mark} {step.get('step')}"
                    + (i18n.pick("：", ": ") + detail if detail else "")
                )
            body = "\n".join(rows)
            await notifications.push(
                job.owner,
                title=title,
                body=body,
                link=f"/vms/{job.node}/{job.vmid}",
                kind="reinstall",
                level="success" if ok else "danger",
            )
            sent, detail = await alerting.send_alert_email(job.owner, title, body)
        if not sent:
            logger.debug("重装结果没给 %s 发邮件：%s", job.owner, detail)
    except Exception:  # noqa: BLE001 - 通知失败不能影响作业收尾
        logger.warning("重装结果通知发送失败", exc_info=True)
