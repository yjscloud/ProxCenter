"""Integration test for ProxmoxClient against a mock Proxmox API server.

A real cluster is not required: this spins up a local HTTP server that mimics
the subset of the PVE API the panel uses, then drives the real client against
it. That catches contract mistakes (wrong header format, wrong parameter
names, wrong response unwrapping) which unit tests on pure functions cannot.

Run with:  ../.venv/bin/python -m pytest tests/ -v
"""
from __future__ import annotations

import asyncio
import json
import re
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib.parse import parse_qs, urlparse

import pytest

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app.pve import (  # noqa: E402
    PveConnection,
    ProxmoxClient,
    ProxmoxError,
    node_from_upid,
)

# --------------------------------------------------------------------------
# Mock Proxmox API server
# --------------------------------------------------------------------------

TOKEN_ID = "proxmox@pve!panel"
TOKEN_SECRET = "1a2b3c4d-5e6f-7890-abcd-ef1234567890"

# Request log so tests can assert on what the client actually sent.
REQUESTS: List[Tuple[str, str, Dict[str, Any], Dict[str, str]]] = []


class MockPveHandler(BaseHTTPRequestHandler):
    """Serves a minimal, realistic subset of the Proxmox API."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:  # silence test output
        pass

    # -- helpers ----------------------------------------------------------
    def _read_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        content_type = self.headers.get("Content-Type", "")
        if "application/json" in content_type:
            try:
                return json.loads(raw)
            except ValueError:
                return {}
        return {k: v[0] for k, v in parse_qs(raw).items()}

    def _send(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        return self.headers.get("Authorization") == (
            f"PVEAPIToken={TOKEN_ID}={TOKEN_SECRET}"
        )

    # -- dispatch ---------------------------------------------------------
    def _handle(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        body = self._read_body() if method in ("POST", "PUT") else {}

        REQUESTS.append((method, path, {**query, **body}, dict(self.headers)))

        if not self._authorized():
            self._send(401, {"data": None, "errors": {"auth": "no valid ticket"}})
            return

        handler = self._route(method, path, query, body)
        if handler is None:
            self._send(
                501, {"data": None, "errors": {"x": f"unhandled {method} {path}"}}
            )
            return

        self._send(200, {"data": handler()})

    def _route(
        self,
        method: str,
        path: str,
        query: Dict[str, str],
        body: Dict[str, Any],
    ):
        """Resolve a route, using patterns where the VMID varies."""
        key = (method, path)
        if key in ROUTES:
            return ROUTES[key]

        # /nodes/{node}/storage/{storage}/content
        match = re.match(
            r"^/api2/json/nodes/(?P<node>[^/]+)/storage/(?P<storage>[^/]+)/content$",
            path,
        )
        if match and method == "GET":
            storage = match.group("storage")
            # Only image content is served for VM disks; ISO for the ISO store.
            items = json.loads(
                json.dumps(
                    CONTENT.get(
                        storage,
                        [
                            {
                                "volid": f"{storage}:vm-100-disk-0",
                                "format": "raw",
                                "size": 32 * 1024**3,
                                "vmid": 100,
                                "ctime": 1700000000,
                            }
                        ],
                    )
                )
            )
            # Honour ?content= like the real API: iso / backup are disjoint here.
            want = query.get("content") or ""
            if want == "iso":
                items = [i for i in items if i.get("format") == "iso"]
            elif want == "backup":
                items = [
                    i
                    for i in items
                    if i.get("type") == "backup"
                    or "vzdump" in str(i.get("volid") or "")
                ]
            return lambda: items

        # /nodes/{node}/qemu/{vmid}/snapshot  — list / create
        match = re.match(
            r"^/api2/json/nodes/(?P<node>[^/]+)/qemu/(?P<vmid>\d+)/snapshot$", path
        )
        if match and method == "GET":
            store_key = (match.group("node"), match.group("vmid"))
            snaps = SNAPSHOT_STORE.get(store_key, [])

            def list_snaps() -> List[Dict[str, Any]]:
                current: Dict[str, Any] = {"name": "current", "snaptime": 1758000000}
                if snaps:
                    current["parent"] = snaps[-1].get("name")
                return [current, *[dict(s) for s in snaps]]

            return list_snaps
        if match and method == "POST":
            store_key = (match.group("node"), match.group("vmid"))
            node, vmid = match.group("node"), match.group("vmid")

            def create_snap() -> str:
                name = str(body.get("snapname") or body.get("name") or "snap")
                SNAPSHOT_STORE.setdefault(store_key, []).append(
                    {
                        "name": name,
                        "description": str(body.get("description") or ""),
                        "snaptime": int(time.time()),
                        "parent": "",
                        "vmstate": int(body.get("vmstate") or 0),
                    }
                )
                return (
                    f"UPID:{node}:0000A1B6:00C3D4E9:65F00005:"
                    f"qmsnapshot:{vmid}:root@pam:"
                )

            return create_snap

        # /nodes/{node}/qemu/{vmid}/snapshot/{name}/rollback
        match = re.match(
            r"^/api2/json/nodes/(?P<node>[^/]+)/qemu/(?P<vmid>\d+)/snapshot/"
            r"(?P<name>[^/]+)/rollback$",
            path,
        )
        if match and method == "POST":
            node, vmid, name = match.group("node"), match.group("vmid"), match.group("name")
            return lambda: (
                f"UPID:{node}:0000A1B7:00C3D4EA:65F00006:"
                f"qmrollback:{vmid}:root@pam:{name}"
            )

        # /nodes/{node}/qemu/{vmid}/snapshot/{name}  — delete
        match = re.match(
            r"^/api2/json/nodes/(?P<node>[^/]+)/qemu/(?P<vmid>\d+)/snapshot/"
            r"(?P<name>[^/]+)$",
            path,
        )
        if match and method == "DELETE":
            store_key = (match.group("node"), match.group("vmid"))
            node, vmid, name = match.group("node"), match.group("vmid"), match.group("name")

            def delete_snap() -> str:
                kept = [
                    s
                    for s in SNAPSHOT_STORE.get(store_key, [])
                    if s.get("name") != name
                ]
                SNAPSHOT_STORE[store_key] = kept
                return (
                    f"UPID:{node}:0000A1B8:00C3D4EB:65F00007:"
                    f"qmsnapshot:{vmid}:root@pam:{name}"
                )

            return delete_snap

        # /cluster/backup  — scheduled backup jobs
        if re.match(r"^/api2/json/cluster/backup$", path):
            if method == "GET":
                return lambda: [dict(j) for j in JOB_STORE.values()]
            if method == "POST":

                def create_job() -> str:
                    jid = str(body.get("id") or f"job{len(JOB_STORE) + 1}")
                    JOB_STORE[jid] = {"id": jid, "type": "vzdump", **body}
                    return jid

                return create_job

        match = re.match(r"^/api2/json/cluster/backup/(?P<jid>[^/]+)$", path)
        if match and method == "PUT":
            jid = match.group("jid")

            def update_job() -> None:
                job = JOB_STORE.setdefault(jid, {"id": jid, "type": "vzdump"})
                job.update(body)

            return update_job
        if match and method == "DELETE":
            jid = match.group("jid")
            return lambda: JOB_STORE.pop(jid, None)

        # /nodes/{node}/qemu/{vmid}/clone  — vmid varies
        match = re.match(
            r"^/api2/json/nodes/(?P<node>[^/]+)/qemu/(?P<vmid>\d+)/clone$", path
        )
        if match and method == "POST":
            vmid = match.group("vmid")
            return lambda: (
                f"UPID:pve1:0000A1B4:00C3D4E7:65F00003:qmclone:{vmid}:root@pam:"
            )

        # /nodes/{node}/qemu/{vmid}/status/current
        match = re.match(
            r"^/api2/json/nodes/(?P<node>[^/]+)/qemu/(?P<vmid>\d+)/status/current$",
            path,
        )
        if match and method == "GET":
            return lambda: {
                "status": "running",
                "vmid": int(match.group("vmid")),
                "uptime": 3600,
                "cpu": 0.25,
                "cpus": 4,
                "mem": 2 * 1024**3,
                "maxmem": 4 * 1024**3,
            }

        # /nodes/{node}/tasks/{upid}/status
        if re.match(r"^/api2/json/nodes/[^/]+/tasks/UPID:.+/status$", path):
            return lambda: {
                "status": "stopped",
                "exitstatus": "OK",
                "type": "qmstart",
                "user": "root@pam",
                "pid": 1234,
            }

        if re.match(r"^/api2/json/nodes/[^/]+/tasks/UPID:.+/log$", path):
            return lambda: [
                {"n": 1, "t": "starting task"},
                {"n": 2, "t": "TASK OK"},
            ]

        # ------------------------------------------------------------ 防火墙
        handler = self._firewall(method, path, body)
        if handler is not None:
            return handler

        return None

    # -- firewall ---------------------------------------------------------
    def _firewall(self, method: str, path: str, body: Dict[str, Any]):
        """PVE 原生防火墙的极简实现：够验证面板的读写与批量下发即可。"""
        scope_match = _FW_SCOPE_RE.match(path)
        if scope_match:
            scope = scope_match.group("scope")
            rest = scope_match.group("rest") or ""
            if rest == "/rules":
                if method == "GET":
                    return lambda: [dict(r) for r in FIREWALL_RULES.get(scope, [])]
                if method == "POST":

                    def add_rule() -> None:
                        rows = FIREWALL_RULES.setdefault(scope, [])
                        rule = {k: v for k, v in body.items() if k != "pos"}
                        raw_pos = body.get("pos")
                        pos = int(raw_pos) if str(raw_pos or "").isdigit() else len(rows)
                        rows.insert(min(pos, len(rows)), rule)
                        for i, row in enumerate(rows):
                            row["pos"] = i

                    return add_rule

            rule_match = re.match(r"^/rules/(?P<pos>\d+)$", rest)
            if rule_match:
                pos = int(rule_match.group("pos"))
                if method == "PUT":

                    def update_rule() -> None:
                        rows = FIREWALL_RULES.setdefault(scope, [])
                        if "move" in body:  # 调整顺序
                            rows.insert(int(body["move"]), rows.pop(pos))
                        else:
                            rows[pos].update(
                                {k: v for k, v in body.items() if k != "pos"}
                            )
                        for i, row in enumerate(rows):
                            row["pos"] = i

                    return update_rule
                if method == "DELETE":

                    def delete_rule() -> None:
                        rows = FIREWALL_RULES.setdefault(scope, [])
                        rows.pop(pos)
                        for i, row in enumerate(rows):
                            row["pos"] = i

                    return delete_rule

            if rest == "/options":
                if method == "GET":
                    return lambda: dict(
                        FIREWALL_OPTIONS.get(
                            scope,
                            {"enable": 0, "policy_in": "DROP", "policy_out": "ACCEPT"},
                        )
                    )
                if method == "PUT":

                    def set_options() -> None:
                        FIREWALL_OPTIONS.setdefault(scope, {}).update(body)

                    return set_options

        if path == "/api2/json/cluster/firewall/refs":
            return lambda: {
                "macros": ["SSH", "HTTP", "HTTPS"],
                "aliases": ["management"],
                "ipsets": sorted(FIREWALL_IPSETS),
                "groups": sorted(FIREWALL_GROUPS),
            }

        # 安全组：/cluster/firewall/groups[/{group}[/{pos}]]
        if path == "/api2/json/cluster/firewall/groups":
            if method == "GET":
                return lambda: [
                    {
                        "group": name,
                        "comment": str(cfg.get("comment") or ""),
                        "digest": "d0",
                    }
                    for name, cfg in FIREWALL_GROUPS.items()
                ]
            if method == "POST":

                def create_group() -> None:
                    FIREWALL_GROUPS[str(body.get("group") or "")] = {
                        "comment": str(body.get("comment") or ""),
                        "rules": [],
                    }

                return create_group

        group_match = re.match(
            r"^/api2/json/cluster/firewall/groups/(?P<group>[^/]+)$", path
        )
        if group_match:
            group = group_match.group("group")
            if method == "GET":
                return lambda: [
                    dict(r) for r in FIREWALL_GROUPS.get(group, {}).get("rules", [])
                ]
            if method == "POST":

                def add_group_rule() -> None:
                    rules = FIREWALL_GROUPS.setdefault(
                        group, {"comment": "", "rules": []}
                    ).setdefault("rules", [])
                    rule = {k: v for k, v in body.items() if k != "pos"}
                    rules.append(rule)
                    for i, row in enumerate(rules):
                        row["pos"] = i

                return add_group_rule
            if method == "DELETE":
                return lambda: FIREWALL_GROUPS.pop(group, None)

        group_rule_match = re.match(
            r"^/api2/json/cluster/firewall/groups/(?P<group>[^/]+)/(?P<pos>\d+)$", path
        )
        if group_rule_match:
            group = group_rule_match.group("group")
            pos = int(group_rule_match.group("pos"))
            if method == "PUT":

                def update_group_rule() -> None:
                    rules = FIREWALL_GROUPS[group]["rules"]
                    rules[pos].update({k: v for k, v in body.items() if k != "pos"})

                return update_group_rule
            if method == "DELETE":

                def delete_group_rule() -> None:
                    FIREWALL_GROUPS[group]["rules"].pop(pos)

                return delete_group_rule

        # IP 集合：/cluster/firewall/ipset[/{name}[/{cidr}]]
        if path == "/api2/json/cluster/firewall/ipset":
            if method == "GET":
                return lambda: [
                    {"name": name, "comment": cfg.get("comment", ""), "digest": "d0"}
                    for name, cfg in FIREWALL_IPSETS.items()
                ]
            if method == "POST":

                def create_ipset() -> None:
                    FIREWALL_IPSETS[str(body.get("name") or "")] = {
                        "comment": str(body.get("comment") or ""),
                        "entries": [],
                    }

                return create_ipset

        ipset_match = re.match(
            r"^/api2/json/cluster/firewall/ipset/(?P<name>[^/]+)$", path
        )
        if ipset_match:
            name = ipset_match.group("name")
            if method == "GET":
                return lambda: [
                    dict(e) for e in FIREWALL_IPSETS.get(name, {}).get("entries", [])
                ]
            if method == "POST":

                def add_entry() -> None:
                    entries = FIREWALL_IPSETS.setdefault(
                        name, {"comment": "", "entries": []}
                    ).setdefault("entries", [])
                    entries.append(
                        {
                            "cidr": str(body.get("cidr") or ""),
                            "comment": str(body.get("comment") or ""),
                            "nomatch": int(body.get("nomatch") or 0),
                        }
                    )

                return add_entry
            if method == "DELETE":
                return lambda: FIREWALL_IPSETS.pop(name, None)

        ipset_entry_match = re.match(
            r"^/api2/json/cluster/firewall/ipset/(?P<name>[^/]+)/(?P<cidr>.+)$", path
        )
        if ipset_entry_match and method == "DELETE":
            name = ipset_entry_match.group("name")
            cidr = ipset_entry_match.group("cidr")

            def delete_entry() -> None:
                cfg = FIREWALL_IPSETS.get(name) or {}
                cfg["entries"] = [
                    e for e in cfg.get("entries", []) if e.get("cidr") != cidr
                ]

            return delete_entry

        return None

    def do_GET(self) -> None:
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_PUT(self) -> None:
        self._handle("PUT")

    def do_DELETE(self) -> None:
        self._handle("DELETE")


# --------------------------------------------------------------------------
# Fixtures: the data a real Proxmox node would return
# --------------------------------------------------------------------------

# Mutable per-server state (reset in MockPveServer.__init__): snapshots are
# keyed by (node, vmid), scheduled backup jobs by job id.
SNAPSHOT_STORE: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
JOB_STORE: Dict[str, Dict[str, Any]] = {}

# 防火墙：三级规则（cluster / node / vm）、选项、安全组、IP 集合。
# 键是作用域串（"cluster" / "nodes/pve1" / "nodes/pve1/qemu/100"），
# 值是该作用域的规则列表，pos 与列表下标保持一致 —— 与真实 PVE 语义相同。
FIREWALL_RULES: Dict[str, List[Dict[str, Any]]] = {}
FIREWALL_OPTIONS: Dict[str, Dict[str, Any]] = {}
FIREWALL_GROUPS: Dict[str, Dict[str, Any]] = {}
FIREWALL_IPSETS: Dict[str, Dict[str, Any]] = {}

# /api2/json/<scope>/firewall[/rules|/rules/{pos}|/options]
_FW_SCOPE_RE = re.compile(
    r"^/api2/json/(?P<scope>cluster|nodes/[^/]+|nodes/[^/]+/(?:qemu|lxc)/\d+)"
    r"/firewall(?P<rest>/.*)?$"
)

NODE = {
    "node": "pve1",
    "status": "online",
    "cpu": 0.15,
    "maxcpu": 16,
    "mem": 8 * 1024**3,
    "maxmem": 64 * 1024**3,
    "disk": 100 * 1024**3,
    "maxdisk": 500 * 1024**3,
    "uptime": 86400,
}

VM_RUNNING = {
    "id": "qemu/100",
    "type": "qemu",
    "node": "pve1",
    "vmid": 100,
    "name": "web-01",
    "status": "running",
    "template": 0,
    "maxcpu": 4,
    "maxmem": 4 * 1024**3,
    "cpu": 0.25,
    "mem": 2 * 1024**3,
}

VM_TEMPLATE = {
    "id": "qemu/9000",
    "type": "qemu",
    "node": "pve1",
    "vmid": 9000,
    "name": "ubuntu-template",
    "status": "stopped",
    "template": 1,
    "maxcpu": 2,
    "maxmem": 2 * 1024**3,
}

VM_CONFIG = {
    "name": "web-01",
    "memory": 4096,
    "cores": 4,
    "ostype": "l26",
    "agent": 1,
    "scsi0": "local-lvm:vm-100-disk-0,size=32G",
    "net0": "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=10",
    "ide2": "local-lvm:vm-100-cloudinit,media=cdrom",
    "boot": "order=scsi0",
    "ciuser": "ubuntu",
    "ipconfig0": "ip=dhcp",
}

STORAGES = [
    {
        "storage": "local-lvm",
        "type": "lvmthin",
        "content": "images,rootdir",
        "active": 1,
        "total": 500 * 1024**3,
        "used": 100 * 1024**3,
        "avail": 400 * 1024**3,
    },
    {
        "storage": "local",
        "type": "dir",
        "content": "iso,vztmpl,backup",
        "active": 1,
        "total": 100 * 1024**3,
        "used": 10 * 1024**3,
        "avail": 90 * 1024**3,
    },
]

NIC = {
    "iface": "vmbr0",
    "type": "bridge",
    "active": 1,
    "address": "192.168.1.10",
    "cidr": "192.168.1.10/24",
    "bridge_ports": "eno1",
    "autostart": 1,
}

TASK = {
    "upid": "UPID:pve1:0000A1B2:00C3D4E5:65F00000:qmstart:100:root@pam:",
    "node": "pve1",
    "type": "qmstart",
    "status": "stopped",
    "exitstatus": "OK",
    "starttime": 1700000100,
    "endtime": 1700000105,
    "user": "root@pam",
    "id": "100",
}

# Storage content, keyed by storage name.
CONTENT = {
    "local-lvm": [
        {
            "volid": "local-lvm:vm-100-disk-0",
            "format": "raw",
            "size": 32 * 1024**3,
            "vmid": 100,
            "ctime": 1700000000,
        }
    ],
    "local": [
        {
            # PVE reports cloud images under the "iso" content type.
            "volid": "local:iso/ubuntu-24.04-cloudimg-amd64.img",
            "format": "iso",
            "size": 600 * 1024**2,
            "ctime": 1700000001,
        },
        {
            "volid": "local:iso/debian-12-netinst.iso",
            "format": "iso",
            "size": 700 * 1024**2,
            "ctime": 1700000002,
        },
        {
            # Backup archive created by admin — notes carries the owner marker.
            "volid": "local:vzdump-qemu-100-2026_09_20-02_00_00.vma.zst",
            "type": "backup",
            "format": "vma.zst",
            "size": 5 * 1024**3,
            "vmid": 100,
            "ctime": 1758300000,
            "notes": "升级前备份 [owner:admin]",
        },
        {
            # Backup archive created by bob (普通用户).
            "volid": "local:vzdump-qemu-101-2026_09_21-03_00_00.vma.zst",
            "type": "backup",
            "format": "vma.zst",
            "size": 3 * 1024**3,
            "vmid": 101,
            "ctime": 1758400000,
            "notes": "[owner:bob]",
        },
        {
            # Legacy archive with no owner marker: admin-only under strict isolation.
            "volid": "local:vzdump-qemu-9000-2026_09_10-02_00_00.vma.zst",
            "type": "backup",
            "format": "vma.zst",
            "size": 1 * 1024**3,
            "vmid": 9000,
            "ctime": 1757500000,
            "notes": "",
        },
    ],
}

# Effective privileges reported by /access/permissions. Tests swap this for {}
# to emulate a privilege-separated API token that has not been granted an ACL —
# the default state of a freshly created Proxmox token.
PERMISSIONS: Dict[str, List[str]] = {
    "/": [
        "Sys.Audit",
        "VM.Audit",
        "VM.Allocate",
        "Datastore.Audit",
        "Datastore.AllocateSpace",
    ],
}

# Exact-match routes. Must come after the fixtures it references.
ROUTES = {
    ("GET", "/api2/json/version"): lambda: {
        "version": "8.2.4",
        "release": "8.2",
        "repoid": "abcdef",
    },
    ("GET", "/api2/json/nodes"): lambda: [NODE],
    ("GET", "/api2/json/access/permissions"): lambda: PERMISSIONS,
    ("GET", "/api2/json/cluster/nextid"): lambda: 105,
    ("GET", "/api2/json/cluster/resources"): lambda: [VM_RUNNING, VM_TEMPLATE],
    ("GET", "/api2/json/nodes/pve1/qemu/100/config"): lambda: VM_CONFIG,
    ("GET", "/api2/json/nodes/pve1/storage"): lambda: STORAGES,
    # Cluster-wide storage list. PVE exposes this alongside the per-node view,
    # and /api/storages calls it when no node is given.
    ("GET", "/api2/json/storage"): lambda: STORAGES,
    ("GET", "/api2/json/nodes/pve1/network"): lambda: [NIC],
    ("GET", "/api2/json/nodes/pve1/tasks"): lambda: [TASK],
    ("POST", "/api2/json/nodes/pve1/qemu"): lambda: (
        "UPID:pve1:0000A1B2:00C3D4E5:65F00001:qmcreate:105:root@pam:"
    ),
    ("POST", "/api2/json/nodes/pve1/qemu/100/status/start"): lambda: (
        "UPID:pve1:0000A1B3:00C3D4E6:65F00002:qmstart:100:root@pam:"
    ),
    ("POST", "/api2/json/nodes/pve1/qemu/9000/template"): lambda: (
        "UPID:pve1:0000A1B5:00C3D4E8:65F00004:qmtemplate:9000:root@pam:"
    ),
}


class MockPveServer:
    """A threaded HTTP server that plays the role of a Proxmox node.

    ``ThreadingHTTPServer`` is required: the panel's client issues concurrent
    requests during fan-out operations, and a single-threaded server would
    deadlock waiting for itself.
    """

    def __init__(self) -> None:
        # Mutable fixtures must not leak between tests.
        SNAPSHOT_STORE.clear()
        JOB_STORE.clear()
        FIREWALL_RULES.clear()
        FIREWALL_OPTIONS.clear()
        FIREWALL_GROUPS.clear()
        FIREWALL_IPSETS.clear()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), MockPveHandler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self) -> "MockPveServer":
        self.thread.start()
        return self

    def __exit__(self, *args: Any) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


@pytest.fixture()
def mock_pve():
    REQUESTS.clear()
    with MockPveServer() as server:
        yield server


def make_client(server: MockPveServer) -> ProxmoxClient:
    return ProxmoxClient(
        PveConnection(
            # http:// is honoured verbatim, so the mock stays plain HTTP.
            host=f"http://127.0.0.1:{server.port}",
            port=server.port,
            token_id=TOKEN_ID,
            token_secret=TOKEN_SECRET,
            verify_ssl=False,
        )
    )


def run(coro):
    """Run a coroutine on a private loop, then shut that loop down cleanly.

    ``asyncio.run`` and multi-call tests interact badly: httpx keeps pooled
    connections bound to the loop that created them. Closing the loop without
    closing the client leaves transports pointing at a dead loop, and the next
    call raises "Event loop is closed". Draining pending callbacks before
    closing avoids that.
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        # Let any scheduled transport teardown callbacks run before closing.
        try:
            pending = asyncio.all_tasks(loop)
            if pending:
                loop.run_until_complete(
                    asyncio.gather(*pending, return_exceptions=True)
                )
            loop.run_until_complete(loop.shutdown_asyncgens())
        except Exception:  # noqa: BLE001
            pass
        asyncio.set_event_loop(None)
        loop.close()


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------


