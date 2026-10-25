"""内网穿透（frp）规则写入前的三道防线。

为什么要单独一个模块
--------------------
``frpc`` 跑在面板后端所在的机器 / 容器里，规则里的 ``local_ip`` 就是它要连的
目标。这个字段此前是「想填什么就填什么」的：任何 ``frp.manage`` 用户都能把
面板自己、PVE API、内网任意主机映射到公网端口，而且改完立即重启 frpc 生效 ——
等于给每个登录用户开了一条内网 SSRF / 端口转发通道。这里把判定收成三件事：

1. **目标白名单**（:func:`check_target`）

   * 回环、未指定、链路本地、组播、保留地址**一律拒绝**；
   * 面板自身的地址**一律拒绝**（哪怕它恰好出现在白名单里）；
   * 普通用户只能指向**自己名下**的虚机 / 容器 IP，或管理员在
     ``FRP_ALLOW_LOCAL_CIDRS`` 里显式放行的网段；
   * 管理员不受白名单限制 —— 面板本来就是他的，挡他没有意义，但「未指定地址」
     这种明显无效的取值仍然拒绝。

   注意「自己名下」是按 :mod:`app.ownership` 的归属记录判定的，IP 则来自
   :mod:`app.guestip`（Guest Agent / 容器网卡 / cloud-init 静态配置）。取不到
   PVE 时不放行（fail-closed）：宁可让用户看到一句「确认不了」，也不能让一条
   指向内网关键机器的规则悄悄落库。

2. **公网端口区间**（:func:`check_remote_port`）：只在管理员设定的区间内
   分配（:func:`remote_port_range`，可随时在页面上调整，默认
   :data:`REMOTE_PORT_MIN` – :data:`REMOTE_PORT_MAX`），并显式拒绝
   22 / 80 / 443 / 7001 / 8006 这类关键端口（与区间无关，始终生效）。

3. **端口冲突**：frpc 只有一个进程、连同一台 frps，同一个 ``remote_port``
   出现两次时后一条会抢不到端口，用户看到的是「规则建好了但连不上」。

所有失败都抛 :class:`PolicyError`，由路由层翻成 ``HTTPException`` 并写审计。
"""
from __future__ import annotations

import ipaddress
import logging
import socket
import struct
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple, Union

from . import store
from .config import settings

logger = logging.getLogger(__name__)

Address = Union[ipaddress.IPv4Address, ipaddress.IPv6Address]
Network = Union[ipaddress.IPv4Network, ipaddress.IPv6Network]

# ---------------------------------------------------------------- 端口策略
#: 公网端口的**内置兜底区间**。管理员可以在「内网穿透」页面上把它改成任意
#: 合法区间（见 :func:`remote_port_range` / :func:`set_remote_port_range`），
#: 没在页面上改过时跟随环境配置 ``FRP_REMOTE_PORT_MIN`` / ``FRP_REMOTE_PORT_MAX``。
#: 默认值刻意避开 1–1023 与常见服务端口：frps 暴露在公网时，22 / 80 / 443
#: 这类端口往往已被宿主机自己的服务占用，让用户随手填会撞车；也避免把面板
#: （8080）与 PVE（8006）的端口映射出去。
REMOTE_PORT_MIN = 40000
REMOTE_PORT_MAX = 50000

#: 管理员设定的区间在库里的键（写成 "40000-50000"）。没有这个键时回落到
#: 环境配置，再回落到上面的内置默认值 —— 升级部署不会悄悄改变既有行为。
PORT_RANGE_KEY = "frp.remote_port_range"

#: 端口本身的合法边界（TCP 端口全集）。区间只是取值范围，不能超出这个范围。
PORT_LIMIT_MIN = 1
PORT_LIMIT_MAX = 65535

#: 关键端口黑名单。默认区间已经排除了它们，列在这里是**纵深防御** ——
#: 管理员把区间调大（例如 1–65535）时，这些端口仍然不会被顺手放进来。
FORBIDDEN_REMOTE_PORTS = frozenset(
    {
        20, 21, 22, 23, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995,
        2375, 2376, 3306, 3389, 5432, 5900, 6379, 7000, 7001, 8006,
        8080, 8443, 9090, 11211, 27017,
    }
)


class PolicyError(Exception):
    """规则不合规。

    ``status_code`` 让路由层区分「填错了」（400）与「不允许」（403 / 409），
    前端只需要展示 ``message``。
    """

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


