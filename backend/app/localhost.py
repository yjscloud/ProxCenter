"""面板本机（跑着面板的那台服务器）是否已纳入安全管控。

「SSH 登录安全 / 安全基线 / 端口与进程 / 登录审计」四个功能既能管受管主机，也能管
面板自己所在的那台机器 —— 但走的是完全不同的两条路：

* **受管主机**：登记在 ``ssh_hosts`` 里，带凭据、带归属，走 SSH；
* **本机**：不走 SSH，直接读 ``/var/log/secure``、``/proc``，跑 ``ss -tulpn``、
  ``last`` / ``lastb``，改 sshd 配置与 fail2ban 策略。

**本机默认不管控，必须由用户显式导入**，原因有两条：

1. 上面那串动作需要面板进程有相当高的权限（能读宿主机日志、能改认证配置）。
   用户没明确要，就不该默认打开 —— 尤其是面板本身就跑在公网可及的服务器上时。
2. 容器化部署下面板根本读不到宿主机的日志与 ``/proc``，默认开启只会给出一堆
   「取不到数据」的假象，反而让人以为功能坏了。

状态存在 ``settings`` 表的 ``local_host`` 键里（JSON），导入只是打开开关：
**不涉及任何凭据**，因为本机是直接读文件，不走 SSH。读不到或解析失败一律按
「未导入」处理 —— 与数据库出问题时的安全方向一致。

这个模块被 ``sshremote`` / ``baseline`` / ``portguard`` / ``hostaudit`` 与
``hostscope`` 共用，所以它**只依赖 store**，不要在这里引入更上层的东西，
否则会和 ``hostscope`` 形成循环导入。
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict

from . import store

logger = logging.getLogger(__name__)

#: settings 表里的键名
SETTING_KEY = "local_host"

_UNSET: Dict[str, Any] = {"enabled": False, "by": "", "at": 0, "container": False}


def in_container() -> bool:
    """面板是不是跑在容器里（Docker / Podman / containerd / LXC / nspawn）。

    容器里「本机管控」是没有意义的：读到的 ``/var/log``、``/proc``、``ss`` 输出
    都是**容器自己**的，不是宿主机的。所以这个信号用来**不再提示用户导入本机**，
    免得把一个用不起来的开关摆在一个用不了的场景里。

    三个独立信号，任一命中即可 —— 单看某一个都不可靠：
    ``/.dockerenv``（Docker 一直会建）、``container`` 环境变量（nspawn 与部分
    编排平台会设）、``/proc/1/cgroup`` 里的容器字样（cgroup v2 下 Docker 的标记
    会变弱，但 containerd / kubepods / lxc 仍会写）。
    """
    if os.path.exists("/.dockerenv"):
        return True
    if os.environ.get("container"):
        return True
    try:
        with open("/proc/1/cgroup", "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read().lower()
    except OSError:
        return False
    return any(
        mark in text
        for mark in ("docker", "containerd", "kubepods", "podman", "lxc", "buildkit")
    )


async def state() -> Dict[str, Any]:
    """本机的管控状态。读不到 / 解析失败都按「未导入」处理。"""
    try:
        raw = await store.get_setting(SETTING_KEY)
    except Exception:  # noqa: BLE001 - 数据库抖动不该让安全功能整体报错
        logger.exception("读取本机管控状态失败，按未导入处理")
        return dict(_UNSET)
    if not raw:
        return dict(_UNSET)
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("settings.local_host 不是合法 JSON，按未导入处理")
        return dict(_UNSET)
    if not isinstance(data, dict):
        return dict(_UNSET)
    try:
        at = int(data.get("at") or 0)
    except (TypeError, ValueError):
        at = 0
    return {
        "enabled": bool(data.get("enabled")),
        "by": str(data.get("by") or ""),
        "at": at,
        "container": in_container(),
    }


async def enabled() -> bool:
    """本机是否已被用户导入。

    四个聚合流程（``baseline.targets`` / ``baseline.fleet_reports`` /
    ``portguard.fleet_reports`` / ``sshremote.fleet_reports`` /
    ``hostaudit.host_rows``）的准入判断都走这里，这样「本机算不算目标」
    只有这一个真值来源。
    """
    return bool((await state()).get("enabled"))


async def enable(by: str = "") -> Dict[str, Any]:
    """导入本机（幂等）。``by`` 只是审计用的操作者名字。"""
    data = {"enabled": True, "by": str(by or "")[:64], "at": int(time.time())}
    await store.set_setting(SETTING_KEY, json.dumps(data, ensure_ascii=False))
    logger.info("面板本机已导入安全管控（操作者：%s）", data["by"] or "未知")
    return data


async def disable() -> Dict[str, Any]:
    """移出本机。**不删除任何数据** —— 已入库的审计事件留着，只是不再采集。"""
    data = {"enabled": False, "by": "", "at": int(time.time())}
    await store.set_setting(SETTING_KEY, json.dumps(data, ensure_ascii=False))
    logger.info("面板本机已移出安全管控")
    return data
