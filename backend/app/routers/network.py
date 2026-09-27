"""Network configuration endpoints (Linux bridges, bonds, VLANs)."""
from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import security
from ..pve import ProxmoxError, get_client
from ..schemas import NetworkUpsert

router = APIRouter(prefix="/api", tags=["network"])


def _raise(exc: ProxmoxError) -> None:
    raise HTTPException(
        status_code=exc.status_code if exc.status_code < 600 else 500,
        detail=exc.message,
    )


def _to_pve_payload(payload: NetworkUpsert) -> Dict[str, Any]:
    """Translate the request model into PVE's flat parameter names."""
    data: Dict[str, Any] = {
        "iface": payload.iface,
        "type": payload.type,
        "autostart": 1 if payload.autostart else 0,
    }

    if payload.address:
        data["address"] = payload.address
    if payload.cidr:
        # PVE 8 accepts CIDR directly; strip any stray whitespace.
        data["cidr"] = payload.cidr.strip()
    if payload.netmask:
        data["netmask"] = payload.netmask
    if payload.gateway:
        data["gateway"] = payload.gateway
    if payload.comments:
        data["comments"] = payload.comments
    if payload.mtu:
        data["mtu"] = payload.mtu

    if payload.type == "bridge":
        if payload.bridge_ports is not None:
            data["bridge_ports"] = payload.bridge_ports
        if payload.bridge_vlan_aware is not None:
            data["bridge_vlan_aware"] = 1 if payload.bridge_vlan_aware else 0
    elif payload.type == "bond":
        if payload.bond_mode:
            data["bond_mode"] = payload.bond_mode
        if payload.bond_slaves:
            data["slaves"] = payload.bond_slaves
    elif payload.type in ("vlan", "OVSBridge"):
        if payload.vlan_id is not None:
            data["vlan-id"] = payload.vlan_id
        if payload.vlan_raw_device:
            data["vlan-raw-device"] = payload.vlan_raw_device

    return data


@router.get("/nodes/{node}/network")
async def list_network(
    node: str,
    user: Dict[str, Any] = Depends(security.require_permission("network.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        return await client.node_network(node)
    except ProxmoxError as exc:
        _raise(exc)


@router.post("/nodes/{node}/network")
async def create_network(
    node: str,
    payload: NetworkUpsert,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("network.manage")),
) -> Dict[str, Any]:
    client = get_client()
    try:
        result = await client.network_create(node, _to_pve_payload(payload))
    except ProxmoxError as exc:
        await security.audit(
            request, user, "network.create", target=f"{node}/{payload.iface}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    await security.audit(
        request, user, "network.create", target=f"{node}/{payload.iface}",
        detail=_to_pve_payload(payload),
    )
    # PVE returns null for this endpoint; the change is applied on reload.
    return result or {"task": None, "pending": True}


@router.put("/nodes/{node}/network/{iface}")
async def update_network(
    node: str,
    iface: str,
    payload: NetworkUpsert,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("network.manage")),
) -> Dict[str, Any]:
    client = get_client()
    data = _to_pve_payload(payload)
    data.pop("iface", None)  # iface is in the path
    data.pop("type", None)   # the interface type is not changeable

    try:
        result = await client.network_update(node, iface, data)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "network.update", target=f"{node}/{iface}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    await security.audit(
        request, user, "network.update", target=f"{node}/{iface}", detail=data
    )
    return result or {"task": None, "pending": True}


@router.delete("/nodes/{node}/network/{iface}")
async def delete_network(
    node: str,
    iface: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("network.manage")),
) -> Dict[str, Any]:
    client = get_client()
    try:
        result = await client.network_delete(node, iface)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "network.delete", target=f"{node}/{iface}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    await security.audit(request, user, "network.delete", target=f"{node}/{iface}")
    return result or {"task": None, "pending": True}


@router.post("/nodes/{node}/network/{iface}/reload")
async def reload_network(
    node: str,
    iface: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("network.manage")),
) -> Dict[str, Any]:
    """Apply pending network changes to the running node configuration.

    PVE applies the whole file atomically, so ``iface`` is informational only
    and kept in the path to match the frontend contract.
    """
    client = get_client()
    try:
        await client.network_reload(node)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "network.reload", target=node,
            result="failed", detail=exc.message,
        )
        _raise(exc)

    await security.audit(request, user, "network.reload", target=node)
    return {"task": None, "reloaded": True, "iface": iface}


@router.post("/nodes/{node}/network/revert")
async def revert_network(
    node: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("network.manage")),
) -> Dict[str, Any]:
    """Discard all pending network changes on a node."""
    client = get_client()
    try:
        await client.network_revert(node)
    except ProxmoxError as exc:
        _raise(exc)

    await security.audit(request, user, "network.revert", target=node)
    return {"task": None, "reverted": True}
