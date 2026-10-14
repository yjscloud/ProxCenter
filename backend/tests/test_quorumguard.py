"""集群仲裁巡检：判据与来源注册。

不起调度器、不打 PVE：这里只钉住两件最容易写错的事 ——

1. **判据必须是 ``is False``**。单机连接与读不到 HA 的连接都是 ``quorate=None``，
   写成 ``not quorate`` 会把它们一起报成集群故障 —— 一个套着几台单机 PVE 的
   部署会立刻收到一屏假告警；
2. 告警来源要在注册表里有常量，否则调用点只能手写字符串，拼错就永远静默。
"""
from __future__ import annotations

from app import alerting, quorumguard


def test_only_lost_quorum_counts() -> None:
    items = [
        {"name": "pve-a", "quorate": False},
        {"name": "pve-b", "quorate": True},
        {"name": "pve-c", "quorate": None},
        {"name": "pve-d"},  # 字段缺失：探测失败或老版本连接
    ]
    assert [i["name"] for i in quorumguard.no_quorum_connections(items)] == ["pve-a"]


def test_standalone_is_not_an_alarm() -> None:
    """单机（quorate=None）与读不到 HA 的连接都不该告警：它们没有仲裁可言。"""
    assert quorumguard.no_quorum_connections([{"quorate": None}]) == []
    assert quorumguard.no_quorum_connections([]) == []


def test_source_is_registered() -> None:
    assert alerting.SOURCE_QUORUM in alerting.NOTIFY_SOURCE_IDS
    assert alerting.NOTIFY_LABELS[alerting.SOURCE_QUORUM]