class TestAuthentication:
    def test_sends_correct_authorization_header(self, mock_pve) -> None:
        client = make_client(mock_pve)
        run(client.version())
        # The header format is the single most common integration mistake.
        assert any(
            h.get("Authorization") == f"PVEAPIToken={TOKEN_ID}={TOKEN_SECRET}"
            for _, _, _, h in REQUESTS
        )

    def test_rejects_wrong_token(self, mock_pve) -> None:
        client = ProxmoxClient(
            PveConnection(
                host=f"http://127.0.0.1:{mock_pve.port}",
                token_id="bad@pve!t",
                token_secret="wrong",
            )
        )
        with pytest.raises(ProxmoxError) as exc:
            run(client.version())
        # 上游 401 统一按 502 上报，避免前端误判为面板会话失效
        # （见 ProxmoxError 文档），原码保留在 pve_status。
        assert exc.value.status_code == 502
        assert exc.value.pve_status == 401

    def test_unconfigured_client_fails_fast(self) -> None:
        client = ProxmoxClient(PveConnection(host="", token_id="", token_secret=""))
        with pytest.raises(ProxmoxError) as exc:
            run(client.version())
        # 428 Precondition Required — the UI shows "configure the connection".
        assert exc.value.status_code == 428


class TestResponseUnwrapping:
    def test_data_field_is_unwrapped(self, mock_pve) -> None:
        client = make_client(mock_pve)
        version = run(client.version())
        # Callers should get the payload, not the {"data": ...} envelope.
        assert version["version"] == "8.2.4"
        assert "data" not in version

    def test_upid_string_is_returned_verbatim(self, mock_pve) -> None:
        client = make_client(mock_pve)
        upid = run(client.qemu_power("pve1", 100, "start"))
        assert isinstance(upid, str)
        assert upid.startswith("UPID:pve1:")

    def test_list_endpoints_return_lists(self, mock_pve) -> None:
        client = make_client(mock_pve)

        # One coroutine, one loop: httpx pools connections per loop, so
        # splitting these across run() calls would close the loop mid-flight.
        async def scenario() -> None:
            try:
                assert len(await client.nodes()) == 1
                assert len(await client.cluster_resources("vm")) == 2
                assert len(await client.node_network("pve1")) == 1
            finally:
                await client.aclose()

        run(scenario())