# -------------------------------------------------------- 公网端口区间（可调）
def normalise_port_range(minimum: Any, maximum: Any) -> Tuple[int, int]:
    """校验并归一化一个端口区间，返回 ``(min, max)``。

    只判断「能不能当端口区间用」：落在 1–65535、``min ≤ max``、且区间里至少
    有一个端口不是关键端口。黑名单与区间无关、始终生效，所以整段都落在黑名单
    里的区间等于一条规则也建不出来，直接在保存时报错比让用户对着报错猜要好。
    """
    try:
        low = int(minimum)
        high = int(maximum)
    except (TypeError, ValueError) as exc:
        raise PolicyError("公网端口区间必须是数字") from exc

    if not (
        PORT_LIMIT_MIN <= low <= PORT_LIMIT_MAX
        and PORT_LIMIT_MIN <= high <= PORT_LIMIT_MAX
    ):
        raise PolicyError(
            f"端口必须在 {PORT_LIMIT_MIN}–{PORT_LIMIT_MAX} 之间（当前 {low}–{high}）"
        )
    if low > high:
        raise PolicyError(f"起始端口不能大于结束端口（当前 {low}–{high}）")
    if all(port in FORBIDDEN_REMOTE_PORTS for port in range(low, high + 1)):
        raise PolicyError(
            "该区间里的端口全部是面板 / PVE / 常见服务的关键端口"
            "（如 22 / 80 / 443 / 7000 / 8006），请换一个区间"
        )
    return low, high


def default_port_range() -> Tuple[int, int]:
    """环境配置给出的区间（没有库设置时的兜底）。

    配置写错（起止颠倒 / 超出端口范围）只记日志、回落到内置默认值 —— 这是
    规则校验的必经之路，不能让一个写错的启动参数把所有规则写入打成 500。
    """
    try:
        return normalise_port_range(
            settings.frp_remote_port_min, settings.frp_remote_port_max
        )
    except PolicyError as exc:
        logger.warning(
            "FRP_REMOTE_PORT_MIN / FRP_REMOTE_PORT_MAX 不是合法的端口区间，"
            "已回落到 %s–%s：%s",
            REMOTE_PORT_MIN,
            REMOTE_PORT_MAX,
            exc.message,
        )
        return REMOTE_PORT_MIN, REMOTE_PORT_MAX


async def remote_port_range() -> Tuple[int, int]:
    """当前生效的公网端口区间。

    优先级：管理员在页面上保存的值 → 环境配置 → 内置默认值。读库失败
    （单元测试没初始化数据库 / 库暂时不可用）同样回落到环境配置 —— 区间校验
    是每次写规则的必经之路，不能因为 settings 读不到就整条链路 500。
    """
    try:
        raw = await store.get_setting(PORT_RANGE_KEY)
    except Exception:  # noqa: BLE001 - 读不到设置就退回环境配置
        raw = None

    text = str(raw or "").strip()
    if text:
        low_text, _, high_text = text.partition("-")
        try:
            return normalise_port_range(low_text, high_text)
        except PolicyError:
            logger.warning("库里保存的 frp 端口区间不合法，已忽略：%s", text)
    return default_port_range()


async def set_remote_port_range(minimum: Any, maximum: Any) -> Tuple[int, int]:
    """保存管理员设定的区间（校验失败抛 :class:`PolicyError`）。"""
    low, high = normalise_port_range(minimum, maximum)
    await store.set_setting(PORT_RANGE_KEY, f"{low}-{high}")
    return low, high


# ------------------------------------------------------------------ 地址工具
def parse_ip(value: Any) -> Address:
    """把用户输入解析成 IP 地址；非法直接拒绝（不做任何猜测 / 补全）。"""
    text = str(value or "").strip()
    if text.startswith("[") and text.endswith("]"):
        # 允许 IPv6 写成 [::1] —— 有人会顺手带上方括号
        text = text[1:-1].strip()
    if not text:
        raise PolicyError("请填写目标 IP")
    try:
        return ipaddress.ip_address(text)
    except ValueError as exc:
        raise PolicyError(f"目标 IP 不是合法的地址：{text}") from exc


