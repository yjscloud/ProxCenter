"""虚拟机导入 / 导出（VMware 互操作）。

两条链路的实现依据（都是实测出来的，不是猜的）：

**导入**走 PVE 9 的「import 内容 + import-from」机制。PVE 8.2 起 OVF/OVA 导入
由存储层承担，`importdisk` 这类端点**已经被移除**（`POST /nodes/{node}/qemu/{vmid}
/importdisk` 现在返回 501），取而代之的是：

1. 把 OVA / OVF(+VMDK) 等文件放进 dir 存储的 ``import`` 内容里；
2. ``GET /nodes/{node}/storage/{storage}/import-metadata?volume=import/xx.ova``
   由 PVE 自己解析 OVF/OVA，返回 ``create-args`` / ``disks`` / ``net`` / ``warnings``；
   注意 ``volume`` 是**不带存储前缀**的相对卷名 —— handler 内部是
   ``my $volid = "$storeid:$volume"``，多写一个前缀就会被当成卷名去解析而报错；
3. 建机时把每个磁盘写成 ``<目标存储>:0,import-from=<上一步给出的源卷>``，
   由 PVE 在配置阶段把镜像搬进目标存储。

**导出**没有 API 可用：PVE 既不提供整卷下载（``file-restore`` 只支持 PBS），
也没有导出端点（``qm`` 里连 ``disk export`` 子命令都没有，实测 ``qm --help``
只有 ``disk import``）。所以导出走面板已有的 SSH 通道：

    pvesm path <volid>            # 拿到卷在宿主机上的真实路径（块存储也行）
    qemu-img convert -O <fmt> ... # 转成 vmdk / qcow2 / raw
    tar -cf ...                  # 需要 OVA 时再打一个包

转换产物落在所选 dir 存储的 ``dump/proxcenter-export-<id>/`` 下，由本模块登记成
一个「导出作业」，前端轮询进度，下载走流式转发（与备份下载同一套做法）。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import shlex
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import sshremote

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- 通用小工具

# 卷名 / 文件名白名单：这些值会被拼进远程命令，严格限定字符集是防注入的第一道闸。
# 字符集与 PVE 的 ``$SAFE_CHAR_CLASS_RE = [a-zA-Z0-9\-\.\+\=\_]`` 对齐（含等号 ——
# 面板以前不收它，用户从别处拿来的文件名会被无谓地挡下来），额外要求首字符是字母或
# 数字：挡住 ``.`` 开头的隐藏文件与 ``-`` 开头的、会被命令行当成参数的写法。
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+=+-]*$")
# PVE 的磁盘总线：scsi0 / virtio0 / sata0 / ide0（含 esxi 导入可能出现的 nvme）
_DISK_KEY_RE = re.compile(r"^(scsi|virtio|sata|ide|nvme)\d+$")
#: PVE 9.2 实测：OVA 里的磁盘，key 可能**只是总线名**（``ide``）而没有
#: 盘位数字。只认上面的 ``<总线><数字>`` 会把它整条跳过。
_BUS_ONLY_RE = re.compile(r"^(scsi|virtio|sata|ide|nvme)$")
# 导出格式：磁盘镜像三种 + OVA 打包
EXPORT_FORMATS = ("vmdk", "qcow2", "raw", "ova")
# 建机时可用的磁盘总线（导入目标盘位的落点）。
#: ``ide`` 也在其中：老系统（尤其 VMware 上按传统方式装的）initramfs 里可能只有
#: ``ata_piix``，没有 virtio / ahci —— 把盘挂回 IDE 反而是唯一能让它起来的做法。
IMPORT_BUSES = ("scsi", "virtio", "sata", "ide")
#: 可选的 SCSI 控制器型号（与 PVE / 建机向导的取值一致）。
IMPORT_SCSIHW = (
    "virtio-scsi-single", "virtio-scsi-pci", "virtio-scsi",
    "lsi", "lsi53c810", "megasas", "pvscsi",
)
#: 没有源文件线索时的控制器 —— 面板历来的默认值，也是 KVM 系镜像的正常落点。
DEFAULT_SCSIHW = "virtio-scsi-single"
#: 允许的网卡型号。virtio 性能最好但需要系统里有 virtio 驱动；e1000 / e1000e 是
#: 最通用的传统型号，从别处搬来的系统几乎都认；vmxnet3 只有装了 VMware Tools 才有。
IMPORT_NET_MODELS = ("virtio", "e1000", "e1000e", "vmxnet3", "rtl8139")
#: 导入后目标磁盘的格式。默认 qcow2 —— 稀疏、便于快照与后续迁移；
#: 源是 vmdk 时若不指定，PVE 会照着源格式把 100GB 再转成 vmdk，又慢又大。
#: ZFS 存储不支持 qcow2，那种场景选 raw。
IMPORT_DISK_FORMATS = ("qcow2", "raw", "vmdk")
#: CPU 型号。默认值必须是 x86-64-v2-AES（PVE 8 往后的默认值）而不是「不设」——
#: 不设时 PVE 会退回 QEMU 默认的 qemu64，那是 x86-64 基线模型，不含 v2 要求的
#: SSE4.2 / POPCNT / CMPXCHG16B。host 性能最好但会关掉跨异构节点的在线迁移。
IMPORT_CPU_MODELS = ("x86-64-v2-AES", "host", "qemu64", "x86-64-v2")

EXPORT_DIR_NAME = "proxcenter-export"
#: 产物目录里的身份文件。作业表只在内存里，面板一重启「这份镜像是我导的」这条
#: 记录就没了，而几十 GB 的产物还占着磁盘 —— 靠它把产物认回来。
META_NAME = "export.json"


class TransferError(RuntimeError):
    """导入 / 导出过程中可以直接展示给用户的错误。"""


def _quote(value: str) -> str:
    return shlex.quote(value)


def check_name(value: str, label: str = "名称") -> str:
    text = str(value or "").strip()
    if not _SAFE_NAME_RE.match(text):
        raise TransferError(
            f"{label}不合法（只允许字母、数字、点、下划线、加号、减号、等号，"
            "且要以字母或数字开头）"
        )
    return text


#: 导出名里真正会出问题的字符：路径分隔符、引号、控制字符。
#: 刻意**不**复用 _SAFE_NAME_RE —— 那是给「导入」用的，保守到只认 ASCII；而用户
#: 给导出产物起名时想用的是「数据库备份-2026」这种。中文与空格在这条链路上是安全
#: 的：命令走 shlex.quote，下载走 RFC 5987 编码。
_BAD_NAME_RE = re.compile(r"[/\\\"'\x00-\x1f\x7f]")


def check_export_name(value: str, label: str = "镜像名称") -> str:
    """校验导出的产物名（它会直接变成文件名）。

    挡住的是会真正出事的东西：路径分隔符与 ``..``（写到目标目录之外）、引号与
    控制字符（破坏 .vmx 的键值行，或截断 shell 命令）、以及过长的名字。
    """
    text = str(value or "").strip()
    if not text:
        raise TransferError(f"{label}不能为空")
    if len(text) > 64:
        raise TransferError(f"{label}太长，最多 64 个字符")
    if _BAD_NAME_RE.search(text):
        raise TransferError(f"{label}含不能用于文件名的字符（斜杠、反斜杠、引号或控制字符）")
    if text.startswith(".") or ".." in text:
        raise TransferError(f"{label}不能以点开头，也不能包含两个连续的点")
    return text


def check_volume(value: str) -> str:
    """``import/xx.ova`` 这类相对卷名。"""
    text = str(value or "").strip()
    if ":" in text or ".." in text or text.startswith("/"):
        raise TransferError("卷名不合法")
    if not re.match(r"^import/[^/\s]+$", text):
        raise TransferError("卷名不合法（应为 import/文件名）")
    return text


#: PVE 的 import 内容在**上传接口**上接受的扩展名：
#: ``PVE::Storage::$UPLOAD_IMPORT_EXT_RE_1 = qr/\.(ova|qcow2|raw|vmdk)/``。
#: 它和**列目录**用的 ``IMPORT_EXT_RE_1 = qr/\.(ova|ovf|qcow2|raw|vmdk)/`` 不是同一个 ——
#: 也就是 `.ovf` 能被 PVE「看见」（放进 import 目录就能列出来、能导入），却**传不上去**：
#: 上传接口只认磁盘镜像，传 `.ovf` 只会得到一句
#: ``filename: invalid filename or wrong extension``。.img / .vhd / .vhdx 两处都不收。
UPLOAD_IMPORT_EXT = ("ova", "qcow2", "raw", "vmdk")

#: OVF 的伴生文件：.mf 校验清单、.nvram EFI 变量，以及快照类的 .vmsd/.vmsn/.vmem。
COMPANION_UPLOAD_EXT = ("mf", "nvram", "vmsd", "vmsn", "vmem")


def file_ext(name: str) -> str:
    """小写扩展名（不含点）；没有扩展名返回空串。"""
    base = str(name or "").rsplit("/", 1)[-1]
    return base.rsplit(".", 1)[-1].lower() if "." in base else ""


def ovf_needs_copy_text(import_dir: str = "") -> str:
    """散开的 OVF 该怎么进 import 目录（上传接口这条路走不通）。"""
    where = (
        f"宿主机的 {import_dir}"
        if import_dir
        else "宿主机上该存储的 import 目录"
    )
    return (
        "散开的 OVF 不能通过上传导入：PVE 的上传接口只收磁盘镜像"
        "（OVA / QCOW2 / RAW / VMDK）—— .ovf 只是描述文件，盘数据在同名的 "
        "-diskN.vmdk 里，上传接口没有「一次传一组」的形式。请二选一："
        f"① 用 scp / rsync（或直接在那台宿主机上）把 .ovf 与它引用的 -diskN.vmdk "
        f"一起放进 {where}（即该存储 path 下的 import/ 子目录；文件名别带空格或中文，"
        "否则 PVE 列不出来），然后回到这一步刷新，从「选择已上传的文件」里选那个 .ovf —— "
        "面板读的就是同一个目录；② 或者把这组文件打成 .ova（tar 包）再上传，PVE 会自己解包。"
    )


def check_upload_name(filename: str, import_dir: str = "") -> str:
    """校验要上传到 import 目录的文件名，返回规范后的名字。

    规则照抄 PVE（``$UPLOAD_IMPORT_EXT_RE_1`` 配 ``$SAFE_CHAR_CLASS_RE``），目的只有一个：
    **在开始传之前**把不行的情况说清楚。让用户在浏览器里等几十分钟、最后收到一句
    ``filename: invalid filename or wrong extension``，是这条链路上最糟的体验。
    """
    name = str(filename or "").strip()
    ext = file_ext(name)
    if ext in COMPANION_UPLOAD_EXT:
        raise TransferError(
            f"{name} 不需要上传：.ovf 是描述、-disk1.vmdk 是盘数据，这两个才是导入要用的；"
            ".mf（校验清单）与 .nvram（UEFI 变量）PVE 既传不上去也用不到。"
        )
    if ext == "ovf":
        raise TransferError(ovf_needs_copy_text(import_dir))
    if ext not in UPLOAD_IMPORT_EXT:
        raise TransferError(
            f"{name} 不能通过上传放进 import 目录：PVE 的上传接口只接受 "
            "OVA / QCOW2 / RAW / VMDK（.vhd / .vhdx / .img 之类请先用 qemu-img "
            "转成 qcow2 或 raw 再上传）。"
        )
    return check_name(name, "文件名")


def upload_error_text(raw: str, import_dir: str = "") -> str:
    """上传被 PVE 拒掉时的兜底翻译（版本差异 / 我们漏判的情况）。"""
    lowered = str(raw).lower()
    if "wrong extension" in lowered or "invalid filename" in lowered:
        hint = (
            "它的上传接口只接受 OVA / QCOW2 / RAW / VMDK，文件名只能用字母、数字、"
            "点、下划线、加号、减号、等号。"
        )
        if ".ovf" in lowered:
            hint += " " + ovf_needs_copy_text(import_dir)
        return f"PVE 拒绝了这次上传（{raw}）。{hint}"
    return raw


# ===================================================================== 导入

async def importable_storages(client: Any, node: str) -> List[Dict[str, Any]]:
    """可以作为「导入源」的存储：支持 import 内容类型的文件型存储。

    PVE 只让文件型存储（dir / NFS / CIFS / CephFS / BTRFS）承载 import 内容 ——
    块存储上的镜像没法直接当 OVF 的落点。

    顺带带上目录型存储在宿主机上的 ``path``：散开的 OVF 没法走上传接口（见
    ``check_upload_name``），只能由用户 scp 进那个目录 —— 不把路径指出来，
    「请把文件放进 import 目录」就等于让用户自己去找。
    """
    try:
        storages = await client.storages(node) or []
    except Exception as exc:  # noqa: BLE001
        raise TransferError(f"读取存储列表失败：{exc}") from exc
    paths: Dict[str, str] = {}
    try:
        # 只有数据中心级的 /storage 返回 path（节点级与 status 都不给）
        for item in await client.get("/storage") or []:
            if str(item.get("type") or "") == "dir":
                paths[str(item.get("storage") or "")] = str(item.get("path") or "").rstrip("/")
    except Exception:  # noqa: BLE001 - 拿不到路径只是少一句提示
        paths = {}
    result = []
    for item in storages:
        content = str(item.get("content") or "").split(",")
        if "import" not in content:
            continue
        name = str(item.get("storage") or "")
        result.append(
            {
                "storage": name,
                "type": str(item.get("type") or ""),
                "active": bool(item.get("active", True)),
                "avail": item.get("avail"),
                "content": item.get("content"),
                "path": paths.get(name, ""),
            }
        )
    return result


async def import_sources(client: Any, node: str) -> List[Dict[str, Any]]:
    """已上传到各存储 import 内容里的文件（导入向导的「选择文件」用）。"""
    out: List[Dict[str, Any]] = []
    for storage in await importable_storages(client, node):
        name = storage["storage"]
        try:
            items = await client.storage_content(node, name, content="import")
        except Exception:  # noqa: BLE001 - 单条存储读不到不影响其余
            continue
        for item in items or []:
            volid = str(item.get("volid") or "")
            if not volid:
                continue
            out.append(
                {
                    "volid": volid,
                    # 相对卷名：import-metadata 要的就是它（不带存储前缀）
                    "volume": volid.split(":", 1)[-1],
                    "storage": name,
                    "name": volid.rsplit("/", 1)[-1],
                    "format": str(item.get("format") or ""),
                    "size": item.get("size"),
                }
            )
    out.sort(key=lambda x: (x["storage"], x["name"]))
    return out


#: 只有这两种是「带描述文件」的封装格式，PVE 才解析得出机器配置。
#: 其余（VMDK / QCOW2 / RAW / IMG / VHD…）都是裸磁盘镜像 —— 里面只有盘上的数据。
_OVA_LIKE_RE = re.compile(r"\.(ova|ovf)$", re.IGNORECASE)


#: VMware 导出的 OVF 是**一组**文件：``xx.ovf`` 是描述（磁盘位置、内存、固件都写在
#: 里面），盘数据在同名的 ``xx-diskN.vmdk`` 里，另有 ``xx.mf``（清单）与
#: ``xx-fileN.nvram``（EFI 变量）。PVE 的 import 内容解析 OVF 里的 href 时**不允许
#: 子目录** —— 也就是 .ovf 与 -diskN.vmdk 必须平铺在同一个 import 目录里。
def missing_ovf_disks(
    meta: Dict[str, Any], volume: str, existing: Iterable[str]
) -> List[str]:
    """OVF 引用、却没有和它待在同一个 import 目录里的磁盘文件。

    为什么要面板自己再判一次：PVE 的 OVF 解析器在 href 指向的文件不存在时，直接
    ``die "error parsing $filepath, file seems not to exist at $path"`` —— 只上传了
    .ovf 的用户拿到的是一句英文原文，而他真正需要知道的只有一件事：**同名的
    -disk1.vmdk 也得传**。这里把缺的文件一次列全（多盘 OVF 缺两个时 PVE 只会报第一个）。

    ``existing`` 是 import 目录里已有的文件名集合。OVA 内嵌的磁盘
    （``import/xx.ova/disk.vmdk``，多一段目录、不在文件系统上）与 EFI 变量盘占位
    （``efidisk0``，由 PVE/面板另行分配）都不参与这个检查。
    """
    own = str(volume or "").split("/", 1)[-1]
    have = set(existing)
    names: List[str] = []
    for key, entry in sorted((meta.get("disks") or {}).items()):
        if str(key) == "efidisk0":
            continue
        volid = (
            str(entry.get("volid") or "") if isinstance(entry, dict) else str(entry or "")
        )
        relative = volid.split(":", 1)[-1]
        if not relative.startswith("import/"):
            continue
        name = relative[len("import/") :]
        if "/" in name or name == own or name in have:
            continue
        names.append(name)
    return names


def missing_files_text(missing: List[str]) -> str:
    """缺同目录磁盘文件时的说明。"""
    head = "、".join(missing) if missing else "（PVE 没说是哪一个）"
    return (
        f"这个 OVF 引用的磁盘文件不在同一个导入目录里：{head}。"
        "VMware 导出的 OVF 本来就是一整套文件：.ovf 只是描述（磁盘、内存、固件都写在"
        "里面），真正的盘数据在同名的 -disk1.vmdk 里。两者要一起上传到**同一个**存储的"
        "import 目录（PVE 不允许子目录），只传其中一个，建出来的机器是没有系统盘的，"
        "开机自然起不来。.mf 校验文件与 .nvram 不需要上传（PVE 也不接受这两种格式）。"
    )


async def _bare_disk_meta(
    client: Any, node: str, storage: str, volname: str
) -> Dict[str, Any]:
    """给裸磁盘镜像合成一份等价的导入信息。

    PVE 的 import-metadata 解析不了这类文件（它期待 OVF 那种描述 XML），会直接回
    ``invalid format``。但**导入本身并不需要那份描述**：``import-from`` 直接吃卷 ID ——
    云镜像（vmconfig）、模板、重装三条路都是这么干的，产出的 config 字符串格式与
    build_import_config 逐字相同。所以这里只补上「有哪些盘、源卷是谁」，内存 / CPU /
    网卡留空，交给向导让用户填：镜像里确实没有这些信息，编不如留白。

    刻意**不**走「先建空壳机再 importdisk」：PVE 9.2 已经移除了那个接口
    （实测 501，见 pve.py 里的说明）。
    """
    volid = f"{storage}:{volname}"
    size = 0
    try:
        for item in await client.storage_content(node, storage, content="import") or []:
            item_volid = str(item.get("volid") or "")
            if item_volid == volid or item_volid.endswith(f":{volname}"):
                try:
                    size = int(item.get("size") or 0)
                except (TypeError, ValueError):
                    size = 0
                break
    except Exception:  # noqa: BLE001 - 读不到大小不影响导入本身
        size = 0
    return {
        "source": volid,
        "type": "bare-disk",
        "create_args": {},
        # 键必须是 build_import_config 认得的盘位名（它按 _DISK_KEY_RE 过滤并
        # 重新映射到用户选的总线上）
        "disks": {"scsi0": {"volid": volid, "size": size}},
        "net": {},
        "warnings": [],
        # 告诉前端「这台机器的内存 / CPU 得自己填」，好让它给提示与默认值
        "bare": True,
    }


async def _assert_ovf_disks(
    client: Any, node: str, storage: str, volume: str, disks: Dict[str, Any]
) -> None:
    """确认 OVF 引用的磁盘确实和它躺在同一个 import 目录里。

    PVE 自己也会查（解析 href 时 ``-e`` 不成立就 die），但它死在**返回元数据之前**，
    用户看到的是英文原文。这里在拿到元数据后再对一次账，把「缺哪个文件」讲清楚 ——
    多盘 OVF 缺两个时 PVE 只会报第一个。列出 import 目录失败时不拦（读不到不等于
    文件不存在，交给 PVE 自己判，否则会把能导入的也拦下来）。
    """
    if not volume.lower().endswith(".ovf"):
        return
    try:
        items = await client.storage_content(node, storage, content="import") or []
    except Exception:  # noqa: BLE001 - 拿不到列表就不做这项检查
        return
    existing = set()
    for item in items:
        relative = str(item.get("volid") or "").split(":", 1)[-1]
        if relative.startswith("import/"):
            existing.add(relative[len("import/") :])
    missing = missing_ovf_disks({"disks": disks}, volume, existing)
    if missing:
        raise TransferError(missing_files_text(missing))


async def import_metadata(client: Any, node: str, storage: str, volume: str) -> Dict[str, Any]:
    """读导入信息：OVA / OVF 由 PVE 解析，裸磁盘镜像由面板合成等价描述。"""
    volname = check_volume(volume)
    if not _OVA_LIKE_RE.search(volname):
        return await _bare_disk_meta(client, node, storage, volname)
    try:
        data = await client.get(
            f"/nodes/{node}/storage/{storage}/import-metadata",
            params={"volume": volname},
        )
    except Exception as exc:  # noqa: BLE001
        raise TransferError(_import_error_text(str(exc))) from exc
    if not isinstance(data, dict):
        raise TransferError("PVE 没有返回可用的导入信息")
    disks = data.get("disks") if isinstance(data.get("disks"), dict) else {}
    create = data.get("create-args") if isinstance(data.get("create-args"), dict) else {}
    await _assert_ovf_disks(client, node, storage, volname, disks)
    warnings = list(data.get("warnings") or [])
    # PVE 只认 VMware 私有的 ``<vmw:Config vmw:key="firmware">``：别的工具（oVirt、
    # virt-v2v、各家自制的导出）生成的 OVF 里没有这一项，于是「跟随 OVF」只能落到
    # 传统 BIOS。源机若其实是 UEFI，装出来的机器会停在**一句
    # 「Booting from Hard Disk...」之后黑屏** —— 看起来像引导坏了，实际是固件选反了。
    # 面板没法从这份元数据里看出源机的固件（这正是 PVE 没给出 bios 的原因），
    # 所以只把这件事说清楚，让人知道该改哪一格。
    if not str(create.get("bios") or "").strip():
        warnings.append({"type": "firmware-not-declared"})
    # 面板自己加的：盘在 SCSI 控制器上、固件又是 UEFI。这两个条件一起出现时面板只能给
    # virtio-scsi（lsi / pvscsi 的引导支持都只在 BIOS 侧），而 VMware 搬过来的客户机
    # initramfs 里往往没有 virtio 驱动 —— 首启会「内核起来了却找不到根盘」，停在
    # dracut 的等根盘上，看着像引导坏了。这句话要出现在开机之前，而不是让用户对着
    # 滚动日志猜（实测踩过：只挂 IDE 才起来）。
    if source_bus(disks) == "scsi" and str(create.get("bios") or "").lower() == "ovmf":
        warnings.append({"type": "scsi-under-ovmf"})
    return {
        "source": str(data.get("source") or ""),
        "type": str(data.get("type") or ""),
        "create_args": create,
        "disks": disks,
        "net": data.get("net") or {},
        "warnings": warnings,
        "bare": False,
    }


def _import_error_text(raw: str) -> str:
    """把 PVE 的原始报错翻成人话（这几种是最常见的失败原因）。"""
    if "unable to parse directory volume name" in raw:
        return (
            "PVE 无法识别这个导入文件。请确认它确实是 .ova / .ovf 文件，"
            "且已经放进该存储的 import 内容里（可能是卷名带了存储前缀，"
            "或扩展名不在 PVE 的允许列表内）。"
        )
    if "invalid format" in raw:
        return (
            "PVE 不支持这种导入文件的格式（只认 OVA / OVF）。"
            "裸磁盘镜像（VMDK / QCOW2 / RAW）不走这条解析，请确认文件名以正确的"
            "扩展名结尾、且已放进该存储的 import 目录后重试。"
        )
    if "OVF parser terminated unexpectedly" in raw:
        # 实测：OVF 里没有磁盘（或缺 <rasd:Parent> 指向的控制器）时，PVE 的解析器
        # 会直接 die 成这句话。真实 hypervisor 导出的 OVA 一定带控制器，所以这里
        # 指向「文件不完整 / 不是原始导出件」，比丢一句英文原文有用。
        return (
            "PVE 没能从这个文件里解析出磁盘。请确认它是原始导出的 OVF/OVA"
            "（一般都会带磁盘控制器与磁盘项），而不是被精简或改过的文件。"
        )
    # 只传了 .ovf、没传同名的 -disk1.vmdk —— 这是「VMware 导出的机器导入后面目全非
    # 或根本起不来」的最常见原因。原文形如：
    #   error parsing openeuler24-disk1.vmdk, file seems not to exist at /var/lib/vz/import/...
    # 必须排在下面那条通用的 does not exist 之前，否则会被它抢走，翻成
    # 「导入文件不存在，请重新上传」—— 用户于是去重传那个其实好好的 .ovf。
    match = re.search(r"error parsing ([^,\n]+), file seems not to exist", raw)
    if match:
        return missing_files_text([match.group(1).strip()])
    if "does not exist" in raw:
        return "导入文件不存在，可能已被删除，请重新上传。"
    return f"读取导入信息失败：{raw}"


def source_bus(disks: Dict[str, Any]) -> str:
    """源机器用的是哪种磁盘总线 —— 从 PVE 给的磁盘键前缀读出来。

    OVF 里写的是控制器类型，PVE 解析后翻译成了键前缀（``scsi0`` / ``ide`` /
    ``sata0`` / ``nvme0``）。这是**源文件自己说的**，比我们替它猜可靠得多：
    装系统时用的是 IDE 的话，客户机 initramfs 里就只有 ``ata_piix``，把它挂到
    virtio-scsi 上，内核起来后根本看不到盘，表现是「停在等根盘」。
    """
    for key in sorted(disks or {}):
        if str(key) == "efidisk0":
            continue
        match = re.match(r"^(scsi|ide|sata|nvme)", str(key))
        if match:
            return match.group(1)
    return ""


def resolve_bus(bus: str, disks: Dict[str, Any], bare: bool) -> str:
    """``auto`` 时决定目标磁盘总线。

    * 没有源文件线索（裸磁盘镜像）：交给向导的选择，默认 ``scsi``；
    * 源文件说 ``ide`` / ``sata``：照它来 —— 那样的客户机里本来就有 ``ata_piix`` /
      ``ahci``，改了反而没驱动；
    * 源文件说 ``scsi``（VMware 的 OVA/OVF 基本都是）：**默认改用 IDE**。这一步是
      有意偏离「沿用源文件」的：PVE 只把 VMware 的 SCSI 控制器解析成 ``scsi0`` 这种
      前缀，型号（LSI Logic 还是 PVSCSI）它根本不解析，面板只能退到 ``virtio-scsi``，
      而搬过来的客户机 initramfs 里几乎不会有 virtio 驱动 —— 实测就是「内核起来了却
      找不到根盘」，同一块盘挂回 IDE 立刻能起。IDE 的 ``ata_piix`` 则近乎人人都有
      （至少给光驱留了它），SeaBIOS 与 OVMF 也都能从 IDE 盘引导。
      要性能的可以显式换成 ``scsi``（并选对控制器型号）/ ``sata`` / ``virtio``。
    * PVE 给出面板支持不了的总线（``nvme``）：回落到 ``scsi``。
    """
    value = str(bus or "").strip().lower()
    if value not in ("", "auto"):
        return value
    detected = source_bus(disks)
    if detected not in IMPORT_BUSES:
        return "scsi"
    if detected == "scsi" and not bare:
        return "ide"
    return detected


def resolve_scsihw(scsihw: str, bus: str, firmware: str, bare: bool) -> str:
    """``auto`` 时决定用哪个 SCSI 控制器型号。

    PVE 的 OVF 解析器**只把控制器解析成总线**（``ide`` / ``scsi`` / ``sata``）：它看
    ``rasd:ResourceType``，从不读 ``rasd:ResourceSubType``，所以 ``create-args`` 里
    根本没有 ``scsihw``（对着 pve-storage 的 ``GuestImport/OVF.pm`` 核对过）。也就是说
    「源机器用的是 LSI Logic 还是 PVSCSI」—— 决定客户机里有没有对应驱动的那条信息 ——
    PVE 给不出来，面板只能按最可能的来选：

    * ``scsi`` + 传统 BIOS → ``lsi``：VMware 的 SCSI 盘绝大多数是 LSI Logic，而且这也是
      PVE 自己建机的默认控制器（``qm importovf`` 得到的就是它）。
    * ``scsi`` + UEFI → ``virtio-scsi-single``：QEMU 的 ``lsi`` 在 UEFI 下不能引导
      （PVE 自己会为此发 ``ovmf-with-lsi-unsupported``），``pvscsi`` 的引导支持同样只在
      BIOS 侧；UEFI 能引导的 SCSI 控制器只剩 virtio-scsi。这一格仍是赌注 —— 所以
      ``import_metadata`` 会另发一条告警，把「客户机里可能没有 virtio 驱动」和该改哪一格
      说在开机之前。
    * 其它总线（``ide`` / ``sata`` / ``virtio``）：控制器与这块盘无关，保持面板默认值。
    * 裸磁盘镜像（``bare``）没有源文件线索，也保持默认值 —— 这是「导入 KVM 那边的
      qcow2」这类场景，virtio 才是对的。
    """
    value = str(scsihw or "").strip().lower()
    if value in ("", "auto"):
        if bare or bus != "scsi":
            return DEFAULT_SCSIHW
        return DEFAULT_SCSIHW if firmware == "ovmf" else "lsi"
    if value not in IMPORT_SCSIHW:
        raise TransferError(f"不支持的 SCSI 控制器：{value}")
    return value


def build_import_config(
    meta: Dict[str, Any],
    target_storage: str,
    bridge: str,
    bus: str = "auto",
    scsihw: str = "auto",
    disk_format: str = "qcow2",
    firmware: str = "auto",
    cpu: str = "x86-64-v2-AES",
    memory: Optional[int] = None,
    cores: Optional[int] = None,
    net_model: str = "",
    ip_mode: str = "",
    ip: str = "",
    gateway: str = "",
    dns: str = "",
    ci_user: str = "",
    ci_password: str = "",
    ssh_keys: str = "",
) -> Dict[str, Any]:
    """把 import-metadata 的结果翻译成建机参数。

    ``import-from=<源卷>`` 配合 ``<存储>:0``：大小由源镜像决定，PVE 自己搬数据。
    """
    disks = meta.get("disks") or {}
    if not disks:
        raise TransferError("PVE 没有在这个文件里找到可导入的磁盘")
    # 默认总线：沿用源文件里写明的那个，只有「源文件说是 SCSI」时改用 IDE
    # （理由见 resolve_bus —— 那是唯一一个「按源文件来就一定起不来」的组合）。
    bus = resolve_bus(bus, disks, bool(meta.get("bare")))
    if bus not in IMPORT_BUSES:
        raise TransferError(f"不支持的磁盘总线：{bus}")
    target_fmt = disk_format or "qcow2"
    if target_fmt not in IMPORT_DISK_FORMATS:
        raise TransferError(f"不支持的目标磁盘格式：{target_fmt}")

    config: Dict[str, Any] = dict(meta.get("create_args") or {})

    # 控制器型号得等固件定下来才能定（UEFI 与 BIOS 能用的控制器不是一套），所以放到
    # 下面 firmware 之后处理（见 resolve_scsihw）。这里先把 create-args 里可能带的值
    # 摘掉：PVE 现在不写它，将来写了也不该跟着漂 —— 那等于把选择权交给 PVE 的默认值。
    config.pop("scsihw", None)

    # 选 SATA 就得有 AHCI 控制器，而 i440fx（面板建机的默认机器类型）本身不带。
    # 不显式切到 q35 的话，磁盘控制器可能压根不存在，客户机固件和内核都读不到盘 ——
    # 表现出来是「固件能引导（GRUB 能读盘）、内核起来后找不到根盘然后卡死」。
    if bus == "sata":
        config["machine"] = "q35"
    elif bus == "ide":
        # 反过来：q35 没有 IDE 控制器（那里是 AHCI），OVF 里若带了 machine 得摘掉
        config.pop("machine", None)

    net = meta.get("net") or {}
    if not bridge:
        bridge = "vmbr0"
    if net:
        # 网卡型号留着（OVF 给的往往比 virtio 更贴近源机器），只把桥接换成面板的。
        # 实测 PVE 9.2 给的是 ``{"net0": {"model": "vmxnet3"}}`` 这种对象，
        # 拼成 PVE 的 net 语法 ``model=vmxnet3,bridge=vmbr0``。
        merged: Dict[str, Any] = {}
        for idx, (key, value) in enumerate(sorted(net.items())):
            if isinstance(value, dict):
                params = ",".join(
                    f"{k}={v}" for k, v in value.items() if v not in (None, "")
                )
            else:
                params = str(value or "")
            keep = [
                piece
                for piece in params.split(",")
                if piece and not piece.startswith("bridge=")
            ]
            merged[key if key.startswith("net") else f"net{idx}"] = ",".join(
                keep + [f"bridge={bridge}"]
            )
        config.update(merged)
    elif not _has_nic(config):
        # 兜底网口。OVF 里没有网卡描述、create_args 里也没有时，必须自己补一个 ——
        # 否则导入出来的机器**根本没有网卡**（而 boot=order=scsi0;net0 里的 net0
        # 指向一个不存在的东西），装完才发现没有网络。
        # 写成 model=xxx 而不是裸的 xxx：下面那段「按 net_model 覆盖型号」的逻辑是
        # 按 model= 前缀做替换的，裸写法会被当成另一个参数留着，产出 model=e1000,e1000
        config["net0"] = f"model={net_model or 'virtio'},bridge={bridge}"

    # 网卡型号：OVF 给的往往比默认值更贴近源机器，所以默认沿用；用户显式选了才替换。
    # 替换时保留同一张卡上的其余参数（MAC、firewall、link_down 之类），只换 model=。
    if net_model:
        if net_model not in IMPORT_NET_MODELS:
            raise TransferError(f"不支持的网卡型号：{net_model}")
        for key in [k for k in config if k.startswith("net")]:
            value = config.get(key)
            if not isinstance(value, str) or not value:
                continue
            kept = [p for p in value.split(",") if p and not p.startswith("model=")]
            config[key] = ",".join([f"model={net_model}", *kept])

    # create-args 里若也带了磁盘键，先清掉：这些盘下面会统一用 import-from 重挂，
    # 留着会让同一块盘被挂两次（一次指向源卷、一次指向一个还不存在的目标卷）。
    for key in list(config.keys()):
        if _DISK_KEY_RE.match(str(key)) or _BUS_ONLY_RE.match(str(key)):
            config.pop(key, None)

    # 磁盘：``$bus$id`` → ``<目标存储>:0,import-from=<源卷>``。
    # 注意 PVE 9.2 这里的值是 ``{"size":…, "volid": "local:import/xx.ova/disk.vmdk"}``
    # 对象，而不是早期文档里写的字符串 —— 两种形态都认；取不到卷名就跳过，
    # 否则会把字典的 repr 拼进配置，PVE 只会回一句语法错误。
    for key in sorted(disks.keys()):
        # 兼容两种 key：``scsi0``（带盘位号）与 ``ide``（只有总线名，PVE 对 OVA
        # 就是这么给的）。后者取不到数字就按 0 排 —— 原来直接 continue 的后果是
        # 建机参数里一块盘都没有，而 ``boot=order=scsi0`` 指向一个不存在的盘位，
        # 机器建出来是空的、开机什么都看不到。
        if not (_DISK_KEY_RE.match(key) or _BUS_ONLY_RE.match(key)):
            continue
        entry = disks[key]
        volid = (
            str(entry.get("volid") or "") if isinstance(entry, dict) else str(entry or "")
        )
        if not volid:
            continue
        index = int(re.sub(r"\D", "", key) or 0)
        target_key = f"{bus}{index}"
        # format= 是给 **目标** 磁盘的格式，与源卷的格式无关。不写它，PVE 会按
        # 源格式克隆 —— 从 VMware 导来的 vmdk 于是被转成 vmdk：同样大小的数据，
        # vmdk 既不便于快照也不便于迁移。
        config[target_key] = (
            f"{target_storage}:0,import-from={volid},format={target_fmt}"
        )

    boot = f"{bus}0"
    config["boot"] = f"order={boot}"
    config.pop("vmid", None)
    if memory:
        config["memory"] = int(memory)
    if cores:
        config["cores"] = int(cores)
    # OVF 里可能带 serial / vga / softmmu 之类，逐项交给 PVE 自己校验即可
    for key in ("ide2", "sata2"):
        value = str(config.get(key) or "")
        if "media=cdrom" in value and "cdrom" in value:
            # 光驱里的 ISO 在目标机上多半不存在，直接摘掉（PVE 自己也会给 warning）
            config.pop(key, None)

    # 固件。默认「跟随 OVF」：PVE 会解析 VMware 私有的
    # ``<vmw:Config vmw:key="firmware" vmw:value="efi"/>``，命中时在 create_args 里
    # 给出 ``bios=ovmf``。面板早期版本无视这个结果、还把默认值写死成 seabios，
    # 于是用 UEFI 装出来的系统被当成传统 BIOS 启动 —— 停在「Booting from Hard Disk…」
    # 或黑屏，而用户完全看不出问题出在这一格。现在除非用户显式选了 BIOS，否则以
    # OVF 里写的为准；裸磁盘镜像没有 create_args，仍然落到 BIOS。
    firmware = str(firmware or "auto").strip().lower()
    if firmware not in ("auto", "seabios", "ovmf"):
        raise TransferError(f"不支持的固件类型：{firmware}")
    if firmware == "auto":
        firmware = "ovmf" if str(config.get("bios") or "").lower() == "ovmf" else "seabios"
    if firmware == "ovmf":
        # 只把固件切到 OVMF：UEFI 固件会自己去磁盘的 GPT 分区表里找已经存在的 EFI
        # 系统分区（也就是装系统时分的 /boot/efi）。原系统是用 BIOS 装的就别选它。
        config["bios"] = "ovmf"
    else:
        config.pop("bios", None)

    # SCSI 控制器。PVE 只给得出总线、给不出型号（源机器用的是 LSI Logic 还是 PVSCSI
    # 它不解析），所以这里按「最可能的」来选：BIOS 下用 lsi（VMware 的 SCSI 盘绝大多数
    # 是 LSI Logic，也正是 PVE 建机的默认控制器），UEFI 下退回 virtio-scsi（QEMU 的
    # lsi 在 UEFI 下引导不了 —— PVE 自己会为此发 ovmf-with-lsi-unsupported）。
    config["scsihw"] = resolve_scsihw(scsihw, bus, firmware, bool(meta.get("bare")))

    # EFI 变量盘。OVF 是 UEFI 时 PVE 会在 disks 里塞一个 ``efidisk0`` 占位（值是 1），
    # 意思是「这台机器还需要一块 EFI 变量盘」—— 它不匹配磁盘键的规则，早先在这里被
    # 悄悄跳过了：机器带着空变量盘启动，UEFI 变量与启动项从此改不动也留不下。
    # 写法与建机向导完全一致（vmconfig.format_efidisk），EFI 盘和普通盘一样落在支持
    # images 的目标存储上（local / NFS 这类目录型存储也能放）。刻意**不**预置
    # Secure Boot 密钥：搬过来的系统多半没有微软签名的引导器，开了安全启动反而起不来。
    if (
        firmware == "ovmf"
        and target_storage
        and _wants_efidisk(meta.get("disks") or {})
    ):
        from .schemas import EfiDiskSpec
        from .vmconfig import format_efidisk

        config["efidisk0"] = format_efidisk(
            EfiDiskSpec(storage=target_storage, pre_enrolled_keys=False)
        )

    # CPU 型号。**这一项不设是有代价的**：PVE 会退回 QEMU 默认的 qemu64，只带
    # x86-64 基线指令集，缺 SSE4.2 / POPCNT / CMPXCHG16B。较新的发行版
    # （openEuler 24、Debian 12、Ubuntu 24 等）的 glibc 在 init 阶段一检测就
    # exit_group(127) 退出；因为它是 PID 1，内核只能报
    # 「Kernel panic - not syncing: Attempted to kill init!」。
    # 现象是「内核日志都打出来了、系统就是起不来」，很容易被误判成引导/磁盘问题。
    if cpu:
        if cpu not in IMPORT_CPU_MODELS:
            raise TransferError(f"不支持的 CPU 型号：{cpu}")
        config["cpu"] = cpu

    # 「开机自启」（PVE 的 onboot）不开放给导入向导：那是机器的长期属性，应该在
    # 详情页里改，不该在导入时顺手定掉；导入这一步只决定「现在要不要开机」。
    # OVF 里可能带着这个键，先摘掉，免得源机器的设置悄悄跟过来。
    config.pop("onboot", None)
    # 首次登录凭据走 cloud-init。**必须同时挂一个 cloud-init 盘**：只写 ciuser /
    # cipassword 的话，PVE 只是把参数记在配置里，没有任何东西会去读它们，密码等于
    # 没设 —— 这是最难排查的一种「明明设了却没用」。ide2 会被上面那个摘光驱的循环
    # 删掉，所以只能加在它之后。
    if ci_user or ci_password or ssh_keys or ip_mode:
        # IP 配置同样要走 cloud-init，所以它也算「需要挂 cloud-init 盘」的条件之一。
        # 漏了这个，只选 IP 不填密码时盘不会挂，ipconfig0 写进去了也没人读 —— 机器照样
        # 按镜像里的原配置拿地址，用户以为没生效。
        config["ide2"] = f"{target_storage}:cloudinit"
        config.update(_import_ip_config(ip_mode, ip, gateway, dns))
        if ci_user or ci_password or ssh_keys:
            # 只填了密码 / 公钥却没填用户名时用 root 兜底，避免「设了没生效」
            config["ciuser"] = ci_user or "root"
            if ci_password:
                config["cipassword"] = ci_password
            if ssh_keys:
                config["sshkeys"] = ssh_keys
    return config


def _wants_efidisk(disks: Dict[str, Any]) -> bool:
    """PVE 是否点名要一块 EFI 变量盘（UEFI 的 OVF 会给 ``efidisk0 => 1``）。"""
    value = disks.get("efidisk0")
    if value is None:
        return False
    return True if isinstance(value, dict) else bool(value)


def _has_nic(config: Dict[str, Any]) -> bool:
    """配置里是否已经有网卡（net0 / net1 …；vmbr、bond 之类不算）。"""
    for key in config:
        text = str(key)
        if text.startswith("net") and text[3:].isdigit():
            return True
    return False


def _import_ip_config(
    ip_mode: str, ip: str, gateway: str, dns: str
) -> Dict[str, str]:
    """把向导里的 IP 选择翻译成 PVE 的 ``ipconfig0`` / ``nameserver``。

    格式与重装向导（``reinstall._ip_config``）保持一致。静态地址**必须**写成
    CIDR：PVE 不会替你猜掩码，缺掩码的 ``ip=10.0.0.10`` 会被当成 /32，机器拿不到
    地址而且很难看出原因，所以这里直接拒绝而不是照单全收。
    """
    out: Dict[str, str] = {}
    mode = str(ip_mode or "").strip()
    if not mode:
        # 保持镜像 / OVF 里原有的网络配置不动
        return out
    if mode == "dhcp":
        out["ipconfig0"] = "ip=dhcp"
    else:
        address = str(ip or "").strip()
        if "/" not in address:
            raise TransferError(
                "静态 IP 要写成 CIDR 形式（带掩码），例如 192.168.1.10/24"
            )
        value = f"ip={address}"
        if gateway:
            value += f",gw={str(gateway).strip()}"
        out["ipconfig0"] = value
    if dns:
        out["nameserver"] = str(dns).strip()
    return out

# ===================================================================== 导出


class ExportJob:
    """一次导出作业（进程内状态；产物在宿主机上保留到用户删除）。"""

    def __init__(
        self,
        job_id: str,
        node: str,
        vmid: int,
        name: str,
        fmt: str,
        storage: str,
        owner: str,
        connection: str,
    ) -> None:
        self.id = job_id
        self.node = node
        self.vmid = vmid
        self.name = name
        self.format = fmt
        self.storage = storage
        self.owner = owner
        self.connection = connection
        self.status = "running"
        self.stage = "preparing"
        self.progress = 0
        self.detail = ""
        self.files: List[Dict[str, Any]] = []
        self.dir = ""
        self.created = int(time.time())
        self.finished = 0

    def public(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "node": self.node,
            "vmid": self.vmid,
            "name": self.name,
            "format": self.format,
            "storage": self.storage,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "detail": self.detail,
            "files": self.files,
            "created": self.created,
            "finished": self.finished,
        }


# 作业表放进程内，但**不再是产物的唯一凭据**：产物目录里留有 META_NAME 身份文件，
# 面板重启（或作业被挤出上面的上限）之后由 scan_exports() 认回来，列表、下载、
# 删除照常可用 —— 否则磁盘上会攒下一堆用户既看不见、也删不掉的镜像。
_JOBS: Dict[str, ExportJob] = {}
_MAX_JOBS = 50
#: 扫描结果缓存：列一次导出要 SSH 到每条连接的存储上，而对话框一打开就会拉列表。
#: 增删产物时会立刻失效（_forget_scan），所以不会读到过期的「已经删掉了」。
_SCAN_CACHE: Dict[str, Any] = {"at": 0.0, "items": None}
_SCAN_TTL = 15.0


def get_job(job_id: str) -> Optional[ExportJob]:
    return _JOBS.get(job_id)


def list_jobs() -> List[ExportJob]:
    return sorted(_JOBS.values(), key=lambda job: job.created, reverse=True)


def _prune_jobs() -> None:
    if len(_JOBS) <= _MAX_JOBS:
        return
    for job in sorted(_JOBS.values(), key=lambda j: j.created)[: len(_JOBS) - _MAX_JOBS]:
        if job.status != "running":
            _JOBS.pop(job.id, None)


async def dir_storage_path(client: Any, storage: str) -> str:
    """目录型（dir）存储的宿主路径；不是 dir 时返回空串。

    只有数据中心级的 ``/storage`` 返回 ``path``（节点级与 status 都不给），
    所以自定义 path 的存储也能拼对。
    """
    try:
        items = await client.get("/storage")
    except Exception:  # noqa: BLE001
        return ""
    for item in items or []:
        if str(item.get("storage")) == storage and str(item.get("type")) == "dir":
            return str(item.get("path") or "").rstrip("/")
    return ""


async def resolve_ssh_host(client: Any) -> Tuple[Optional[Dict[str, Any]], str]:
    """按 PVE 连接地址找已登记的受管主机（导出只能在宿主机上执行）。"""
    host = str(getattr(client.conn, "host", "") or "")
    row = await sshremote.find_by_address(host) if host else None
    if not row:
        return None, (
            f"这台 PVE（{host or '未知地址'}）还没配置 SSH 凭据，导出无法进行。"
            "导出要在宿主机上把磁盘转成镜像再取回：请到「SSH 安全 → 受管主机」"
            "添加该地址（写法要与 PVE 连接里的地址一致），然后重试。"
        )
    return row, ""


def vm_disks(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """从 VM 配置里挑出真正的数据盘（跳过光驱与 cloud-init 盘）。"""
    disks: List[Dict[str, Any]] = []
    for key, value in (config or {}).items():
        if not _DISK_KEY_RE.match(str(key)):
            continue
        text = str(value or "")
        if not text or text.startswith("none"):
            continue
        if "media=cdrom" in text or "cloudinit" in text:
            continue
        volid = text.split(",", 1)[0].strip()
        if not volid or ":" not in volid:
            continue
        size = 0
        match = re.search(r"(?:^|,)size=(\d+)([KMGT])?", text)
        if match:
            unit = {"K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4}.get(
                match.group(2) or "G", 1024**3
            )
            size = int(match.group(1)) * unit
        disks.append({"key": str(key), "volid": volid, "size": size})
    disks.sort(key=lambda item: (item["key"].rstrip("0123456789"), item["key"]))
    return disks


def _ovf_xml(
    name: str,
    vmid: int,
    fmt: str,
    disks: List[Dict[str, Any]],
    disk_names: List[str],
    memory_mb: int,
    cores: int,
    ostype: str,
) -> str:
    """生成一份最小但结构完整的 OVF 描述。

    只写 VMware / VirtualBox 真正会读的那几项（文件引用、磁盘容量、CPU / 内存 /
    网卡），多余的扩展字段各家实现不一致，写了反而容易导入失败。
    """
    # href 必须写产物**实际**的文件名：现在磁盘名带用户起的前缀，
    # 再按 disk-{idx} 拼会让导入方找不到文件
    files = "".join(
        f'\n    <File ovf:href="{disk_names[idx]}" ovf:id="file{idx}"/>'
        for idx in range(len(disks))
    )
    disk_entries = ""
    items = ""
    # 控制器 + 磁盘的父子关系不能少。PVE 的 OVF 解析器要求每个磁盘用
    # <rasd:Parent> 指向一个**存在**的控制器 Item，缺了它解析器会直接 die 成
    # 「OVF parser terminated unexpectedly」—— 面板自己生成的 OVF 连 PVE 都读不了。
    # 磁盘的 InstanceID 从 7 起，避开 CPU(1) / 内存(2) / 控制器(4) / 网卡(3)。
    items += (
        "\n      <Item><rasd:InstanceID>4</rasd:InstanceID>"
        "<rasd:ResourceType>5</rasd:ResourceType>"
        "<rasd:ResourceSubType>lsilogic</rasd:ResourceSubType>"
        "<rasd:ElementName>SCSI Controller 0</rasd:ElementName></Item>"
    )
    for idx, disk in enumerate(disks):
        capacity = max(int(disk.get("size") or 0) // (1024**3), 1)
        disk_entries += (
            f'\n    <Disk ovf:capacity="{capacity}" ovf:capacityAllocationUnits="byte * 2^30"'
            f' ovf:diskId="vmdisk{idx}" ovf:fileRef="file{idx}"'
            ' ovf:format="http://www.vmware.com/interfaces/specifications/vmdk.html'
            '#streamOptimized"/>'
        )
        items += (
            f"\n      <Item><rasd:InstanceID>{idx + 7}</rasd:InstanceID>"
            f"<rasd:ResourceType>17</rasd:ResourceType>"
            f"<rasd:Parent>4</rasd:Parent>"
            f"<rasd:HostResource>ovf:/disk/vmdisk{idx}</rasd:HostResource>"
            f"<rasd:ElementName>Hard disk {idx + 1}</rasd:ElementName></Item>"
        )
    os_id = {"l24": 94, "l26": 94, "win10": 107, "win11": 107, "win7": 102}.get(
        ostype, 94
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://schemas.dmtf.org/ovf/envelope/1"
          xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1"
          xmlns:rasd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ResourceAllocationSettingData"
          xmlns:vssd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_VirtualSystemSettingData"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <References>{files}
  </References>
  <DiskSection>
    <Info>Virtual disk information</Info>{disk_entries}
  </DiskSection>
  <NetworkSection>
    <Info>Logical networks</Info>
    <Network ovf:name="VM Network"><Description>Network</Description></Network>
  </NetworkSection>
  <VirtualSystem ovf:id="vm-{vmid}">
    <Info>Exported by ProxCenter from {name}</Info>
    <Name>{name}</Name>
    <OperatingSystemSection ovf:id="{os_id}"><Info>Guest OS</Info></OperatingSystemSection>
    <VirtualHardwareSection>
      <Info>Virtual hardware requirements</Info>
      <System><vssd:ElementName>Virtual Hardware Family</vssd:ElementName>
        <vssd:InstanceID>0</vssd:InstanceID>
        <vssd:VirtualSystemIdentifier>vm-{vmid}</vssd:VirtualSystemIdentifier>
        <vssd:VirtualSystemType>vmx-10</vssd:VirtualSystemType></System>
      <Item><rasd:InstanceID>1</rasd:InstanceID><rasd:ResourceType>3</rasd:ResourceType>
        <rasd:VirtualQuantity>{max(int(cores or 1), 1)}</rasd:VirtualQuantity>
        <rasd:ElementName>{max(int(cores or 1), 1)} virtual CPU</rasd:ElementName></Item>
      <Item><rasd:InstanceID>2</rasd:InstanceID><rasd:ResourceType>4</rasd:ResourceType>
        <rasd:AllocationUnits>byte * 2^20</rasd:AllocationUnits>
        <rasd:VirtualQuantity>{max(int(memory_mb or 1024), 256)}</rasd:VirtualQuantity>
        <rasd:ElementName>Memory</rasd:ElementName></Item>{items}
      <Item><rasd:InstanceID>3</rasd:InstanceID><rasd:ResourceType>10</rasd:ResourceType>
        <rasd:ResourceSubType>VmxNet3</rasd:ResourceSubType>
        <rasd:Connection>VM Network</rasd:Connection>
        <rasd:ElementName>Network adapter 1</rasd:ElementName></Item>
    </VirtualHardwareSection>
  </VirtualSystem>
</Envelope>
"""


