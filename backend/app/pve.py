"""Async Proxmox VE API client.

Wraps the PVE REST API (``/api2/json``) with API-token auth, plus an
optional ticket-auth session used exclusively for console (VNC / xterm)
proxying, because token auth is not allowed on those endpoints.

Design notes
------------
* One shared ``httpx.AsyncClient`` is kept for connection pooling.
* Proxmox always returns ``{"data": ...}``; we unwrap it.
* Errors are normalised into :class:`ProxmoxError` carrying the HTTP status
  and the human-readable message PVE provides.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from contextvars import ContextVar, Token
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlsplit

import httpx

from .config import settings

# UPID format: UPID:<node>:<pid>:<pstart>:<starttime>:<type>:<id>:<user>:<comment>
_UPID_RE = re.compile(r"^UPID:(?P<node>[^:]+):")  # 兼容旧调用：只取节点
_UPID_FULL_RE = re.compile(
    r"^UPID:(?P<node>[^:]+):(?P<pid>[^:]*):(?P<pstart>[^:]*):(?P<starttime>[^:]*):"
    r"(?P<type>[^:]*):(?P<id>[^:]*):"
)


class ProxmoxError(Exception):
    """Raised for any non-2xx response from the Proxmox API.

    ``status_code`` is the code the *panel* should answer with. Proxmox's own
    code is kept separately in ``pve_status`` because the two must not be
    confused: when a Proxmox token is rejected (401) or lacks a privilege (403),
    forwarding that code verbatim would tell the browser "your panel session is
    invalid". The frontend then clears its JWT and bounces to the login page —
    which, since the Proxmox credential is still broken, immediately loops.
    Those upstream auth failures are therefore reported as 502 (bad gateway)
    while ``pve_status`` preserves the original code for diagnostics.
    """

    def __init__(
        self,
        message: str,
        status_code: int = 500,
        endpoint: str = "",
        pve_status: Optional[int] = None,
    ):
        self.message = message
        self.status_code = status_code
        self.endpoint = endpoint
        self.pve_status = pve_status if pve_status is not None else status_code
        super().__init__(message)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "detail": self.message,
            "pve_status": self.pve_status,
            "endpoint": self.endpoint,
        }


def explain_clone_error(message: str, full: bool) -> str:
    """把 PVE 的克隆失败信息补成可操作的中文提示。

    最容易被误判的是 VMID 冲突：每台 PVE 的 VMID 空间各自独立，在 A 主机取到的
    号照搬到 B 主机可能已经被占用。PVE 只回一句 ``config file already exists``，
    如果这时还补「链接克隆失败，请改用完整克隆」，用户会朝完全错误的方向排查。
    """
    text = str(message or "")
    if "config file already exists" in text.lower():
        return (
            text
            + "（该 VMID 在目标主机上已被占用：每台 PVE 的 VMID 各自独立，"
            "换主机后请重新取号或改用其它 VMID）"
        )
    if not full:
        return text + "（链接克隆失败：请确认源磁盘所在存储支持链接克隆，或改用「完整克隆」重试）"
    return text


def node_from_upid(upid: str) -> str:
    """Extract the node name from a Proxmox UPID.

    The node is embedded in the UPID itself, so callers never need to pass it
    separately.  Returns ``""`` when the UPID cannot be parsed.
    """
    match = _UPID_RE.match(upid or "")
    return match.group("node") if match else ""


def vm_id_from_upid(upid: str) -> Optional[int]:
    """取出虚拟机任务对应的 VMID，非虚拟机任务返回 None。

    UPID 形如 ``UPID:<node>:<pid>:<pstart>:<starttime>:<type>:<id>:<user>:``。
    只有虚拟机类任务（``qmstart`` / ``qmshutdown`` / ``qmclone`` / ``qmdestroy``…）
    的 ``<id>`` 才是 VMID；``vzdump``、``aptupdate``、``startall`` 等取到的是别的东西，
    当成 VMID 用会把请求打到错误的主机。
    """
    match = _UPID_FULL_RE.match(upid or "")
    if not match:
        return None
    task_type = (match.group("type") or "").lower()
    raw_id = match.group("id") or ""
    if not task_type.startswith("qm") or not raw_id.isdigit():
        return None
    return int(raw_id)


class PveConnection:
    """Resolved connection settings (mutable at runtime from the UI)."""

    def __init__(
        self,
        host: str = "",
        port: int = 8006,
        token_id: str = "",
        token_secret: str = "",
        verify_ssl: bool = False,
        default_node: str = "",
        console_user: str = "",
        console_password: str = "",
    ) -> None:
        self.host = host
        self.port = port
        self.token_id = token_id
        self.token_secret = token_secret
        self.verify_ssl = verify_ssl
        self.default_node = default_node
        self.console_user = console_user
        self.console_password = console_password

    @property
    def base_url(self) -> str:
        """The PVE base URL, e.g. ``https://192.168.1.10:8006``.

        The host may be given bare (``pve.example.com``) or with a scheme and
        embedded port (``http://127.0.0.1:8006``, used by tests and tunnels).
        Only append the port when one is not already present — appending
        unconditionally produces garbage like ``host:8006:8006``.
        """
        host = (self.host or "").strip().rstrip("/")
        if not host:
            return ""

        if not host.startswith(("http://", "https://")):
            return f"https://{host}:{self.port}"

        parsed = urlsplit(host)
        if parsed.port:  # a port was already supplied
            return f"{parsed.scheme}://{parsed.netloc}"
        return f"{parsed.scheme}://{parsed.netloc}:{self.port}"

    @property
    def api_url(self) -> str:
        return f"{self.base_url}/api2/json"

    @property
    def configured(self) -> bool:
        return bool(self.host and self.token_id and self.token_secret)


class ProxmoxClient:
    """Thin async wrapper around the Proxmox VE REST API."""

    # ------------------------------------------------------------------ init
    def __init__(self, conn: PveConnection) -> None:
        self.conn = conn
        self._client: Optional[httpx.AsyncClient] = None
        self._lock = asyncio.Lock()
        # ticket-auth session cache for console endpoints
        self._ticket: Optional[str] = None
        self._csrf: Optional[str] = None
        self._ticket_ts: float = 0.0

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                verify=self.conn.verify_ssl,
                timeout=httpx.Timeout(settings.http_timeout, connect=10.0),
                follow_redirects=False,
                # Do not pick up HTTP_PROXY / HTTPS_PROXY: a hypervisor API is
                # a LAN endpoint, and a stray proxy env var otherwise makes
                # every request fail with an opaque 502.
                trust_env=settings.pve_trust_env,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    # --------------------------------------------------------------- request
    def _auth_headers(self, with_body: bool = False) -> Dict[str, str]:
        """鉴权头。

        PVE 的 Perl 端只要看到 ``Content-Type: application/json`` 就会去解析请求体，
        空请求体会直接报 ``malformed JSON string``，所以只有在真的会发请求体时才声明它。
        """
        headers = {
            "Authorization": (
                f"PVEAPIToken={self.conn.token_id}={self.conn.token_secret}"
            ),
        }
        if with_body:
            headers["Content-Type"] = "application/json"
        return headers

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        raw: bool = False,
    ) -> Any:
        """Perform an API call and return the unwrapped ``data`` field.

        ``path`` must start with ``/`` and be relative to ``/api2/json``.
        Set ``raw=True`` to get the full envelope instead of just ``data``.
        """
        if not self.conn.configured:
            raise ProxmoxError(
                "Proxmox connection is not configured. "
                "Open Settings and provide host + API token.",
                status_code=428,
                endpoint=f"{method} {path}",
            )

        url = f"{self.conn.api_url}{path}"
        client = await self._http()

        # Drop None values so PVE doesn't reject empty strings.
        clean_params = (
            {k: v for k, v in params.items() if v is not None} if params else None
        )
        clean_data = {k: v for k, v in data.items() if v is not None} if data else None

        # 写操作即使用不到参数也要发一个空的 JSON 对象：空请求体 + JSON 请求头
        # 会让 PVE 的 Perl 解析器报 malformed JSON（关机、回滚、转模板等都会踩到）。
        sends_body = method.upper() in ("POST", "PUT", "PATCH")
        body = clean_data
        if sends_body and body is None:
            body = {}

        try:
            resp = await client.request(
                method.upper(),
                url,
                params=clean_params,
                json=body,
                headers=self._auth_headers(with_body=body is not None),
            )
        except httpx.TimeoutException as exc:
            # TimeoutException subclasses TransportError, so it is matched
            # first and must not be reordered below.
            raise ProxmoxError(
                f"Proxmox request timed out ({method} {path})",
                status_code=504,
                endpoint=f"{method} {path}",
            ) from exc
        except httpx.ProxyError as exc:
            # Raised when an HTTP_PROXY/HTTPS_PROXY in the environment hijacks
            # the request. Point the operator at the actual cause.
            raise ProxmoxError(
                f"Cannot reach Proxmox at {self.conn.base_url}: the connection "
                f"was intercepted by a proxy ({exc}). Set PVE_TRUST_ENV=false "
                f"(the default) to ignore HTTP_PROXY/HTTPS_PROXY, or add the "
                f"Proxmox host to NO_PROXY.",
                status_code=502,
                endpoint=f"{method} {path}",
            ) from exc
        except httpx.TransportError as exc:
            # ConnectError, TLS failures, protocol errors, read errors …
            raise ProxmoxError(
                f"Cannot reach Proxmox at {self.conn.base_url}: {exc}",
                status_code=502,
                endpoint=f"{method} {path}",
            ) from exc

        if resp.status_code >= 400:
            status_code = resp.status_code
            # 401/403 来自 Proxmox 本身（Token 失效 / 权限不足），不是面板会话
            # 失效。原样透传会让前端登出并陷入「跳登录 → 再失败」的循环，
            # 因此统一按上游错误返回 502。
            if status_code in (401, 403):
                raise ProxmoxError(
                    _extract_error(resp),
                    status_code=502,
                    endpoint=f"{method} {path}",
                    pve_status=status_code,
                )
            raise ProxmoxError(
                _extract_error(resp), status_code=status_code,
                endpoint=f"{method} {path}",
            )

        try:
            payload = resp.json()
        except ValueError:
            return resp.text

        if raw:
            return payload
        return payload.get("data", payload)

    async def get(self, path: str, **kw: Any) -> Any:
        return await self.request("GET", path, **kw)

    async def post(self, path: str, **kw: Any) -> Any:
        return await self.request("POST", path, **kw)

    async def put(self, path: str, **kw: Any) -> Any:
        return await self.request("PUT", path, **kw)

    async def delete(self, path: str, **kw: Any) -> Any:
        return await self.request("DELETE", path, **kw)

    # ------------------------------------------------------- generic readers
    async def version(self) -> Dict[str, Any]:
        return await self.get("/version")

    async def nodes(self) -> List[Dict[str, Any]]:
        return await self.get("/nodes")

    async def cluster_resources(self, rtype: Optional[str] = None) -> List[Dict[str, Any]]:
        params = {"type": rtype} if rtype else None
        return await self.get("/cluster/resources", params=params)

    async def access_permissions(self) -> Dict[str, Any]:
        """Effective privileges of the current credential.

        Returns a mapping such as ``{"/": ["VM.Audit", ...]}``. An empty dict
        is meaningful: the credential has no privileges at all, which is what
        a Proxmox API token with "privilege separation" looks like before any
        ACL has been granted to it.
        """
        data = await self.get("/access/permissions")
        return data or {}

    async def nextid(self) -> int:
        value = await self.get("/cluster/nextid")
        return int(value)

    async def tasks(self, node: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
        """List recent tasks. PVE exposes tasks per-node, so we fan out."""
        if node:
            items = await self.get(f"/nodes/{node}/tasks", params={"limit": limit})
            return items or []

        result: List[Dict[str, Any]] = []
        for n in await self.nodes():
            name = n.get("node")
            if not name:
                continue
            try:
                items = await self.get(f"/nodes/{name}/tasks", params={"limit": limit})
                result.extend(items or [])
            except ProxmoxError:
                # A node may be offline; skip it rather than failing the page.
                continue
        result.sort(key=lambda t: t.get("starttime") or 0, reverse=True)
        return result[:limit]

    # --------------------------------------------------------------- tasks
    async def task_status(self, upid: str, node: Optional[str] = None) -> Dict[str, Any]:
        node = node or node_from_upid(upid)
        if not node:
            raise ProxmoxError(f"Cannot determine node from UPID: {upid}", 400)
        return await self.get(f"/nodes/{node}/tasks/{upid}/status")

    async def task_log(
        self, upid: str, node: Optional[str] = None, start: int = 0, limit: int = 500
    ) -> List[Dict[str, Any]]:
        node = node or node_from_upid(upid)
        if not node:
            raise ProxmoxError(f"Cannot determine node from UPID: {upid}", 400)
        lines = await self.get(
            f"/nodes/{node}/tasks/{upid}/log",
            params={"start": start, "limit": limit},
        )
        return lines or []

    async def wait_for_task(
        self, upid: str, node: Optional[str] = None, timeout: float = 300.0
    ) -> Dict[str, Any]:
        """Block until a task reaches a terminal state. Used by the template
        build pipeline, which must finish one step before starting the next."""
        node = node or node_from_upid(upid)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = await self.task_status(upid, node)
            if status.get("status") == "stopped":
                return status
            await asyncio.sleep(settings.task_poll_interval)
        raise ProxmoxError(
            f"Task {upid} did not finish within {timeout:.0f}s", 504
        )

    # ----------------------------------------------------------- node info
    async def node_status(self, node: str) -> Dict[str, Any]:
        return await self.get(f"/nodes/{node}/status")

    async def node_rrddata(self, node: str, timeframe: str = "hour") -> List[Dict[str, Any]]:
        data = await self.get(
            f"/nodes/{node}/rrddata", params={"timeframe": timeframe}
        )
        return data or []

    async def node_network(self, node: str) -> List[Dict[str, Any]]:
        data = await self.get(f"/nodes/{node}/network")
        return data or []

    # ------------------------------------------------------------ access acl
    async def grant_token_role(
        self,
        token_id: str,
        role: str = "PVEAdmin",
        path: str = "/",
        propagate: bool = True,
    ) -> None:
        """授予某个 API Token 一个角色（默认 PVEAdmin）。

        为什么需要这个：在 Proxmox 界面新建 Token 时「特权分离」默认勾选，
        这种 Token 的有效权限为空 —— PVE 会隐藏节点 CPU/内存/磁盘指标，并在
        特权接口上返回 403。修好它是一次 ACL 变更，而零权限的 Token 无法给
        自己授权，因此必须借用一个 Proxmox 账号密码换取票据来执行。
        """
        clean = (token_id or "").strip()
        if not clean:
            raise ProxmoxError(
                "缺少 API Token ID，无法授权", 400, "PUT /access/acl"
            )

        ticket, csrf = await self._ensure_ticket()
        client = await self._http()
        resp = await client.put(
            f"{self.conn.api_url}/access/acl",
            data={
                "path": path,
                "roles": role,
                "tokens": clean,
                "propagate": 1 if propagate else 0,
            },
            cookies={"PVEAuthCookie": ticket},
            headers={"CSRFPreventionToken": csrf},
        )
        if resp.status_code >= 400:
            raise ProxmoxError(
                _extract_error(resp), resp.status_code, "PUT /access/acl"
            )

    # -------------------------------------------------------------- storage
    async def storages(self, node: Optional[str] = None) -> List[Dict[str, Any]]:
        if node:
            data = await self.get(f"/nodes/{node}/storage")
            for item in data or []:
                item.setdefault("node", node)
            return data or []
        data = await self.get("/storage")
        return data or []

    async def storage_content(
        self,
        node: str,
        storage: str,
        content: Optional[str] = None,
        vmid: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        params: Dict[str, Any] = {}
        if content:
            params["content"] = content
        if vmid:
            params["vmid"] = vmid
        data = await self.get(
            f"/nodes/{node}/storage/{storage}/content", params=params
        )
        return data or []

    async def storage_content_set_protected(
        self, node: str, storage: str, volume: str, protected: bool = True
    ) -> None:
        """给备份卷打 / 解除 ``protected`` 旗标。

        **这不是 WORM**：它只是拦住 PVE 自己的 prune 与常规删除，root 与存储后端
        仍然能清掉。真正的不可变需要 PBS 的 retention/immutability 或 S3 Object
        Lock 这类存储侧能力。旧版本 PVE 可能不支持该字段，调用方要容忍失败。
        """
        await self.put(
            f"/nodes/{node}/storage/{storage}/content/{volume}",
            data={"protected": 1 if protected else 0},
        )

    # ---------------------------------------------------------------- qemu
    async def qemu_list(self, node: str) -> List[Dict[str, Any]]:
        data = await self.get(f"/nodes/{node}/qemu")
        return data or []

    async def qemu_all(self) -> List[Dict[str, Any]]:
        """All QEMU VMs across every node, enriched from cluster resources."""
        resources = await self.cluster_resources("vm")
        return [r for r in resources if r.get("type") == "qemu"]

    async def qemu_config(self, node: str, vmid: int) -> Dict[str, Any]:
        return await self.get(f"/nodes/{node}/qemu/{vmid}/config")

    async def qemu_status(self, node: str, vmid: int) -> Dict[str, Any]:
        return await self.get(f"/nodes/{node}/qemu/{vmid}/status/current")

    async def qemu_pending(self, node: str, vmid: int) -> List[Dict[str, Any]]:
        data = await self.get(f"/nodes/{node}/qemu/{vmid}/pending")
        return data or []

    async def qemu_vm_rrddata(
        self, node: str, vmid: int, timeframe: str = "hour"
    ) -> List[Dict[str, Any]]:
        data = await self.get(
            f"/nodes/{node}/qemu/{vmid}/rrddata", params={"timeframe": timeframe}
        )
        return data or []

    async def qemu_set_config(
        self, node: str, vmid: int, config: Dict[str, Any]
    ) -> Any:
        return await self.post(f"/nodes/{node}/qemu/{vmid}/config", data=config)

    async def qemu_create(self, node: str, config: Dict[str, Any]) -> Any:
        return await self.post(f"/nodes/{node}/qemu", data=config)

    async def qemu_destroy(self, node: str, vmid: int, purge: bool = True) -> Any:
        return await self.delete(
            f"/nodes/{node}/qemu/{vmid}", params={"purge": 1 if purge else 0}
        )

    async def qemu_clone(
        self,
        node: str,
        vmid: int,
        newid: int,
        name: Optional[str] = None,
        full: bool = True,
        target_storage: Optional[str] = None,
        target_node: Optional[str] = None,
        description: Optional[str] = None,
    ) -> Any:
        payload: Dict[str, Any] = {"newid": newid, "full": 1 if full else 0}
        if name:
            payload["name"] = name
        # PVE rejects ``storage`` for linked clones (full=0): linked clones reuse
        # the template's disk, so a target storage is meaningless and errors with
        # "parameter 'storage' not allowed for linked clones".
        if target_storage and full:
            payload["storage"] = target_storage
        if target_node:
            payload["target"] = target_node
        if description:
            payload["description"] = description
        return await self.post(f"/nodes/{node}/qemu/{vmid}/clone", data=payload)

    async def qemu_to_template(self, node: str, vmid: int) -> Any:
        return await self.post(f"/nodes/{node}/qemu/{vmid}/template")

    async def qemu_importdisk(
        self, node: str, vmid: int, image_path: str, storage: str
    ) -> Any:
        """Import a disk image into a VM. Requires the file to be reachable
        from the node (normally inside an ISO/content storage)."""
        return await self.post(
            f"/nodes/{node}/qemu/{vmid}/importdisk",
            data={"filename": image_path, "storage": storage},
        )

    async def qemu_resize(self, node: str, vmid: int, disk: str, size: str) -> Any:
        return await self.put(
            f"/nodes/{node}/qemu/{vmid}/resize", data={"disk": disk, "size": size}
        )

    async def qemu_move_disk(
        self, node: str, vmid: int, disk: str, storage: str, delete_source: bool = True
    ) -> Any:
        return await self.post(
            f"/nodes/{node}/qemu/{vmid}/move_disk",
            data={
                "disk": disk,
                "storage": storage,
                "delete": 1 if delete_source else 0,
            },
        )

    async def qemu_migrate(
        self, node: str, vmid: int, target_node: str, online: bool = True
    ) -> Any:
        return await self.post(
            f"/nodes/{node}/qemu/{vmid}/migrate",
            data={"target": target_node, "online": 1 if online else 0},
        )

    # ------------------------------------------------------------ power ops
    async def qemu_power(
        self,
        node: str,
        vmid: int,
        action: str,
        timeout: Optional[int] = None,
        force_stop: bool = False,
    ) -> Any:
        """``action`` in {start, stop, shutdown, reboot, suspend, resume}."""
        payload: Dict[str, Any] = {}
        if timeout is not None:
            payload["timeout"] = timeout
        if action == "shutdown" and force_stop:
            payload["forceStop"] = 1
        return await self.post(
            f"/nodes/{node}/qemu/{vmid}/status/{action}", data=payload
        )

    # ------------------------------------------------------------- snapshots
    async def qemu_snapshots(self, node: str, vmid: int) -> List[Dict[str, Any]]:
        data = await self.get(f"/nodes/{node}/qemu/{vmid}/snapshot")
        return data or []

    async def qemu_snapshot_create(
        self, node: str, vmid: int, name: str, description: str = "", vmstate: bool = False
    ) -> Any:
        return await self.post(
            f"/nodes/{node}/qemu/{vmid}/snapshot",
            data={
                "snapname": name,
                "description": description,
                "vmstate": 1 if vmstate else 0,
            },
        )

    async def qemu_snapshot_rollback(self, node: str, vmid: int, name: str) -> Any:
        return await self.post(f"/nodes/{node}/qemu/{vmid}/snapshot/{name}/rollback")

    async def qemu_snapshot_delete(self, node: str, vmid: int, name: str) -> Any:
        return await self.delete(f"/nodes/{node}/qemu/{vmid}/snapshot/{name}")

    # ------------------------------------------------------------ cloud-init
    async def qemu_cloudinit(self, node: str, vmid: int) -> Dict[str, Any]:
        return await self.get(f"/nodes/{node}/qemu/{vmid}/cloudinit")

    async def qemu_cloudinit_regen(self, node: str, vmid: int) -> Any:
        """重新生成 config drive（GUI 上的「Regenerate Image」）。

        **这是改 cloud-init 口令时必须的一步**：PVE 每次生成都会换一个
        ``instance-id``（见 ``/cloudinit/dump?type=meta``），而 cloud-init 只在
        看到新 instance-id 时才重跑 per-instance 模块。只改 ``cipassword`` 不重新
        生成，重启后口令不会变 —— 这正是「改了 cloud-init 密码但登不进去」的常见
        原因。
        """
        return await self.put(f"/nodes/{node}/qemu/{vmid}/cloudinit")

    # ------------------------------------------------------- agent (optional)
    async def qemu_agent_network(self, node: str, vmid: int) -> List[Dict[str, Any]]:
        data = await self.get(f"/nodes/{node}/qemu/{vmid}/agent/network-get-interfaces")
        return data or []

    async def qemu_agent_ping(self, node: str, vmid: int) -> Dict[str, Any]:
        data = await self.post(f"/nodes/{node}/qemu/{vmid}/agent/ping")
        return data or {}

    async def qemu_agent_set_password(
        self, node: str, vmid: int, username: str, password: str
    ) -> Any:
        """让客户机内的 agent 直接把某个用户的口令改掉（``guest-set-user-password``）。

        即时生效、不用重启，但要求 agent 以 root 身份运行、且 agent 足够新；
        老版本 agent 会回 ``child process has failed to set user password``，
        调用方应退回在客户机里执行 ``chpasswd``（见 :mod:`app.guestpasswd`）。

        参数名是 ``username`` / ``password``（PVE 自己的下划线拼法），且 PVE 侧
        要求口令至少 5 位 —— 不足会被 PVE 直接拒掉，根本到不了客户机。
        """
        return await self.post(
            f"/nodes/{node}/qemu/{vmid}/agent/set-user-password",
            data={"username": username, "password": password},
        )

    async def qemu_agent_exec(
        self,
        node: str,
        vmid: int,
        command: List[str],
    ) -> Dict[str, Any]:
        """在客户机内执行命令，返回 ``{"pid": ...}``。

        ``command`` 是整个 argv（PVE 接受数组形式，第一项是程序路径）。

        **不要传 ``capture-output``**：PVE 8.4 的 schema 不接受这个属性，
        带上它请求会被直接拒掉：``capture-output: property is not defined in
        schema``。输出是默认捕获的，不需要显式要求。
        """
        data = await self.post(
            f"/nodes/{node}/qemu/{vmid}/agent/exec",
            data={"command": command},
        )
        return data or {}

    async def qemu_agent_exec_status(
        self, node: str, vmid: int, pid: Any
    ) -> Dict[str, Any]:
        """取回在客户机内执行的结果。

        **这是 GET 接口**：PVE 对 ``POST .../agent/exec-status`` 会回
        ``Method ... not implemented``。返回体形如
        ``{"exited": 1, "exitcode": 0, "out-data": "...", "err-data": "..."}``，
        其中 ``out-data`` 实测是**明文**（见 :func:`formatters.decode_agent_output`）。
        """
        data = await self.get(
            f"/nodes/{node}/qemu/{vmid}/agent/exec-status", params={"pid": pid}
        )
        return data or {}

    async def qemu_agent_file_open(
        self, node: str, vmid: int, path: str, mode: str = "wb"
    ) -> Any:
        data = await self.post(
            f"/nodes/{node}/qemu/{vmid}/agent/file-open",
            data={"file": path, "mode": mode},
        )
        return (data or {}).get("handle")

    async def qemu_agent_file_write(
        self, node: str, vmid: int, handle: Any, buf: str
    ) -> Any:
        """写入 base64 编码的 ``buf``。"""
        return await self.post(
            f"/nodes/{node}/qemu/{vmid}/agent/file-write",
            data={"handle": handle, "buf": buf},
        )

    async def qemu_agent_file_close(self, node: str, vmid: int, handle: Any) -> None:
        await self.post(
            f"/nodes/{node}/qemu/{vmid}/agent/file-close", data={"handle": handle}
        )

    # ------------------------------------------------------------------ lxc
    # 容器与虚拟机的 API 形状大体一致（config / status / snapshot / migrate …），
    # 但有几处本质差别，别照抄 qemu：
    #   * 系统盘叫 rootfs，取值是「存储:GiB」（local-lvm:8），不是 volid；
    #   * 没有 cloud-init，初始化靠 password + ssh-public-keys；
    #   * 快照没有 vmstate；
    #   * 克隆只能全量（PVE 不支持容器的链接克隆）。
    async def lxc_list(self, node: str) -> List[Dict[str, Any]]:
        data = await self.get(f"/nodes/{node}/lxc")
        return data or []

    async def lxc_all(self) -> List[Dict[str, Any]]:
        """All containers across every node, enriched from cluster resources."""
        resources = await self.cluster_resources("vm")
        return [r for r in resources if r.get("type") == "lxc"]

    async def lxc_config(self, node: str, vmid: int) -> Dict[str, Any]:
        return await self.get(f"/nodes/{node}/lxc/{vmid}/config")

    async def lxc_status(self, node: str, vmid: int) -> Dict[str, Any]:
        return await self.get(f"/nodes/{node}/lxc/{vmid}/status/current")

    async def lxc_pending(self, node: str, vmid: int) -> List[Dict[str, Any]]:
        data = await self.get(f"/nodes/{node}/lxc/{vmid}/pending")
        return data or []

    async def lxc_vm_rrddata(
        self, node: str, vmid: int, timeframe: str = "hour"
    ) -> List[Dict[str, Any]]:
        data = await self.get(
            f"/nodes/{node}/lxc/{vmid}/rrddata", params={"timeframe": timeframe}
        )
        return data or []

    async def lxc_set_config(
        self, node: str, vmid: int, config: Dict[str, Any]
    ) -> Any:
        return await self.post(f"/nodes/{node}/lxc/{vmid}/config", data=config)

    async def lxc_create(self, node: str, config: Dict[str, Any]) -> Any:
        return await self.post(f"/nodes/{node}/lxc", data=config)

    async def lxc_destroy(
        self, node: str, vmid: int, purge: bool = True, force: bool = False
    ) -> Any:
        payload: Dict[str, Any] = {"purge": 1 if purge else 0}
        if force:
            payload["force"] = 1
        return await self.delete(f"/nodes/{node}/lxc/{vmid}", params=payload)

    async def lxc_to_template(self, node: str, vmid: int) -> Any:
        """容器转模板，等价于 ``pct template <vmid>``（见 pct(1)）。

        这个端点与 qemu 的一样**没有列在 PVE 的 API 索引里**，用索引探测会误判
        成「不存在」—— 面板以前就是这么断定容器不能转模板的，而 pct(1) 里
        明明白白有这条命令。
        """
        return await self.post(f"/nodes/{node}/lxc/{vmid}/template")

    async def lxc_clone(
        self,
        node: str,
        vmid: int,
        newid: int,
        hostname: Optional[str] = None,
        target_storage: Optional[str] = None,
        target_node: Optional[str] = None,
        description: Optional[str] = None,
    ) -> Any:
        """容器克隆只有全量一种（PVE 不支持容器的链接克隆），因此不发 ``full``。"""
        payload: Dict[str, Any] = {"newid": newid}
        if hostname:
            payload["hostname"] = hostname
        if target_storage:
            payload["storage"] = target_storage
        if target_node:
            payload["target"] = target_node
        if description:
            payload["description"] = description
        return await self.post(f"/nodes/{node}/lxc/{vmid}/clone", data=payload)

    async def lxc_power(
        self,
        node: str,
        vmid: int,
        action: str,
        timeout: Optional[int] = None,
        force_stop: bool = False,
    ) -> Any:
        """``action`` in {start, stop, shutdown, reboot, suspend, resume}."""
        payload: Dict[str, Any] = {}
        if timeout is not None:
            payload["timeout"] = timeout
        if action == "shutdown" and force_stop:
            payload["forceStop"] = 1
        return await self.post(
            f"/nodes/{node}/lxc/{vmid}/status/{action}", data=payload
        )

    async def lxc_snapshots(self, node: str, vmid: int) -> List[Dict[str, Any]]:
        data = await self.get(f"/nodes/{node}/lxc/{vmid}/snapshot")
        return data or []

    async def lxc_snapshot_create(
        self, node: str, vmid: int, name: str, description: str = ""
    ) -> Any:
        """容器快照**没有 vmstate**（不支持内存状态），所以只发 snapname。"""
        payload: Dict[str, Any] = {"snapname": name}
        if description:
            payload["description"] = description
        return await self.post(
            f"/nodes/{node}/lxc/{vmid}/snapshot", data=payload
        )

    async def lxc_snapshot_rollback(self, node: str, vmid: int, name: str) -> Any:
        return await self.post(f"/nodes/{node}/lxc/{vmid}/snapshot/{name}/rollback")

    async def lxc_snapshot_delete(self, node: str, vmid: int, name: str) -> Any:
        return await self.delete(f"/nodes/{node}/lxc/{vmid}/snapshot/{name}")

    async def lxc_resize(self, node: str, vmid: int, disk: str, size: str) -> Any:
        """扩容 rootfs / mpN。``size`` 支持绝对值（20G）与增量（+10G）。"""
        return await self.put(
            f"/nodes/{node}/lxc/{vmid}/resize", data={"disk": disk, "size": size}
        )

    async def lxc_move_volume(
        self, node: str, vmid: int, volume: str, storage: str, delete_source: bool = True
    ) -> Any:
        return await self.post(
            f"/nodes/{node}/lxc/{vmid}/move_volume",
            data={
                "volume": volume,
                "storage": storage,
                "delete": 1 if delete_source else 0,
            },
        )

    async def lxc_migrate(
        self,
        node: str,
        vmid: int,
        target_node: str,
        online: bool = True,
        restart: bool = False,
    ) -> Any:
        return await self.post(
            f"/nodes/{node}/lxc/{vmid}/migrate",
            data={
                "target": target_node,
                "online": 1 if online else 0,
                "restart": 1 if restart else 0,
            },
        )

    async def lxc_vncproxy(self, node: str, vmid: int) -> Dict[str, Any]:
        """容器的控制台本质上是 tty，PVE 同样把它包成 vncwebsocket。

        只发 ``websocket``：PVE 的 **lxc** vncproxy 没有 ``generate-password``
        这个参数（那是 qemu vncproxy 才有的 —— 虚拟机的 VNC 服务确有口令），
        多传一个未知参数会被 schema 校验整条打回，报的正是：

            generate-password: property is not defined in schema
            and the schema does not allow additional properties

        认证走的仍是 VncAuth，而**口令就是返回的 ticket**（PVE 把它交给
        vncterm 的 `-d <password>`），所以响应里没有 password 字段 ——
        客户端从 URL 拿到的 vncticket 就是口令本身。见
        routers/console.py 里 create_lxc_vnc_session 的处理。
        """
        ticket, csrf = await self._ensure_ticket()
        client = await self._http()
        resp = await client.post(
            f"{self.conn.api_url}/nodes/{node}/lxc/{vmid}/vncproxy",
            data={"websocket": 1},
            cookies={"PVEAuthCookie": ticket},
            headers={"CSRFPreventionToken": csrf},
        )
        if resp.status_code >= 400:
            raise ProxmoxError(
                _extract_error(resp), resp.status_code,
                f"POST /nodes/{node}/lxc/{vmid}/vncproxy",
            )
        data = resp.json().get("data") or {}
        data.update({"node": node, "vmid": vmid})
        return data

    async def lxc_termproxy(self, node: str, vmid: int) -> Dict[str, Any]:
        ticket, csrf = await self._ensure_ticket()
        client = await self._http()
        resp = await client.post(
            f"{self.conn.api_url}/nodes/{node}/lxc/{vmid}/termproxy",
            data={},
            cookies={"PVEAuthCookie": ticket},
            headers={"CSRFPreventionToken": csrf},
        )
        if resp.status_code >= 400:
            raise ProxmoxError(
                _extract_error(resp), resp.status_code,
                f"POST /nodes/{node}/lxc/{vmid}/termproxy",
            )
        data = resp.json().get("data") or {}
        data.update({"node": node, "vmid": vmid})
        return data

    # ---------------------------------------------------------------- backup
    async def backup_create(
        self,
        node: str,
        vmid: Optional[int],
        storage: str,
        mode: str = "snapshot",
        compress: str = "zstd",
        notes: Optional[str] = None,
        all_guests: bool = False,
    ) -> Any:
        payload: Dict[str, Any] = {
            "storage": storage,
            "mode": mode,
            "compress": compress,
        }
        if all_guests:
            payload["all"] = 1
        elif vmid is not None:
            payload["vmid"] = vmid
        if notes:
            payload["notes-template"] = notes
        return await self.post(f"/nodes/{node}/vzdump", data=payload)

    async def backup_restore(
        self,
        node: str,
        archive: str,
        vmid: int,
        storage: Optional[str] = None,
        force: bool = True,
        start: bool = False,
    ) -> Any:
        payload: Dict[str, Any] = {
            "archive": archive,
            "vmid": vmid,
            "force": 1 if force else 0,
            "start": 1 if start else 0,
        }
        if storage:
            payload["storage"] = storage
        return await self.post(f"/nodes/{node}/qemu", data=payload)

    async def backup_jobs(self) -> List[Dict[str, Any]]:
        data = await self.get("/cluster/backup")
        return data or []

    async def backup_job_create(self, payload: Dict[str, Any]) -> Any:
        return await self.post("/cluster/backup", data=payload)

    async def backup_job_update(self, job_id: str, payload: Dict[str, Any]) -> Any:
        return await self.put(f"/cluster/backup/{job_id}", data=payload)

    async def backup_job_delete(self, job_id: str) -> Any:
        return await self.delete(f"/cluster/backup/{job_id}")

    # ------------------------------------------------------------ networking
    async def network_create(self, node: str, payload: Dict[str, Any]) -> Any:
        return await self.post(f"/nodes/{node}/network", data=payload)

    async def network_update(self, node: str, iface: str, payload: Dict[str, Any]) -> Any:
        return await self.put(f"/nodes/{node}/network/{iface}", data=payload)

    async def network_delete(self, node: str, iface: str) -> Any:
        return await self.delete(f"/nodes/{node}/network/{iface}")

    async def network_reload(self, node: str) -> Any:
        return await self.put(f"/nodes/{node}/network")

    async def network_revert(self, node: str) -> Any:
        return await self.delete(f"/nodes/{node}/network")

    # ------------------------------------------------------------------ pools
    async def pools(self) -> List[Dict[str, Any]]:
        data = await self.get("/pools")
        return data or []

    # ============================================================== console
    # Token auth is explicitly rejected on vncproxy / xtermproxy, so we keep a
    # separate password-authenticated ticket session for these calls only.
    async def _ensure_ticket(self) -> Tuple[str, str]:
        if self._ticket and (time.time() - self._ticket_ts) < 3600:
            return self._ticket, self._csrf or ""

        if not self.conn.console_user or not self.conn.console_password:
            raise ProxmoxError(
                "Console access requires a Proxmox account (username + password) "
                "in Settings. API tokens cannot open VNC consoles.",
                status_code=428,
                endpoint="POST /access/ticket",
            )

        client = await self._http()
        resp = await client.post(
            f"{self.conn.api_url}/access/ticket",
            data={
                "username": self.conn.console_user,
                "password": self.conn.console_password,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if resp.status_code >= 400:
            raise ProxmoxError(
                f"Console login failed: {_extract_error(resp)}",
                status_code=resp.status_code,
                endpoint="POST /access/ticket",
            )
        payload = resp.json().get("data") or {}
        self._ticket = payload.get("ticket")
        self._csrf = payload.get("CSRFPreventionToken")
        self._ticket_ts = time.time()
        if not self._ticket:
            raise ProxmoxError("Console login returned no ticket", 502)
        return self._ticket, self._csrf or ""

    async def vncproxy(self, node: str, vmid: int) -> Dict[str, Any]:
        """Create a VNC proxy session. Returns ticket/port/cert/password."""
        ticket, csrf = await self._ensure_ticket()
        client = await self._http()
        resp = await client.post(
            f"{self.conn.api_url}/nodes/{node}/qemu/{vmid}/vncproxy",
            data={"websocket": 1, "generate-password": 1},
            cookies={"PVEAuthCookie": ticket},
            headers={"CSRFPreventionToken": csrf},
        )
        if resp.status_code >= 400:
            raise ProxmoxError(
                _extract_error(resp), resp.status_code,
                f"POST /nodes/{node}/qemu/{vmid}/vncproxy",
            )
        data = resp.json().get("data") or {}
        data.update({"node": node, "vmid": vmid})
        return data

    async def xtermproxy(self, node: str, vmid: int) -> Dict[str, Any]:
        """Create a serial-console (xterm.js) proxy session."""
        ticket, csrf = await self._ensure_ticket()
        client = await self._http()
        resp = await client.post(
            f"{self.conn.api_url}/nodes/{node}/qemu/{vmid}/termproxy",
            data={"serial": "serial0"},
            cookies={"PVEAuthCookie": ticket},
            headers={"CSRFPreventionToken": csrf},
        )
        if resp.status_code >= 400:
            raise ProxmoxError(
                _extract_error(resp), resp.status_code,
                f"POST /nodes/{node}/qemu/{vmid}/termproxy",
            )
        data = resp.json().get("data") or {}
        data.update({"node": node, "vmid": vmid})
        return data

    async def console_ws_headers(self) -> Tuple[Dict[str, str], Dict[str, str]]:
        """Headers/cookies needed to open a console WebSocket upstream."""
        ticket, _ = await self._ensure_ticket()
        return {"Cookie": f"PVEAuthCookie={ticket}"}, {"PVEAuthCookie": ticket}

    def console_ws_url(
        self,
        node: str,
        vmid: int,
        kind: str,
        port: int,
        vncticket: str,
        guest: str = "qemu",
    ) -> str:
        scheme = "wss" if self.conn.base_url.startswith("https") else "ws"
        host = self.conn.base_url.split("://", 1)[-1]
        from urllib.parse import quote

        # termproxy（串口）与 vncproxy 返回的 ticket 同为
        # assemble_vnc_ticket(user, authpath, port)，所以两种控制台的
        # WebSocket 都升级到 vncwebsocket —— PVE 源码中不存在
        # termwebsocket，用它会得到 HTTP 501。
        # 容器走 /lxc/{vmid}/vncwebsocket，与 qemu 只是路径不同。
        _ = kind
        family = "lxc" if guest == "lxc" else "qemu"
        path = f"/api2/json/nodes/{node}/{family}/{vmid}/vncwebsocket"
        query = f"port={port}&vncticket={quote(vncticket, safe='')}"
        return f"{scheme}://{host}{path}?{query}"


def _auth_hint(status: int) -> str:
    """把 Proxmox 的空 body 鉴权失败翻译成可定位的中文提示。"""
    if status == 401:
        return (
            "Proxmox 拒绝了该 API Token（401）：令牌可能已被删除，"
            "或 Token Secret 不正确/已重置。请在「设置 → 连接配置」中核对。"
        )
    if status == 403:
        return (
            "该 API Token 权限不足（403）：请在 Proxmox 中为令牌授予相应角色，"
            "或使用连接卡片上的「修复权限」。"
        )
    return f"HTTP {status}"


def _extract_error(resp: httpx.Response) -> str:
    """Pull a readable message out of a Proxmox error response."""
    try:
        body = resp.json()
    except ValueError:
        text = (resp.text or "").strip()
        if text:
            return text[:500]
        return _auth_hint(resp.status_code)

    errors = body.get("errors")
    if isinstance(errors, dict) and errors:
        parts = [f"{k}: {v}" for k, v in errors.items()]
        return "; ".join(parts)

    for key in ("message", "detail", "error"):
        value = body.get(key)
        if isinstance(value, str) and value:
            return value

    fallback = str(body)[:500]
    if fallback and fallback not in ("{}", "{'data': None}", "None"):
        return fallback
    return _auth_hint(resp.status_code)


# --------------------------------------------------------------------------
# Shared client registry — one client per resolved connection config.
# --------------------------------------------------------------------------
_client: Optional[ProxmoxClient] = None

# Fingerprint of the stored config the live client was built from, plus the
# time we last checked. The connection settings are shared state (database) but
# the resolved client is per-process, so with more than one worker or instance
# a settings change made through one process would otherwise leave the others
# talking to the old Proxmox host until restarted.
_config_revision: str = ""
_revision_checked_at: float = 0.0

# How long a process may trust its cached revision before re-reading the store.
# The settings table is a few hundred bytes, so this is far cheaper than the
# confusion of a stale client.
_REVISION_TTL_SECONDS = 3.0


# --------------------------------------------------------------------------
# Per-request target connection.
#
# The panel manages several Proxmox hosts and normally acts on the "active"
# one. Some operations are deliberately aimed at *another* host — the create-VM
# wizard lets the operator pick the target host — so those requests carry an
# ``X-PVE-Connection`` header. A context variable carries the choice down to
# :func:`get_client`, which keeps every endpoint free of an extra parameter and
# guarantees the choice never leaks into an unrelated request.
# --------------------------------------------------------------------------
_request_connection: ContextVar[str] = ContextVar("pve_request_connection", default="")

# Clients for non-active connections, keyed by connection id. Each entry stores
# a fingerprint of the profile it was built from, so an edited profile is picked
# up on the next request without a restart.
_scoped_clients: Dict[str, Tuple[str, ProxmoxClient]] = {}


def set_request_connection(conn_id: str) -> Token:
    """Scope the current request to a saved connection（空串 = 当前连接）。"""
    return _request_connection.set((conn_id or "").strip())


def reset_request_connection(token: Token) -> None:
    try:
        _request_connection.reset(token)
    except ValueError:
        # Token was created in another context; nothing to restore.
        pass


def connection_from_profile(profile: Dict[str, Any]) -> PveConnection:
    """Build a :class:`PveConnection` from a stored connection profile."""
    return PveConnection(
        host=str(profile.get("host") or ""),
        port=int(profile.get("port") or 8006),
        token_id=str(profile.get("token_id") or ""),
        token_secret=str(profile.get("token_secret") or ""),
        # 未存过 verify_ssl 的旧连接：按环境默认（生产默认校验证书）
        verify_ssl=bool(profile.get("verify_ssl", settings.pve_verify_ssl)),
        default_node=str(profile.get("node_default") or ""),
        console_user=str(profile.get("console_user") or ""),
        console_password=str(profile.get("console_password") or ""),
    )


def clear_connection_clients() -> None:
    """Drop cached clients for non-active connections (after a config change)."""
    global _scoped_clients
    stale = [client for _, client in _scoped_clients.values()]
    _scoped_clients = {}
    if not stale:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    for client in stale:
        loop.create_task(_close_later(client, 5.0))


def _active_connection_id() -> str:
    try:
        from .store import get_active_connection_id

        return str(get_active_connection_id() or "")
    except Exception:  # noqa: BLE001 - never break request handling
        return ""


def _scoped_client(conn_id: str) -> Optional[ProxmoxClient]:
    """Return (and cache) a client for a saved, non-active connection."""
    try:
        from .store import get_connections

        conns = get_connections()
    except Exception:  # noqa: BLE001 - store problems must not break requests
        return None

    profile = next((c for c in conns if str(c.get("id")) == conn_id), None)
    if profile is None:
        return None

    fingerprint = hashlib.sha256(
        json.dumps(profile, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:16]

    cached = _scoped_clients.get(conn_id)
    if cached is not None and cached[0] == fingerprint:
        return cached[1]

    client = ProxmoxClient(connection_from_profile(profile))
    _scoped_clients[conn_id] = (fingerprint, client)
    if cached is not None:
        try:
            asyncio.get_running_loop().create_task(_close_later(cached[1], 5.0))
        except RuntimeError:
            pass
    return client


def requested_connection() -> str:
    """本次请求通过 X-PVE-Connection 指定的连接 id（空串 = 未指定）。"""
    return _request_connection.get()


def client_for_connection(conn_id: str) -> ProxmoxClient:
    """按连接 id 取客户端；空串表示「当前连接」。

    批量操作里每一台目标机器可能落在不同 PVE 上，靠 ``set_request_connection``
    切换 ContextVar 是行不通的 —— 并发任务共享同一个请求上下文，会互相覆盖。
    这里直接按 id 取客户端（带指纹缓存），各台机器的连接互不干扰。
    """
    if not conn_id:
        return get_client()
    client = _scoped_client(conn_id)
    if client is None:
        raise ProxmoxError(
            f"目标 PVE 连接不存在或已被删除（id={conn_id}）",
            status_code=404,
            endpoint="client_for_connection",
        )
    return client


def all_connection_clients() -> List[Tuple[Dict[str, Any], ProxmoxClient]]:
    """每一条已保存连接对应的客户端。

    用于「多台 PVE 同时在线」的只读聚合：调用方逐条取数，其中一条失败只影响
    它自己，不会波及其它主机。
    """
    try:
        from .store import get_connections

        conns = get_connections()
    except Exception:  # noqa: BLE001 - 存储异常不应让只读接口整体失败
        return []

    result: List[Tuple[Dict[str, Any], ProxmoxClient]] = []
    for profile in conns:
        cid = str(profile.get("id") or "")
        if not cid:
            continue
        client = _scoped_client(cid)
        if client is not None:
            result.append((profile, client))
    return result


def connection_label(profile: Dict[str, Any]) -> str:
    """连接的展示名：优先自定义名称，否则用主机地址。"""
    return str(profile.get("name") or profile.get("host") or "")


def _stored_revision() -> str:
    """A cheap fingerprint of the persisted connection config."""
    try:
        from .store import get_connection_config

        cfg = get_connection_config()
    except Exception:  # noqa: BLE001 - never break request handling
        return _config_revision

    if not cfg:
        return ""
    blob = json.dumps(cfg, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


async def _close_later(client: ProxmoxClient, delay: float = 30.0) -> None:
    """Close a superseded client once in-flight requests have certainly drained.

    Closing immediately would abort requests still using it.
    """
    await asyncio.sleep(delay)
    try:
        await client.aclose()
    except Exception:  # noqa: BLE001
        pass


def get_client() -> ProxmoxClient:
    """Return the client for the active — or request-scoped — connection.

    A request may pin itself to another saved Proxmox host by sending the
    ``X-PVE-Connection`` header; when it does, the client for that connection is
    returned instead of the shared one. Otherwise this behaves as before and
    rebuilds the process-wide client whenever the config changed.

    The revision is re-read from the store at most once per
    ``_REVISION_TTL_SECONDS`` so that a settings change made through another
    worker (or another panel instance on the same database) takes effect here
    too, without a restart and without a database read per request.
    """
    global _client, _config_revision, _revision_checked_at

    scoped = _request_connection.get()
    if scoped and scoped != _active_connection_id():
        scoped_client = _scoped_client(scoped)
        if scoped_client is None:
            raise ProxmoxError(
                f"目标 PVE 连接不存在或已被删除（id={scoped}）",
                status_code=404,
                endpoint="get_client",
            )
        return scoped_client

    now = time.monotonic()
    if _client is not None and (now - _revision_checked_at) < _REVISION_TTL_SECONDS:
        return _client

    _revision_checked_at = now
    revision = _stored_revision()

    if _client is None:
        _config_revision = revision
        _client = ProxmoxClient(_load_connection())
        return _client

    if revision != _config_revision:
        previous = _client
        _config_revision = revision
        _client = ProxmoxClient(_load_connection())
        try:
            asyncio.get_running_loop().create_task(_close_later(previous))
        except RuntimeError:
            # Called outside a running loop (e.g. from sync setup code).
            pass

    return _client


def rebuild_client(conn: Optional[PveConnection] = None) -> ProxmoxClient:
    """Replace the global client (called when settings change)."""
    global _client, _config_revision, _revision_checked_at
    _client = ProxmoxClient(conn or _load_connection())
    _config_revision = _stored_revision()
    _revision_checked_at = time.monotonic()
    clear_connection_clients()
    return _client


def _load_connection() -> PveConnection:
    """Load connection config from the local store, falling back to env."""
    try:
        from .store import get_connection_config

        cfg = get_connection_config()
    except Exception:
        cfg = {}

    return PveConnection(
        host=cfg.get("host") or settings.pve_host,
        port=int(cfg.get("port") or settings.pve_port),
        token_id=cfg.get("token_id") or settings.pve_token_id,
        token_secret=cfg.get("token_secret") or settings.pve_token_secret,
        verify_ssl=bool(cfg.get("verify_ssl", settings.pve_verify_ssl)),
        default_node=cfg.get("node_default") or settings.pve_default_node,
        console_user=cfg.get("console_user") or settings.pve_console_user,
        console_password=cfg.get("console_password") or settings.pve_console_password,
    )


async def parallel(coros: Iterable[Any], limit: int = 8) -> List[Any]:
    """Run awaitables concurrently with a concurrency cap.

    Used for fan-out reads such as "list snapshots across all VMs" where a
    serial loop against a large cluster would be unacceptably slow.
    """
    semaphore = asyncio.Semaphore(limit)

    async def _run(coro: Any) -> Any:
        async with semaphore:
            try:
                return await coro
            except Exception as exc:  # noqa: BLE001 - degrade gracefully
                return exc

    return list(await asyncio.gather(*(_run(c) for c in coros)))