def _forbidden_reason(addr: Address) -> str:
    """这个地址为什么不能作为穿透目标（空串 = 没意见）。"""
    if addr.is_unspecified:
        return "未指定地址（0.0.0.0 / ::）"
    if addr.is_loopback:
        return "回环地址（127.0.0.0/8、::1）"
    if addr.is_link_local:
        return "链路本地地址（169.254.0.0/16、fe80::/10）"
    if addr.is_multicast:
        return "组播地址"
    if addr.is_reserved:
        return "保留地址"
    return ""


def _contains(networks: Iterable[Network], addr: Address) -> bool:
    return any(addr.version == net.version and addr in net for net in networks)


# ------------------------------------------------------------ 面板自身的网络
_SIOCGIFADDR = 0x8915
_SIOCGIFNETMASK = 0x891B


def _ipv4_interfaces() -> List[Tuple[str, str]]:
    """本机每块网卡的 ``(IPv4 地址, 掩码)``。

    用 ioctl 直接问内核，不引第三方依赖；非 Linux / 取不到时返回空列表 ——
    调用方（面板自身地址判定）会退化成「只靠回环 / 链路本地拦截」，不至于让
    整个接口报错。
    """
    if not sys.platform.startswith("linux"):
        return []
    result: List[Tuple[str, str]] = []
    try:
        import fcntl
    except ImportError:  # pragma: no cover - 非 Unix
        return []
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    except OSError:  # pragma: no cover - 极端环境
        return []
    try:
        for _index, name in socket.if_nameindex():
            request = struct.pack("256s", name[:15].encode("utf-8", "ignore"))
            try:
                addr = socket.inet_ntoa(
                    fcntl.ioctl(sock.fileno(), _SIOCGIFADDR, request)[20:24]
                )
                mask = socket.inet_ntoa(
                    fcntl.ioctl(sock.fileno(), _SIOCGIFNETMASK, request)[20:24]
                )
            except OSError:
                continue  # 没有 IPv4 地址的网卡（如纯 v6 / 未启用）
            result.append((addr, mask))
    except OSError:  # pragma: no cover
        return []
    finally:
        sock.close()
    return result


def _ipv6_local() -> Set[str]:
    """``/proc/net/if_inet6`` 里的本机 IPv6 地址。"""
    out: Set[str] = set()
    try:
        lines = Path("/proc/net/if_inet6").read_text(encoding="utf-8").splitlines()
    except OSError:
        return out
    for line in lines:
        parts = line.split()
        if not parts:
            continue
        try:
            out.add(str(ipaddress.IPv6Address(int(parts[0], 16))))
        except ValueError:
            continue
    return out


def local_addresses() -> Set[str]:
    """面板后端自身的全部 IP（IPv4 + IPv6）。"""
    out = {addr for addr, _mask in _ipv4_interfaces()}
    out |= _ipv6_local()
    if not out:
        # 非 Linux（本地开发）上 ioctl / /proc 都不可用，退化成按主机名解析。
        # 拿不到也就算了：回环 / 链路本地 / 未指定地址另有硬拦。
        try:
            out |= {
                str(info[4][0])
                for info in socket.getaddrinfo(socket.gethostname(), None)
            }
        except OSError:
            pass
    return out


def panel_networks() -> List[Network]:
    """面板后端所在的网段（本机各网卡按掩码展开）。"""
    networks: List[Network] = []
    for addr, mask in _ipv4_interfaces():
        try:
            networks.append(ipaddress.ip_network(f"{addr}/{mask}", strict=False))
        except ValueError:  # pragma: no cover - 掩码异常
            continue
    return networks


def allowed_cidrs() -> List[Network]:
    """管理员显式放行的目标网段（``FRP_ALLOW_LOCAL_CIDRS``）。

    非法条目只记日志、不放行 —— 配置写错时的正确表现是「少开一扇门」，
    而不是整个白名单失效。
    """
    networks: List[Network] = []
    for item in str(settings.frp_allow_local_cidrs or "").split(","):
        text = item.strip()
        if not text:
            continue
        try:
            networks.append(ipaddress.ip_network(text, strict=False))
        except ValueError:
            logger.warning("FRP_ALLOW_LOCAL_CIDRS 中不是合法的 IP / 网段，已忽略：%s", text)
    return networks