#: PVE 的 ostype → VMware 的 guestOS。映射不准不影响开机，只影响 VMware 给出的
#: 优化提示，所以认不出来的一律落到 other-64，不去猜。
_VMX_OS = {
    "l24": "otherlinux-64",
    "l26": "otherlinux-64",
    "win7": "windows7-64",
    "win8": "windows8-64",
    "win10": "windows9-64",
    "win11": "windows11-64",
    "w2k8": "windows2016srv-64",
    "w2k12": "windows2016srv-64",
    "w2k16": "windows2016srv-64",
    "w2k19": "windows2019srv-64",
    "w2k22": "windows2022srv-64",
}


def _vmx_disk_bus(keys: List[str]) -> Tuple[str, str]:
    """PVE 的磁盘总线 → VMware 上用的（设备前缀, 控制器驱动）。

    原则是**能不换就不换**：原样搬过去，客户机里的驱动一定匹配（sata → ahci、
    ide → ide、nvme → nvme 都是同一个驱动在两边用）。

    真正必须换的只有 virtio —— **VMware 里根本没有 virtio 设备**。这时选
    **ahci 而不是 lsilogic**：ahci 在主流发行版的内核里常常是编进去的（=y），
    而 lsilogic 的 mptspi / mptsas 多半只是 initramfs 里的模块；一旦那份
    initramfs 是精简生成的（Debian 的 MODULES=dep），它就没带 —— 系统会停在
    **挂载根分区**那一步：内核日志走完早期部分就静止不动，看着像「无法开机」，
    实际是根本找不到系统盘。

    注意 GRUB 与 Linux 用的是两套驱动：GRUB 自带 LSI 支持，所以它能读出内核和
    initrd 并且真的把内核启起来，随后内核才因为找不到盘而卡住 —— 这也是「内核
    启动了但起不来」这个现象的来源。
    """
    first = str(keys[0] or "") if keys else ""
    if first.startswith("sata"):
        return "sata", "ahci"
    if first.startswith("nvme"):
        return "nvme", ""
    if first.startswith("ide"):
        return "ide", ""
    # virtio / scsi：VMware 上没有对应设备，只能换，选驱动最普及的 ahci
    return "sata", "ahci"