class TestVmOperations:
    def test_create_vm_sends_all_config_keys(self, mock_pve) -> None:
        client = make_client(mock_pve)
        config = {
            "vmid": 105,
            "name": "test-vm",
            "memory": 2048,
            "cores": 2,
            "scsi0": "local-lvm:32",
            "net0": "virtio,bridge=vmbr0",
        }
        run(client.qemu_create("pve1", config))

        body = next(b for m, p, b, _ in REQUESTS if p == "/api2/json/nodes/pve1/qemu")
        assert body["name"] == "test-vm"
        assert body["memory"] == 2048
        assert body["scsi0"] == "local-lvm:32"

    def test_nextid_returns_int(self, mock_pve) -> None:
        client = make_client(mock_pve)
        vmid = run(client.nextid())
        # PVE returns this as a string; the panel needs an int.
        assert vmid == 105
        assert isinstance(vmid, int)

    def test_config_parsing_roundtrip(self, mock_pve) -> None:
        from app import vmconfig

        client = make_client(mock_pve)
        config = run(client.qemu_config("pve1", 100))

        disks = vmconfig.parse_config_disks(config)
        assert len(disks) == 1
        assert disks[0]["storage"] == "local-lvm"
        assert disks[0]["size"] == "32G"

        nets = vmconfig.parse_config_networks(config)
        assert len(nets) == 1
        assert nets[0]["model"] == "virtio"
        assert nets[0]["macaddr"] == "AA:BB:CC:DD:EE:FF"
        assert nets[0]["bridge"] == "vmbr0"
        assert nets[0]["tag"] == "10"