# ------------------------------------------------------- 用户名下的客户机 IP
async def own_guest_targets(username: str) -> List[Dict[str, Any]]:
    """某个用户名下虚机 / 容器的地址清单（带展示信息）。

    返回按 VMID 排序的 ``[{"ip","name","vmid","node","type"}]`` —— 这就是普通
    用户被允许指向的**全部**目标，前端拿它做「目标地址」下拉，后端拿同一份
    判定能不能建规则（见 :func:`check_target`）。

    取舍与 :func:`own_guest_ips` 一致：

    * 归属按 :mod:`app.ownership` —— 没有归属记录的存量机器不算「自己的」；
    * IP 交给 :mod:`app.guestip`（有进程内 + 落库两级缓存，DHCP 机器也能拿到）；
    * 单条连接读不到、单台机器解析失败都只跳过它自己 —— 但整体拿不到任何地址
      时返回空列表，调用方据此拒绝（fail-closed）。

    早期归属记录的连接前缀是 ``-``（单连接时代）：只有当「节点 + VMID」在所有
    连接里唯一时才认它，否则两台 PVE 上同名节点、同号机器会把对方的地址算到
    这个人头上。
    """
    if not username:
        return []

    from . import guestip, ownership
    from .pve import all_connection_clients, get_client, parallel

    refs = set(await ownership.list_owned_guests(username))
    if not refs:
        return []

    connections = list(all_connection_clients())
    if not connections:
        # 还没配多连接列表（仅用环境变量 / 旧单连接配置）：退化成当前连接
        try:
            connections = [(None, get_client())]
        except Exception:  # noqa: BLE001 - 没配连接时就是「确认不了」
            return []

    rows: List[Dict[str, Any]] = []
    seen: Dict[Tuple[str, Any], int] = {}
    for profile, client in connections:
        cid = str((profile or {}).get("id") or "")
        try:
            resources = await client.cluster_resources("vm")
        except Exception as exc:  # noqa: BLE001 - 一条连接读不到不影响其它主机
            logger.debug("frp 目标校验：读取连接 %s 的客户机清单失败：%s", cid or "-", exc)
            continue
        for item in resources or []:
            kind = str(item.get("type") or "")
            if kind not in ("qemu", "lxc"):
                continue
            node = str(item.get("node") or "")
            vmid = item.get("vmid")
            if not node or vmid in (None, ""):
                continue
            key = (node, vmid)
            seen[key] = seen.get(key, 0) + 1
            rows.append(
                {
                    "connection_id": cid,
                    "node": node,
                    "vmid": vmid,
                    "name": str(item.get("name") or ""),
                    "type": kind,
                    "status": str(item.get("status") or ""),
                }
            )

    owned_rows: List[Dict[str, Any]] = []
    for row in rows:
        key = (str(row["node"]), row["vmid"])
        exact = ownership.vm_ref(row["connection_id"], row["node"], row["vmid"])
        legacy = ownership.vm_ref("", row["node"], row["vmid"])
        if exact in refs or (seen.get(key) == 1 and legacy in refs):
            owned_rows.append(row)

    if not owned_rows:
        return []

    # 逐台解析地址：guestip 内部有缓存，并发上限压住对 PVE 的压力
    clients: Dict[str, Any] = {
        str((profile or {}).get("id") or ""): client for profile, client in connections
    }
    ip_list = await parallel(
        (
            guestip.resolve(clients.get(str(row["connection_id"]), connections[0][1]), row)
            for row in owned_rows
        ),
        limit=8,
    )

    out: List[Dict[str, Any]] = []
    seen_ips: Set[str] = set()
    for row, ip in zip(owned_rows, ip_list):
        text = str(ip).strip() if isinstance(ip, str) else ""
        if not text or text in seen_ips:
            continue
        seen_ips.add(text)
        try:
            vmid = int(row["vmid"])
        except (TypeError, ValueError):
            vmid = 0
        out.append(
            {
                "ip": text,
                "name": str(row.get("name") or ""),
                "vmid": vmid,
                "node": str(row.get("node") or ""),
                "type": str(row.get("type") or ""),
            }
        )
    out.sort(key=lambda item: (item["vmid"], item["ip"]))
    return out


async def own_guest_ips(username: str) -> Set[str]:
    """某个用户名下虚机 / 容器的 IP 集合（:func:`own_guest_targets` 的投影）。"""
    return {item["ip"] for item in await own_guest_targets(username)}