def _vmx_text(
    name: str,
    disks: List[Tuple[str, str]],
    memory_mb: int,
    cores: int,
    sockets: int,
    ostype: str,
    efi: bool,
) -> str:
    """生成一份 VMware 认的 .vmx（虚拟机配置文件）。

    为什么需要它：``qemu-img convert`` 转出来的 .vmdk 是**一块磁盘**，不是一台虚拟
    机。用 VMware 打开单个 .vmdk 只会得到一句「无法直接打开，请打开虚拟机配置文件
    (.vmx)」—— 它要的是一份描述硬件的文件。OVA 那条路已经有 OVF 描述，VMDK 这条路
    之前是空着的，用户拿到手打不开。

    控制器与网卡刻意选 lsilogic + e1000e：机器里跑的多半是从 PVE 搬过来的原系统，
    它不一定装了 virtio / vmxnet3 的驱动，而 LSI 与 Intel 网卡的驱动 Windows 与
    Linux 都自带。virtualHW.version 也压低到 14（2017 年的版本）—— 高版本只对旧的
    VMware 报错，而新版 VMware 打开低版本会自己提示升级，反方向不会。
    """
    lines = [
        '.encoding = "UTF-8"',
        'config.version = "8"',
        'virtualHW.version = "14"',
        "",
        f'displayName = "{name}"',
        f'guestOS = "{_VMX_OS.get(ostype, "other-64")}"',
        "",
        f'numvcpus = "{max(max(cores, 1) * max(sockets, 1), 1)}"',
        f'cpuid.coresPerSocket = "{max(cores, 1)}"',
        f'memsize = "{max(memory_mb, 256)}"',
    ]
    if efi:
        lines.append('firmware = "efi"')
    bus, bus_driver = _vmx_disk_bus([key for key, _ in disks])
    lines.append("")
    # sata / ide 每个控制器挂 4 个设备位，盘多就顺延到下一个控制器；nvme 一个就够
    ports = sorted({index // 4 for index in range(len(disks))}) if bus in (
        "sata",
        "ide",
    ) else [0]
    for port in ports:
        lines.append(f'{bus}{port}.present = "TRUE"')
        if bus_driver:
            lines.append(f'{bus}{port}.virtualDev = "{bus_driver}"')
    for index, (_key, filename) in enumerate(disks):
        port = index // 4 if bus in ("sata", "ide") else 0
        slot = index % 4 if bus in ("sata", "ide") else index
        lines += [
            f'{bus}{port}:{slot}.present = "TRUE"',
            f'{bus}{port}:{slot}.fileName = "{filename}"',
            f'{bus}{port}:{slot}.deviceType = "disk"',
        ]
    lines += [
        "",
        'ethernet0.present = "TRUE"',
        'ethernet0.virtualDev = "e1000e"',
        'ethernet0.connectionType = "nat"',
        'ethernet0.startConnected = "TRUE"',
        "",
        # 这一段是必需的，不是可选的：e1000e 是 **PCIe** 设备，而一台只声明了设备、
        # 没声明 root port 的虚拟机里它无处可插 —— VMware 打开时会直接报
        # 「Ethernet0 没有可用的 PCIe 插槽，请移除 Ethernet0」。VMware 自己新建
        # 虚拟机时写的就是这几行；编号惯例是 0 与 4~7（1~3 另有用途，不要挪）。
        'pciBridge0.present = "TRUE"',
        'pciBridge4.present = "TRUE"',
        'pciBridge4.virtualDev = "pcieRootPort"',
        'pciBridge4.functions = "8"',
        'pciBridge5.present = "TRUE"',
        'pciBridge5.virtualDev = "pcieRootPort"',
        'pciBridge5.functions = "8"',
        'pciBridge6.present = "TRUE"',
        'pciBridge6.virtualDev = "pcieRootPort"',
        'pciBridge6.functions = "8"',
        'pciBridge7.present = "TRUE"',
        'pciBridge7.virtualDev = "pcieRootPort"',
        'pciBridge7.functions = "8"',
        "",
        'floppy0.present = "FALSE"',
        "",
    ]
    return "\n".join(lines)


async def start_export(
    client: Any,
    node: str,
    vmid: int,
    name: str,
    fmt: str,
    storage: str,
    owner: str,
    connection: str,
) -> ExportJob:
    """登记并启动一个导出作业（后台执行，调用方立即拿到 id）。"""
    if fmt not in EXPORT_FORMATS:
        raise TransferError(f"不支持的导出格式：{fmt}")

    try:
        status = await client.get(f"/nodes/{node}/qemu/{vmid}/status/current")
    except Exception as exc:  # noqa: BLE001
        raise TransferError(f"读取虚拟机状态失败：{exc}") from exc
    state = str((status or {}).get("status") or "")
    if state != "stopped":
        raise TransferError(
            "虚拟机正在运行，无法导出。导出要逐块读取磁盘，运行中的机器拿不到一致的数据 —— "
            "请先关机（或待机），再回来导出。"
        )

    try:
        config = await client.get(f"/nodes/{node}/qemu/{vmid}/config") or {}
    except Exception as exc:  # noqa: BLE001
        raise TransferError(f"读取虚拟机配置失败：{exc}") from exc
    disks = vm_disks(config)
    if not disks:
        raise TransferError("这台虚拟机没有可导出的磁盘")

    row, message = await resolve_ssh_host(client)
    if not row:
        raise TransferError(message)

    host_path = await dir_storage_path(client, storage)
    if not host_path:
        raise TransferError(
            f"存储 {storage} 不是目录型（dir）存储，不能作为导出产物的落地位置。"
            "请选择一个 dir / NFS / CIFS 存储。"
        )

    job_id = uuid.uuid4().hex[:12]
    job = ExportJob(
        job_id,
        node,
        vmid,
        name or f"vm-{vmid}",
        fmt,
        storage,
        owner,
        connection,
    )
    job.dir = f"{host_path}/dump/{EXPORT_DIR_NAME}-{job_id}"
    job.detail = "准备导出目录"
    # 先把身份写进产物目录：这样即使面板中途重启、作业表清空，产物也「认得回来」。
    # 写失败不影响导出本身 —— 大不了退化成一条没有身份的孤儿产物。
    try:
        await _write_meta(row, job)
    except Exception:  # noqa: BLE001
        logger.warning("导出身份文件写入失败（不影响导出）：%s", job.dir)
    _forget_scan()
    _JOBS[job.id] = job
    _prune_jobs()
    asyncio.create_task(_run_export(job, row, config, disks))  # noqa: RUF006
    return job


def job_meta(job: ExportJob) -> Dict[str, Any]:
    """产物目录里那份身份文件的内容。"""
    return {
        "id": job.id,
        "node": job.node,
        "vmid": job.vmid,
        "name": job.name,
        "format": job.format,
        "storage": job.storage,
        "owner": job.owner,
        "connection": job.connection,
        "created": job.created,
    }


async def _write_meta(row: Dict[str, Any], job: ExportJob) -> None:
    """把身份写进产物目录。走 base64 是为了绕开 shell 转义（名称里有引号也不怕）。"""
    blob = base64.b64encode(
        json.dumps(job_meta(job), ensure_ascii=False).encode("utf-8")
    ).decode("ascii")
    await _remote_ok(
        row,
        f"mkdir -p {_quote(job.dir)} && "
        f"echo {_quote(blob)} | base64 -d > {_quote(f'{job.dir}/{META_NAME}')}",
        timeout=60,
    )


def _scan_command(dump_dir: str) -> str:
    """一条命令列出 dump 目录下所有导出产物：目录名、身份文件、产物文件与大小。

    刻意**不用** find 的 -printf / -type（GNU 专有），宿主机上是什么发行版说不准；
    stat 与 shell 通配走到哪都有。

    两个易踩点，改这个命令时留意：

    * ``cat`` 读到的身份文件是 base64 解出来的，**末尾没有换行** —— 后面必须自己
      补一个 ``echo``，否则它会和下一行的分隔符 ``--`` 粘成一行，分隔符一丢，
      整个目录的产物就都读不出来了（包括看起来正常的文件列表）。
    * 文件大小用 ``stat -c %s``：宿主机上是什么发行版说不准，别用 GNU 的
      ``find -printf``。
    """
    return (
        f"cd {_quote(dump_dir)} 2>/dev/null || exit 0; "
        f"for d in {EXPORT_DIR_NAME}-*/; do "
        '[ -d "$d" ] || continue; '
        "printf '== %s\n' \"$d\"; "
        f"cat \"${{d}}{META_NAME}\" 2>/dev/null; echo; "
        "printf -- '--\n'; "
        'for f in "$d"*; do [ -f "$f" ] || continue; '
        f'[ "$(basename \"$f\")" = {META_NAME} ] && continue; '
        "printf '%s %s\n' \"$(basename \"$f\")\" "
        '\"$(stat -c %s \"$f\" 2>/dev/null || echo 0)\"; '
        "done; "
        "done"
    )


def _parse_scan(
    output: str, connection: str, storage: str, dump_dir: str
) -> List[Dict[str, Any]]:
    """把 _scan_command 的输出拆成一条条产物记录。"""
    items: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    section = ""
    for line in output.splitlines():
        if line.startswith("== "):
            raw = line[3:].strip().rstrip("/")
            current = {"raw_dir": raw, "meta": {}, "files": []}
            items.append(current)
            section = "meta"
            continue
        if current is None:
            continue
        if line.strip() == "--":
            section = "files"
            continue
        if section == "meta":
            # 身份文件读不到时这里是一行空白，json 解析失败即当作「没有身份」
            try:
                current["meta"] = json.loads(line)
            except (ValueError, TypeError):
                current["meta"] = {}
            continue
        name, _, size = line.rpartition(" ")
        if not name:
            continue
        try:
            current["files"].append({"name": name, "size": int(size)})
        except ValueError:
            current["files"].append({"name": name, "size": 0})

    out: List[Dict[str, Any]] = []
    for raw in items:
        dir_name = str(raw["raw_dir"]).rsplit("/", 1)[-1]
        if not dir_name.startswith(f"{EXPORT_DIR_NAME}-"):
            continue
        meta = raw.get("meta") or {}
        job_id = dir_name[len(EXPORT_DIR_NAME) + 1 :] or dir_name
        out.append(
            {
                "id": job_id,
                "node": str(meta.get("node") or ""),
                "vmid": int(meta.get("vmid") or 0),
                "name": str(meta.get("name") or ""),
                "format": str(meta.get("format") or ""),
                "storage": storage,
                "status": "done",
                "stage": "done",
                "progress": 100,
                "detail": "导出完成" if meta else "面板重启前留下的产物",
                "files": raw.get("files") or [],
                "created": int(meta.get("created") or 0),
                "finished": 0,
                # 内部用，不进 public()
                "_dir": f"{dump_dir.rstrip('/')}/{dir_name}",
                "_connection": connection,
                "_owner": str(meta.get("owner") or ""),
                "_orphan": not meta,
            }
        )
    return out


async def scan_exports() -> List[Dict[str, Any]]:
    """列出宿主机上还留着的导出产物（每个 dir 存储一次 SSH）。

    这条路径存在的理由只有一个：**产物的可见性不能依赖内存**。面板一重启、作业一被
    挤出上限，磁盘上的镜像就成了孤儿 —— 用户看不到它、下不了它、也删不掉它，而它
    还在占空间。所以真正的凭据是磁盘上的目录与身份文件，内存只是「跑得快的那份」。
    """
    from . import pve

    now = time.time()
    cached = _SCAN_CACHE.get("items")
    if cached is not None and now - float(_SCAN_CACHE.get("at") or 0) < _SCAN_TTL:
        return cached

    found: List[Dict[str, Any]] = []
    for profile, client in pve.all_connection_clients():
        connection = str(profile.get("id") or "")
        row, _ = await resolve_ssh_host(client)
        if not row:
            continue
        try:
            storages = await client.get("/storage") or []
        except Exception:  # noqa: BLE001 - 一条连接读不到不影响其它主机
            continue
        for item in storages:
            if str(item.get("type") or "") != "dir":
                continue
            storage = str(item.get("storage") or "")
            base = str(item.get("path") or "").rstrip("/")
            if not storage or not base:
                continue
            dump_dir = f"{base}/dump"
            try:
                ok, out = await sshremote.run_command(
                    row, _scan_command(dump_dir), timeout=60
                )
            except Exception:  # noqa: BLE001
                continue
            if ok:
                found.extend(_parse_scan(out, connection, storage, dump_dir))

    _SCAN_CACHE["at"] = now
    _SCAN_CACHE["items"] = found
    return found


def _forget_scan() -> None:
    """产物有增删时让扫描结果立刻失效（否则刚删掉的镜像还在列表里待 15 秒）。"""
    _SCAN_CACHE["at"] = 0.0
    _SCAN_CACHE["items"] = None


async def find_export(job_id: str) -> Optional[ExportJob]:
    """按 id 找产物：先看内存作业，没有就去宿主机上把它认回来。

    认回来的对象与正常完成的内存作业**长得一样**（status=done、files 齐备、
    dir 与 connection 都在），所以下载和删除不需要任何特殊分支。
    """
    job = _JOBS.get(job_id)
    if job:
        return job

    for item in await scan_exports():
        if str(item.get("id")) != job_id:
            continue
        job = ExportJob(
            job_id,
            str(item.get("node") or ""),
            int(item.get("vmid") or 0),
            str(item.get("name") or f"export-{job_id}"),
            str(item.get("format") or ""),
            str(item.get("storage") or ""),
            str(item.get("_owner") or ""),
            str(item.get("_connection") or ""),
        )
        job.status = "done"
        job.stage = "done"
        job.progress = 100
        job.detail = str(item.get("detail") or "")
        job.files = list(item.get("files") or [])
        job.dir = str(item.get("_dir") or "")
        job.created = int(item.get("created") or 0)
        job.finished = 0
        _JOBS[job_id] = job  # 认领下来：后续下载、删除都走同一条路
        return job
    return None


def _qemu_img_format(fmt: str) -> str:
    return "vmdk" if fmt == "ova" else fmt


async def _remote_ok(row: Dict[str, Any], command: str, timeout: float = 60) -> str:
    ok, out = await sshremote.run_command(row, command, timeout=timeout)
    if not ok:
        raise TransferError(out.strip()[:300] or "远程命令执行失败")
    return out


async def _run_export(
    job: ExportJob,
    row: Dict[str, Any],
    config: Dict[str, Any],
    disks: List[Dict[str, Any]],
) -> None:
    """后台执行：定位卷 → 转换 → （打包） → 登记产物。"""
    target_fmt = _qemu_img_format(job.format)
    out_dir = job.dir
    quoted_dir = _quote(out_dir)
    try:
        await _remote_ok(
            row, f"mkdir -p {quoted_dir} && rm -f {quoted_dir}/*", timeout=60
        )

        # 1. 逐盘定位 + 转换
        job.stage = "converting"
        total = sum(int(d.get("size") or 0) for d in disks) or 0
        produced: List[Dict[str, Any]] = []
        for index, disk in enumerate(disks):
            volid = _quote(str(disk["volid"]))
            source = (await _remote_ok(row, f"pvesm path {volid}", timeout=60)).strip()
            if not source:
                raise TransferError(f"PVE 没能给出卷 {disk['volid']} 的路径")
            out_name = f"{job.name}-disk-{index}.{target_fmt}"
            out_path = f"{out_dir}/{out_name}"
            job.detail = f"转换 {disk['key']} → {out_name}"
            command = (
                f"qemu-img convert -p -O {target_fmt} "
                f"{_quote(source)} {_quote(out_path)}"
            )
            # 转换期间按产物大小估算进度：qemu-img 自己不会把进度吐给我们
            #（-p 的输出进的是终端，SSH 非交互执行时读不到）
            convert = asyncio.create_task(sshremote.run_command(row, command, timeout=7200))
            while not convert.done():
                await asyncio.sleep(5)
                if total:
                    size = await _dir_bytes(row, out_dir)
                    job.progress = min(95, int(size * 100 / total))
            ok, out = await convert
            if not ok:
                raise TransferError(f"{disk['key']} 转换失败：{out.strip()[:300]}")
            produced.append({"name": out_name, "path": out_path, "size": 0})

        # 2. 需要 OVA 时补一份 OVF 描述并打包
        if job.format == "ova":
            job.stage = "packing"
            job.detail = "生成 OVF 描述并打包"
            ovf = _ovf_xml(
                job.name,
                job.vmid,
                job.format,
                disks,
                [str(item["name"]) for item in produced],
                int(config.get("memory") or 1024),
                int(config.get("cores") or 1),
                str(config.get("ostype") or "l26"),
            )
            blob = base64.b64encode(ovf.encode("utf-8")).decode("ascii")
            await _remote_ok(
                row,
                f"echo {_quote(blob)} | base64 -d > {_quote(out_dir + '/vm.ovf')}",
                timeout=60,
            )
            ova_path = f"{out_dir}/{job.name}.ova"
            members = " ".join(
                _quote(f"{out_dir}/{str(item['name'])}") for item in produced
            )
            await _remote_ok(
                row,
                f"cd {quoted_dir} && tar -cf {_quote(ova_path)} vm.ovf {members}",
                timeout=3600,
            )
            # 只删本次真正生成的临时件。原来用 disk-*.* 通配，在产物名带前缀之后
            # 就删不干净了（还可能误删名字里恰含 disk 的东西）
            await _remote_ok(
                row, f"rm -f {_quote(f'{out_dir}/vm.ovf')} {members}", timeout=120
            )
            produced = [{"name": f"{job.name}.ova", "path": ova_path, "size": 0}]

        # 2b. 单独下载的 .vmdk 是「一块盘」而不是一台机器 —— 用 VMware 打开它，
        #     只会收到一句「请打开虚拟机配置文件 (.vmx)」。顺手把那份配置文件也生成
        #     出来，用户拿到的就是一整套能直接开机的虚拟机。
        if job.format == "vmdk":
            job.stage = "packing"
            job.detail = "生成 VMware 配置文件 (.vmx)"
            vmx_name = f"{job.name}.vmx"
            vmx = _vmx_text(
                job.name,
                [
                    (str(disk.get("key") or ""), str(item["name"]))
                    for disk, item in zip(disks, produced)
                ],
                int(config.get("memory") or 1024),
                int(config.get("cores") or 1),
                int(config.get("sockets") or 1),
                str(config.get("ostype") or "l26"),
                str(config.get("bios") or "").lower() == "ovmf",
            )
            blob = base64.b64encode(vmx.encode("utf-8")).decode("ascii")
            await _remote_ok(
                row,
                f"echo {_quote(blob)} | base64 -d > {_quote(f'{out_dir}/{vmx_name}')}",
                timeout=60,
            )
            produced.append(
                {"name": vmx_name, "path": f"{out_dir}/{vmx_name}", "size": 0}
            )

        # 3. 登记产物大小
        files: List[Dict[str, Any]] = []
        for item in produced:
            size = 0
            try:
                out = await _remote_ok(
                    row, f"stat -c %s -- {_quote(str(item['path']))}", timeout=30
                )
                size = int(out.strip().splitlines()[-1])
            except Exception:  # noqa: BLE001 - 拿不到大小不影响下载
                size = 0
            files.append({"name": item["name"], "size": size})
        job.files = files
        job.progress = 100
        job.stage = "done"
        job.status = "done"
        job.detail = "导出完成"
        job.finished = int(time.time())
        logger.info(
            "导出完成：%s/%s → %s（%s）", job.node, job.vmid, job.dir, job.format
        )
    except Exception as exc:  # noqa: BLE001 - 后台任务，失败要落到作业状态上
        job.status = "failed"
        job.stage = "failed"
        job.detail = str(exc)[:300]
        job.finished = int(time.time())
        logger.warning("导出失败：%s/%s → %s", job.node, job.vmid, job.detail)


async def _dir_bytes(row: Dict[str, Any], path: str) -> int:
    try:
        ok, out = await sshremote.run_command(
            row, f"du -sb {_quote(path)} 2>/dev/null | cut -f1", timeout=30
        )
        return int(out.strip().splitlines()[-1]) if ok and out.strip() else 0
    except Exception:  # noqa: BLE001
        return 0


async def file_size(row: Dict[str, Any], path: str) -> int:
    ok, out = await sshremote.run_command(
        row, f"stat -c %s -- {_quote(path)}", timeout=30
    )
    if not ok:
        return 0
    try:
        return int(out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return 0


async def cleanup_job(job: ExportJob) -> None:
    """删除宿主机上的导出产物。"""
    row, message = await resolve_ssh_host_strict(job)
    if not row:
        raise TransferError(message)
    quoted = _quote(job.dir)
    await _remote_ok(row, f"rm -rf {quoted}", timeout=300)
    job.files = []
    job.detail = "产物已删除"
    _JOBS.pop(job.id, None)
    _forget_scan()


async def resolve_ssh_host_strict(job: ExportJob) -> Tuple[Optional[Dict[str, Any]], str]:
    from . import pve

    client = pve.client_for_connection(job.connection or "")
    return await resolve_ssh_host(client)