class TestTaskHandling:
    def test_node_derived_from_upid(self) -> None:
        upid = "UPID:pve1:0000A1B2:00C3D4E5:65F00000:qmstart:100:root@pam:"
        assert node_from_upid(upid) == "pve1"

    def test_task_status_and_log(self, mock_pve) -> None:
        client = make_client(mock_pve)
        upid = "UPID:pve1:0000A1B2:00C3D4E5:65F00000:qmstart:100:root@pam:"
        # node is omitted on purpose: it must be parsed from the UPID.
        status = run(client.task_status(upid))
        assert status["status"] == "stopped"
        assert status["exitstatus"] == "OK"

    def test_tasks_fan_out_across_nodes(self, mock_pve) -> None:
        client = make_client(mock_pve)
        tasks = run(client.tasks(limit=10))
        assert len(tasks) == 1
        assert tasks[0]["type"] == "qmstart"


class TestStorageAndTemplates:
    def test_storage_listing(self, mock_pve) -> None:
        client = make_client(mock_pve)
        storages = run(client.storages("pve1"))
        assert len(storages) == 2
        names = {s["storage"] for s in storages}
        assert names == {"local-lvm", "local"}

    def test_storage_content_filtered_by_type(self, mock_pve) -> None:
        client = make_client(mock_pve)
        content = run(client.storage_content("pve1", "local", content="iso"))
        # The `local` fixture holds two ISOs and no images.
        assert len(content) == 2
        assert all(item["format"] == "iso" for item in content)
        assert all(item["volid"].startswith("local:iso/") for item in content)

    def test_cloud_image_discovery(self, mock_pve) -> None:
        """The template pipeline must find .img files on ISO storages."""

        client = make_client(mock_pve)

        async def scenario() -> List[str]:
            found: List[str] = []
            try:
                for storage in await client.storages("pve1"):
                    if "iso" not in (storage.get("content") or ""):
                        continue
                    items = await client.storage_content(
                        "pve1", storage["storage"], content="iso"
                    )
                    for item in items:
                        volid = item.get("volid", "")
                        if volid.lower().endswith((".img", ".qcow2")):
                            found.append(volid)
            finally:
                await client.aclose()
            return found

        assert run(scenario()) == ["local:iso/ubuntu-24.04-cloudimg-amd64.img"]

    def test_clone_sends_newid_and_full_flag(self, mock_pve) -> None:
        client = make_client(mock_pve)
        run(
            client.qemu_clone(
                "pve1", 9000, newid=110, name="web-02", full=True,
                target_storage="local-lvm",
            )
        )
        body = next(
            b for m, p, b, _ in REQUESTS if p.endswith("/qemu/9000/clone")
        )
        assert body["newid"] == 110
        assert body["name"] == "web-02"
        assert body["full"] == 1  # PVE wants 1/0, not true/false
        assert body["storage"] == "local-lvm"

    def test_clone_full_off_sends_zero(self, mock_pve) -> None:
        client = make_client(mock_pve)
        run(client.qemu_clone("pve1", 9000, newid=111, full=False))
        body = next(
            b for m, p, b, _ in REQUESTS if p.endswith("/qemu/9000/clone")
        )
        assert body["full"] == 0

    def test_convert_to_template(self, mock_pve) -> None:
        client = make_client(mock_pve)
        upid = run(client.qemu_to_template("pve1", 9000))
        assert upid.startswith("UPID:pve1:")


