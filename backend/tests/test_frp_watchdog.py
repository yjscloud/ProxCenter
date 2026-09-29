"""内网穿透（frpc）的「停止后自动拉起」看护。

覆盖四条边界：

* 开关没开 / 进程还在跑 —— 都不该动手；
* 进程不在 —— 拉起一次，并把痕迹写进日志（用户要能看见它崩过）；
* 拉起失败 —— 要抛出去让调度器把作业标成 error，并且**退避**：配置填错时
  每个周期拉一次又崩一次，只会把日志刷爆、把真正的报错淹掉；
* 开关的持久化：手写的取值要能被读回来（面板重启后仍记得）。

不依赖 MySQL 与真实的 frpc 进程：``store`` 与 ``start`` 都打桩。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import frp  # noqa: E402


class _FakeStore:
    """内存版 settings，验证开关的写入 / 读回。"""

    def __init__(self) -> None:
        self.values: Dict[str, str] = {}

    async def get_setting(self, key: str, default=None):
        return self.values.get(key, default)

    async def set_setting(self, key: str, value: str) -> None:
        self.values[key] = value


@pytest.fixture
def fake(monkeypatch):
    store = _FakeStore()
    monkeypatch.setattr(frp.store, "get_setting", store.get_setting)
    monkeypatch.setattr(frp.store, "set_setting", store.set_setting)

    state: Dict[str, Any] = {"running": False, "starts": 0, "fail": False, "logs": []}
    monkeypatch.setattr(frp, "is_running", lambda: state["running"])
    async def _effective() -> Dict[str, Any]:
        return {"server_addr": "x", "proxies": [{}]}

    monkeypatch.setattr(frp, "effective", _effective)
    monkeypatch.setattr(
        frp, "start", lambda _cfg: _start(state),
    )
    monkeypatch.setattr(frp, "_log", lambda line: state["logs"].append(line))
    monkeypatch.setattr(frp, "_reap", lambda: None)
    # 每个用例都从「没失败过」开始，退避状态不跨用例
    monkeypatch.setattr(frp, "_failures", 0)
    monkeypatch.setattr(frp, "_next_attempt_at", 0.0)
    return state


def _start(state: Dict[str, Any]) -> None:
    state["starts"] += 1
    if state["fail"]:
        raise frp.FrpError("连不上服务端")
    state["running"] = True


class TestToggle:
    def test_round_trip(self, fake) -> None:
        assert asyncio.run(frp.auto_restart_enabled()) is False, "缺省应当关闭"
        asyncio.run(frp.set_auto_restart(True))
        assert asyncio.run(frp.auto_restart_enabled()) is True
        asyncio.run(frp.set_auto_restart(False))
        assert asyncio.run(frp.auto_restart_enabled()) is False

    def test_accepts_common_truthy_spellings(self, fake) -> None:
        """手写进去的值（运维直接改库）也要认。"""
        asyncio.run(frp.store.set_setting(frp.AUTOSTART_KEY, "true"))
        assert asyncio.run(frp.auto_restart_enabled()) is True
        asyncio.run(frp.store.set_setting(frp.AUTOSTART_KEY, "0"))
        assert asyncio.run(frp.auto_restart_enabled()) is False


class TestWatchdog:
    def test_does_nothing_when_disabled(self, fake) -> None:
        """开关没开就别碰进程 —— 用户手动停掉之后不该被拉起来。"""
        result = asyncio.run(frp.watchdog())
        assert result["action"] == "skipped"
        assert fake["starts"] == 0

    def test_does_nothing_while_running(self, fake) -> None:
        asyncio.run(frp.set_auto_restart(True))
        fake["running"] = True
        result = asyncio.run(frp.watchdog())
        assert result["action"] == "running"
        assert fake["starts"] == 0, "已经在跑就别再拉一个"

    def test_restarts_when_stopped(self, fake) -> None:
        asyncio.run(frp.set_auto_restart(True))
        result = asyncio.run(frp.watchdog())
        assert result["action"] == "restarted"
        assert fake["starts"] == 1
        # 拉起这件事要写进日志：否则用户只看到进程在跑，不知道它崩过
        assert any("自动拉起" in line for line in fake["logs"])

    def test_failure_raises_and_backs_off(self, fake, monkeypatch) -> None:
        """拉不起来要抛（调度器据此标 error），并且下一个周期先别急着再试。"""
        asyncio.run(frp.set_auto_restart(True))
        fake["fail"] = True

        with pytest.raises(frp.FrpError):
            asyncio.run(frp.watchdog())
        assert fake["starts"] == 1

        # 立刻再跑一轮：应当命中退避，**不再**尝试
        result = asyncio.run(frp.watchdog())
        assert result["action"] == "backoff"
        assert fake["starts"] == 1, "退避期内不该重复拉起"
        assert any("失败" in line for line in fake["logs"])

    def test_success_resets_the_backoff(self, fake, monkeypatch) -> None:
        """先失败再成功：退避要复位，否则一次失败会把看护拖成长时间不干活。"""
        asyncio.run(frp.set_auto_restart(True))
        fake["fail"] = True
        with pytest.raises(frp.FrpError):
            asyncio.run(frp.watchdog())

        fake["fail"] = False
        monkeypatch.setattr(frp, "_next_attempt_at", 0.0)  # 假装退避期已过
        result = asyncio.run(frp.watchdog())
        assert result["action"] == "restarted"
        assert fake["starts"] == 2

        # 复位之后：再停一次应当能立刻拉起，而不是卡在退避里
        fake["running"] = False
        result = asyncio.run(frp.watchdog())
        assert result["action"] == "restarted"
        assert fake["starts"] == 3