# ------------------------------------------------- 用户授权（管理员按人放行）
def grant_networks(entries: Iterable[Any]) -> List[Network]:
    """把管理员授权的条目（IP / 网段）转成可比较的网段列表。

    非法条目跳过：授权表是管理员维护的配置，其中一条写错不该让整个校验
    报 500；宁可少放行一条。
    """
    nets: List[Network] = []
    for item in entries or ():
        text = str(item or "").strip()
        if not text:
            continue
        try:
            nets.append(ipaddress.ip_network(text, strict=False))
        except ValueError:
            logger.warning("frp 授权表里有非法条目，已忽略：%s", text)
    return nets


def parse_grant(value: Any) -> str:
    """校验管理员要授权的目标（单个 IP 或网段），返回归一化字符串。

    这里挡的和运行时同一批地址：回环 / 未指定 / 链路本地 / 组播 / 保留，
    以及面板后端自身地址。授权整个 ``/0`` 也拒绝 —— 那等于关掉这道门。
    """
    text = str(value or "").strip()
    if not text:
        raise PolicyError("请填写要授权的 IP 或网段")

    if "/" in text:
        try:
            net = ipaddress.ip_network(text, strict=False)
        except ValueError as exc:
            raise PolicyError("不是合法的 IP / 网段") from exc
        if net.prefixlen == 0:
            raise PolicyError("不能把整个地址空间授权出去")
        if (
            net.is_loopback
            or net.is_link_local
            or net.is_multicast
            or net.is_reserved
            or net.is_unspecified
        ):
            raise PolicyError("不能授权回环 / 链路本地 / 组播 / 保留 / 未指定网段")
        for addr in local_addresses():
            try:
                if ipaddress.ip_address(addr) in net:
                    raise PolicyError("该网段包含面板后端自身地址，禁止授权")
            except ValueError:
                continue
        return str(net)

    addr = parse_ip(text)
    reason = _forbidden_reason(addr)
    if reason:
        raise PolicyError(f"不能授权{reason}")
    if str(addr) in local_addresses():
        raise PolicyError("不能授权面板后端自身地址")
    return str(addr)


# ------------------------------------------------- 面板网段拦截（可运行时调整）
#: 「禁止指向面板后端所在网段」的持久化键。没写过这个键时跟随环境配置
#: ``FRP_BLOCK_PANEL_SUBNET`` —— 升级部署不会悄悄改变既有行为。
BLOCK_PANEL_SUBNET_KEY = "frp.block_panel_subnet"


async def block_panel_subnet_enabled() -> bool:
    """「禁止指向面板后端所在网段」是否开启。

    管理员在内网穿透页面上调整后以库里保存的值为准（"1" / "0"）；没保存过
    就回落到环境配置 ``FRP_BLOCK_PANEL_SUBNET``。读取失败（单元测试没初始化
    数据库、库暂时不可用）同样回落 —— 这是一个可选的加严开关，不能因为它
    读不到就挂掉整个目标校验。
    """
    try:
        raw = await store.get_setting(BLOCK_PANEL_SUBNET_KEY)
    except Exception:  # noqa: BLE001 - 开关读不到就退回环境配置
        raw = None
    if raw is None or str(raw) == "":
        return bool(settings.frp_block_panel_subnet)
    return str(raw) == "1"


async def set_block_panel_subnet(enabled: bool) -> None:
    await store.set_setting(BLOCK_PANEL_SUBNET_KEY, "1" if enabled else "0")