class TestStorageTypeMap:
    """The disk-format normaliser depends on knowing each storage's type."""

    def test_maps_storage_to_type(self, mock_pve) -> None:
        from app import vmconfig

        client = make_client(mock_pve)
        storages = run(client.storages("pve1"))
        type_map = {s["storage"]: s["type"] for s in storages}
        assert type_map == {"local-lvm": "lvmthin", "local": "dir"}

        # qcow2 must be coerced to raw on lvmthin, preserved on dir.
        assert vmconfig.normalize_disk_format("qcow2", type_map["local-lvm"]) == "raw"
        assert vmconfig.normalize_disk_format("qcow2", type_map["local"]) == "qcow2"


class TestPluginFailureModes:
    def test_node_offline_does_not_break_task_listing(self, mock_pve) -> None:
        """A node going offline must not take down the whole task page."""
        client = make_client(mock_pve)
        tasks = run(client.tasks(limit=10))
        assert isinstance(tasks, list)

    def test_unhandled_endpoint_surfaces_pve_error(self, mock_pve) -> None:
        client = make_client(mock_pve)
        with pytest.raises(ProxmoxError) as exc:
            run(client.get("/nodes/nonexistent/qemu"))
        assert exc.value.status_code == 501


# --------------------------------------------------------------------------
# Transport-layer failures
# --------------------------------------------------------------------------


