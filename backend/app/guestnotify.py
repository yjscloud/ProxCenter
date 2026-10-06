"""下发通知：新机器建好之后，把「怎么连上它」送到创建者手上。

下发的机器有两条交付渠道，缺一不可：

* **站内消息** —— 顶栏铃铛里当场能看到地址、账号、口令。口令尤其要紧：它只在
  这一次下发时存在（面板不落库），审计里也刻意只记「有没有设」（见 routers/lxc.py），
  所以这条消息往往就是用户拿到它的唯一机会；
* **邮件** —— 人不会一直盯着面板，而机器建完通常要过几分钟才需要连接信息。发不发、
  发给谁完全由该用户自己的「告警邮件」开关决定（复用 :func:`alerting.send_alert_email`
  那一套判断：没开就一条都不发），绝不越过用户去打扰他。

刻意不做的事：口令不进审计日志，也不写进任何长期留存的地方。通知是**一次性交付**，
没收到就重新下发一次 —— 这比「到处留一份口令」安全得多。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from . import alerting, i18n, notifications

logger = logging.getLogger(__name__)


@dataclass
class DeployInfo:
    """一次下发里要告诉用户的全部信息 —— 字段就是通知正文里的那些行。"""

    guest_type: str                 # "qemu" | "lxc"
    node: str
    vmid: int
    name: str
    #: 来源（模板 / 发行版模板 / 镜像路径）。技术标识，不翻译
    origin: str = ""
    cores: str = ""
    #: 已格式化的容量（"8 GB"），空串表示这次拿不到
    memory: str = ""
    disk: str = ""
    bridge: str = ""
    #: 静态地址；DHCP 的机器这里是空的（地址要等客户机起来才知道）
    ip: str = ""
    gateway: str = ""
    username: str = ""
    password: str = ""


# --------------------------------------------------------------- 取值助手


def memory_text(mb: Any) -> str:
    """内存：MB → 给人看的字符串（2048 → "2 GB"）。拿不到就返回空串。"""
    try:
        value = int(mb)
    except (TypeError, ValueError):
        return ""
    if value <= 0:
        return ""
    if value % 1024 == 0:
        return f"{value // 1024} GB"
    return f"{value} MB"


def static_ip(value: Any) -> str:
    """只认静态地址：dhcp / manual 一律当成「没有地址」。

    与 :mod:`guestip` 同一套口径 —— 通知里写「IP：dhcp」毫无信息量，不如让
    :func:`_body` 明说「地址由 DHCP 分配」。
    """
    text = str(value or "").strip()
    if not text or text.lower() in ("dhcp", "auto", "manual", "none"):
        return ""
    return text


def _first(values: Any) -> Optional[Any]:
    items = list(values or [])
    return items[0] if items else None


def from_vm_request(
    payload: Any, *, node: str, vmid: int, origin: str = ""
) -> DeployInfo:
    """从虚拟机的创建请求里抽出要通知的字段。

    新建与克隆两条路用的是同一个 ``VmCreateRequest``，所以共用这一个函数 ——
    两边各写一份的结果必然是「克隆出来的机器通知里少几行」。
    """
    ci = getattr(payload, "cloudinit", None)
    ip_cfg = _first(getattr(ci, "ip_configs", None))
    disk = _first(getattr(payload, "disks", None))
    net = _first(getattr(payload, "networks", None))
    cores = int(getattr(payload, "cores", 0) or 0)
    sockets = int(getattr(payload, "sockets", 1) or 1)
    size = getattr(disk, "size", None)
    return DeployInfo(
        guest_type="qemu",
        node=node,
        vmid=vmid,
        name=str(getattr(payload, "name", "") or ""),
        origin=origin,
        cores=f"{cores * sockets} vCPU" if cores else "",
        memory=memory_text(getattr(payload, "memory", None)),
        disk=f"{int(size)} GB" if size else "",
        bridge=str(getattr(net, "bridge", "") or ""),
        ip=static_ip(getattr(ip_cfg, "ip", "")),
        gateway=str(getattr(ip_cfg, "gateway", "") or ""),
        username=str(getattr(ci, "user", "") or ""),
        password=str(getattr(ci, "password", "") or ""),
    )


def from_lxc_request(
    payload: Any, *, node: str, vmid: int, origin: str = ""
) -> DeployInfo:
    """从容器创建请求里抽出要通知的字段。"""
    net = _first(getattr(payload, "networks", None))
    setup = getattr(payload, "setup", None)
    cores = int(getattr(payload, "cores", 0) or 0)
    rootfs = getattr(payload, "rootfs", None)
    return DeployInfo(
        guest_type="lxc",
        node=node,
        vmid=vmid,
        name=str(getattr(payload, "hostname", "") or ""),
        origin=origin,
        cores=f"{cores} vCPU" if cores else "",
        memory=memory_text(getattr(payload, "memory", None)),
        disk=f"{int(rootfs)} GB" if rootfs else "",
        bridge=str(getattr(net, "bridge", "") or ""),
        ip=static_ip(getattr(net, "ip", "")),
        gateway=str(getattr(net, "gateway", "") or ""),
        # 容器没有 cloud-init，登录账号就是 root
        username="root",
        password=str(getattr(setup, "password", "") or ""),
    )


def template_label(vmid: Any) -> str:
    """克隆的来源标识（按收件人语言渲染，别把中文硬编码到别的模块里）。"""
    return i18n.pick(f"模板 {vmid}", f"template {vmid}")


# --------------------------------------------------------------- 通知正文


def _noun(guest_type: str) -> str:
    if guest_type == "lxc":
        return i18n.pick("容器", "container")
    return i18n.pick("虚拟机", "virtual machine")


def _title(info: DeployInfo) -> str:
    noun = _noun(info.guest_type)
    return i18n.pick(
        f"已下发{noun}：{info.name}",
        f"{noun.capitalize()} deployed: {info.name}",
    )


def _link(info: DeployInfo) -> str:
    family = "lxc" if info.guest_type == "lxc" else "vms"
    return f"/{family}/{info.node}/{info.vmid}"


def _body(info: DeployInfo) -> str:
    sep = i18n.pick("：", ": ")
    rows: List[str] = []

    def row(label: str, value: str) -> None:
        if value:
            rows.append(f"{label}{sep}{value}")

    row(i18n.pick("位置", "Location"), f"{info.node} / {info.vmid}")
    specs = " / ".join(part for part in (info.cores, info.memory, info.disk) if part)
    row(i18n.pick("规格", "Specs"), specs)
    row(i18n.pick("来源", "Source"), info.origin)

    network = info.ip or i18n.pick(
        "DHCP（地址由网络分配）", "DHCP (address assigned by the network)"
    )
    if info.ip and info.gateway:
        network += i18n.pick(f"（网关 {info.gateway}）", f" (gateway {info.gateway})")
    if info.bridge:
        network += i18n.pick(f" · 网桥 {info.bridge}", f" · bridge {info.bridge}")
    row(i18n.pick("网络", "Network"), network)

    row(i18n.pick("账号", "Account"), info.username)
    row(i18n.pick("口令", "Password"), info.password)

    if info.password:
        rows.append("")
        rows.append(
            i18n.pick(
                "口令只在这次下发时给出，面板不会保存它 —— 请尽快登录并改掉。",
                "This password is handed out once and is not stored by the panel — "
                "log in and change it soon.",
            )
        )
    return "\n".join(rows)


# --------------------------------------------------------------- 入口


async def notify_deployed(user: Dict[str, Any], info: DeployInfo) -> None:
    """下发成功后通知创建者：站内消息 +（他开了邮箱提醒的话）邮件。

    **整体吞掉异常**：机器已经建好了，通知发不出去不该让这次创建看起来失败 ——
    用户会以为没建成，转头再点一次，于是多出一台重复的机器。
    """
    owner = str((user or {}).get("username") or "").strip()
    if not owner:
        return
    try:
        # 按收件人的语言渲染：他可能在面板里用中文、邮件偏好却是英文
        async with alerting.recipient_language(owner):
            title = _title(info)
            body = _body(info)
            await notifications.push(
                owner,
                title=title,
                body=body,
                link=_link(info),
                kind="deploy",
                level="success",
            )
            sent, detail = await alerting.send_alert_email(owner, title, body)
        if not sent:
            # 最常见的原因是「没开邮件提醒」，那是正常路径，不该刷 warning
            logger.debug("下发通知没给 %s 发邮件：%s", owner, detail)
    except Exception:  # noqa: BLE001 - 通知失败不能影响创建结果
        logger.warning("下发通知发送失败（创建结果不受影响）", exc_info=True)