# ------------------------------------------------------------------ 校验入口
async def check_target(
    value: Any,
    *,
    username: str,
    is_admin: bool,
    granted: Iterable[Any] = (),
) -> str:
    """校验并归一化 ``local_ip``，返回可落库的字符串。

    管理员跳过白名单（面板本来就是他的），但未指定地址仍然拒绝；普通用户走
    完整判定（顺序见模块说明），``granted`` 是管理员在「用户授权」里单独给
    这个人放行的 IP / 网段。所有失败都抛 :class:`PolicyError`。
    """
    addr = parse_ip(value)

    if addr.is_unspecified:
        raise PolicyError("目标 IP 不能是未指定地址（0.0.0.0 / ::）")

    if is_admin:
        return str(addr)

    reason = _forbidden_reason(addr)
    if reason:
        raise PolicyError(f"目标 IP 不能是{reason}", 403)

    if str(addr) in local_addresses():
        raise PolicyError("目标 IP 是面板后端自身，禁止把面板暴露到公网", 403)

    try:
        own = await own_guest_ips(username)
    except Exception as exc:  # noqa: BLE001 - 归属库 / PVE 异常时 fail-closed
        logger.warning("frp 目标校验：读取用户名下虚机 IP 失败：%s", exc)
        raise PolicyError(
            "暂时无法确认该 IP 属于你名下的虚机（读取归属记录或 PVE 失败），请稍后重试",
            403,
        ) from exc
    if str(addr) in own:
        return str(addr)

    block_panel = await block_panel_subnet_enabled()

    if _contains([*allowed_cidrs(), *grant_networks(granted)], addr):
        if block_panel and _contains(panel_networks(), addr):
            raise PolicyError(
                "目标 IP 位于面板后端自身所在网段，禁止指向"
                "（确有必要请管理员在「内网穿透」页面调整该限制）",
                403,
            )
        return str(addr)

    # 落在这里的地址既不是自己的机器，也不在放行名单里。若它恰好落在面板自己
    # 的网段，单独说一句 —— 这是最常被拿来试探的一类目标。
    if block_panel and _contains(panel_networks(), addr):
        raise PolicyError(
            "目标 IP 位于面板后端自身所在网段，禁止指向"
            "（自己名下的虚机不受此限制）",
            403,
        )

    raise PolicyError(
        "目标 IP 不在允许范围内：只能指向自己名下的虚机 / 容器 IP；"
        "如需指向其它内网地址，请让管理员在「用户授权」里放行该 IP，"
        "或把对应网段加入 FRP_ALLOW_LOCAL_CIDRS",
        403,
    )


def check_remote_port(
    value: Any,
    rules: Iterable[Dict[str, Any]],
    *,
    exclude_id: str = "",
    port_range: Optional[Tuple[int, int]] = None,
) -> int:
    """校验 ``remote_port``：区间 → 黑名单 → 与现有规则冲突。

    ``port_range`` 由路由层用 :func:`remote_port_range` 取出（管理员可调整）；
    不传时用环境配置 / 内置默认值，纯函数调用（单元测试）不必先读库。
    """
    low, high = port_range or default_port_range()
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise PolicyError("公网端口必须是数字") from exc

    if port < low or port > high:
        raise PolicyError(f"公网端口必须在 {low}–{high} 之间（当前 {port}）")
    if port in FORBIDDEN_REMOTE_PORTS:
        raise PolicyError(f"公网端口 {port} 是面板 / PVE / 常见服务的关键端口，不能占用")

    for rule in rules:
        if exclude_id and str(rule.get("id") or "") == exclude_id:
            continue
        try:
            used = int(rule.get("remote_port") or 0)
        except (TypeError, ValueError):
            continue
        if used != port:
            continue
        # 刻意不带规则名 / 归属：规则列表对普通用户是按人过滤的，日志也做过
        # 名字脱敏（见 routers/frp._visible_logs），这里报出别人的规则名等于
        # 绕过那两层隔离。端口本身在 frps 上是公开的，说「被占用」不算泄密。
        raise PolicyError(f"公网端口 {port} 已被占用，请换一个", 409)

    return port


async def policy() -> Dict[str, Any]:
    """给前端做即时校验 / 提示用的策略快照（不含任何敏感信息）。"""
    low, high = await remote_port_range()
    return {
        "remote_port_min": low,
        "remote_port_max": high,
        "forbidden_ports": sorted(FORBIDDEN_REMOTE_PORTS),
        "allow_cidrs": [str(net) for net in allowed_cidrs()],
        "block_panel_subnet": await block_panel_subnet_enabled(),
    }


def used_remote_ports(rules: Iterable[Dict[str, Any]]) -> List[int]:
    """已被占用的公网端口（前端用来预判冲突，也用于默认值挑一个空闲的）。"""
    ports: Set[int] = set()
    for rule in rules:
        try:
            ports.add(int(rule.get("remote_port") or 0))
        except (TypeError, ValueError):
            continue
    ports.discard(0)
    return sorted(ports)


def first_free_port(
    rules: Iterable[Dict[str, Any]],
    port_range: Optional[Tuple[int, int]] = None,
) -> Optional[int]:
    """区间内第一个没被占用的端口（前端「新建规则」的默认值用）。"""
    low, high = port_range or default_port_range()
    used = set(used_remote_ports(rules))
    for port in range(low, high + 1):
        if port not in used and port not in FORBIDDEN_REMOTE_PORTS:
            return port
    return None