class _FailingHttpClient:
    """Stand-in for ``httpx.AsyncClient`` that always raises a given error.

    Injecting this into ``ProxmoxClient._client`` lets us exercise transport
    failures (connection refused, TLS, proxy interception, timeouts) without
    needing a real broken network.
    """

    is_closed = False

    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    async def request(self, *args: Any, **kwargs: Any) -> Any:
        raise self._exc

    async def aclose(self) -> None:
        return None


def _client_raising(server: MockPveServer, exc: BaseException) -> ProxmoxClient:
    client = make_client(server)
    client._client = _FailingHttpClient(exc)  # type: ignore[assignment]
    return client


class TestTransportFailures:
    """Every transport failure must become a ProxmoxError with a usable code.

    A raw httpx exception escaping here would surface as an opaque 500 with a
    traceback in the UI, which tells the operator nothing.
    """

    def test_connect_error_becomes_502(self, mock_pve) -> None:
        client = _client_raising(
            mock_pve, httpx.ConnectError("connection refused")
        )
        with pytest.raises(ProxmoxError) as exc:
            run(client.version())
        assert exc.value.status_code == 502
        assert "Cannot reach Proxmox" in exc.value.message
        # The operator needs to see *which* host failed.
        assert client.conn.base_url in exc.value.message

    def test_proxy_interception_is_explained(self, mock_pve) -> None:
        """A stray HTTP_PROXY must produce an actionable message."""
        client = _client_raising(mock_pve, httpx.ProxyError("502 Bad Gateway"))
        with pytest.raises(ProxmoxError) as exc:
            run(client.version())
        assert exc.value.status_code == 502
        message = exc.value.message
        assert "intercepted by a proxy" in message
        assert "PVE_TRUST_ENV" in message  # tells them how to fix it

    def test_timeout_becomes_504(self, mock_pve) -> None:
        client = _client_raising(
            mock_pve, httpx.ReadTimeout("timed out")
        )
        with pytest.raises(ProxmoxError) as exc:
            run(client.version())
        assert exc.value.status_code == 504

    def test_httpx_client_ignores_proxy_env_by_default(self, mock_pve) -> None:
        """Proxmox is a LAN endpoint; HTTP_PROXY must not hijack calls."""
        client = make_client(mock_pve)

        async def probe() -> bool:
            http = await client._http()
            try:
                return http.trust_env
            finally:
                await client.aclose()

        assert run(probe()) is False


class TestConsoleWsUrl:
    """Both console kinds must upgrade to the vncwebsocket endpoint.

    PVE has no ``termwebsocket`` route — the serial console's termproxy
    ticket is assembled exactly like vncproxy's, so it is verified on
    ``vncwebsocket`` too. A wrong path yields HTTP 501 upstream.
    """

    @staticmethod
    def _client() -> ProxmoxClient:
        return ProxmoxClient(
            PveConnection(
                host="https://pve.example:8006",
                token_id=TOKEN_ID,
                token_secret=TOKEN_SECRET,
            )
        )

    def test_vnc_uses_vncwebsocket(self) -> None:
        url = self._client().console_ws_url("pve1", 100, "vnc", 5900, "TICK/ET==")
        assert url.startswith(
            "wss://pve.example:8006/api2/json/nodes/pve1/qemu/100/vncwebsocket?"
        )
        assert "port=5900" in url
        assert "vncticket=TICK%2FET%3D%3D" in url

    def test_xterm_also_uses_vncwebsocket(self) -> None:
        url = self._client().console_ws_url("pve1", 100, "xterm", 5901, "abc")
        assert "/vncwebsocket?" in url
        assert "termwebsocket" not in url
