"""面板更新：版本比较、发布信息解析、更新前置条件与接口回归。

被测的关键控制：

* 版本比较按**数字段**来（``0.1.10`` 比 ``0.1.9`` 新，字符串比较会得出反的结论），
  且 ``v`` 前缀、``-rc1`` 后缀、解析不出数字的垃圾值都不能把它带跑；
* 「能不能一键更新」要逐条挡住：容器、非 git 工作区、**不是 systemd 托管的进程**
  （手工起的实例重启的是另一个进程，代码根本不换）、非 root、没有 Node
  （构建不了前端 → 后端换了界面没换）、工作区有未提交改动、已有更新在跑；
* 检查失败（404 / 限额 / 非 JSON）要落成一句人话写进 ``error``，而不是抛异常 ——
  定时作业不该因为一次网络抖动就变成红色错误；
* 接口：非管理员 403；检查成功会给管理员留一条站内消息（同一版本只发一次）；
  一键更新失败是 400 人话而不是 500。

接口用例**不会**真的更新面板：``apply`` 用例把 ``update.apply_update`` 换掉，
免得在「root + git + systemd」的开发机上跑测试时真把面板换掉。
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict

import httpx
import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import scheduler, store, update  # noqa: E402
from test_api_routes import api, auth_headers  # noqa: E402,F401


# ------------------------------------------------------------------ 道具
def _next_version() -> str:
    """当前版本的「下一个补丁版」—— 用例里的「新版本」由它推导。

    写死版本号会在下次发布后悄悄失效：`is_newer("0.1.5", "0.1.7")` 是 False，
    于是「检查到新版本」这条用例莫名其妙地挂掉（发布 0.1.7 时真踩到了）。
    """
    parts = list(update.parse_version(update.__version__)) or [0, 0, 0]
    parts = (parts + [0, 0, 0])[:3]
    parts[-1] += 1
    return ".".join(str(part) for part in parts)


NEXT_VERSION = _next_version()
NEXT_TAG = f"v{NEXT_VERSION}"

RELEASE = {
    "tag_name": NEXT_TAG,
    "name": NEXT_VERSION,
    "body": "修了几个导入的坑",
    "html_url": f"https://github.com/yjscloud/ProxCenter/releases/tag/{NEXT_TAG}",
    "published_at": "2026-10-06T00:00:00Z",
    "prerelease": False,
}


def _transport(payload: Any, status: int = 200, as_json: bool = True) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/releases/latest"), request.url
        if as_json:
            return httpx.Response(status, json=payload)
        return httpx.Response(status, text=str(payload), headers={"content-type": "text/html"})

    return httpx.MockTransport(handler)


def _dep(**over: Any) -> Dict[str, Any]:
    """一个「理论上可以一键更新」的部署形态，逐个用例改坏其中一项。"""
    base: Dict[str, Any] = {
        "form": "git",
        "root": "/srv/proxcenter",
        "service": "proxcenter.service",
        "managed": True,
        "is_root": True,
        "writable": True,
        "node": True,
        "systemd_run": True,
        "git": {
            "is_git": True,
            "remote": "git@github.com:yjscloud/ProxCenter.git",
            "branch": "main",
            "head": "abc1234",
            "tag": "",
            "dirty": False,
            "dirty_files": 0,
        },
    }
    base.update(over)
    return base


def _viewer_headers(panel, username: str = "updateviewer") -> Dict[str, str]:
    admin = auth_headers(panel)
    panel.post(
        "/api/users",
        json={"username": username, "password": "Unit-Test-Pa55word", "role": "viewer"},
        headers=admin,
    )
    resp = panel.post(
        "/api/auth/login", json={"username": username, "password": "Unit-Test-Pa55word"}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


# ------------------------------------------------------------------ 版本比较
class TestVersionCompare:
    def test_parses_prefix_and_suffix(self) -> None:
        assert update.parse_version("v0.1.4") == (0, 1, 4)
        assert update.parse_version("0.1.4-rc1") == (0, 1, 4)

    def test_unparsable_is_empty(self) -> None:
        assert update.parse_version("") == ()
        assert update.parse_version("dev") == ()
        assert update.parse_version(None) == ()

    def test_compares_numerically_not_as_text(self) -> None:
        # 字符串比较会认为 "0.1.10" < "0.1.9"，那是个只会偶尔发作的静默 bug
        assert update.is_newer("0.1.10", "0.1.9")
        assert not update.is_newer("0.1.9", "0.1.10")

    def test_missing_segments_count_as_zero(self) -> None:
        assert update.is_newer("0.2", "0.1.9")
        assert not update.is_newer("0.1", "0.1.0")

    def test_equal_or_unparsable_is_never_newer(self) -> None:
        assert not update.is_newer("v0.1.4", "0.1.4")
        assert not update.is_newer("", "0.1.4")
        assert not update.is_newer("0.1.5", "dev")


# ------------------------------------------------------------------ 发布信息
class TestFetchLatest:
    def test_parses_tag_version_and_notes(self) -> None:
        data = asyncio.run(
            update.fetch_latest("yjscloud/ProxCenter", transport=_transport(RELEASE))
        )
        assert data["tag"] == NEXT_TAG
        assert data["version"] == NEXT_VERSION
        assert data["notes"].startswith("修了")
        assert data["url"].endswith(f"/{NEXT_TAG}")

    def test_missing_release_is_explained(self) -> None:
        with pytest.raises(update.UpdateError) as excinfo:
            asyncio.run(
                update.fetch_latest("me/nope", transport=_transport({"message": "Not Found"}, 404))
            )
        assert "不存在" in str(excinfo.value)

    def test_rate_limit_is_explained(self) -> None:
        with pytest.raises(update.UpdateError) as excinfo:
            asyncio.run(
                update.fetch_latest("me/x", transport=_transport({"message": "rate"}, 403))
            )
        assert "限额" in str(excinfo.value)

    def test_html_body_is_explained(self) -> None:
        with pytest.raises(update.UpdateError):
            asyncio.run(
                update.fetch_latest("me/x", transport=_transport("<html/>", as_json=False))
            )

    def test_bad_slug_is_rejected_without_a_request(self) -> None:
        with pytest.raises(update.UpdateError):
            asyncio.run(update.fetch_latest("not-a-slug"))


# ------------------------------------------------------------------ 前置条件
class TestApplyGuards:
    def test_green_light(self) -> None:
        assert update._apply_ready(_dep(), {}) == (True, "")

    def test_docker_cannot_swap_its_own_image(self) -> None:
        ready, reason = update._apply_ready(_dep(form="docker"), {})
        assert not ready and "容器" in reason

    def test_unknown_installation_is_refused(self) -> None:
        """既不是 git 工作区、也不像源码包安装（缺 deploy.sh / package.json）→ 只给命令。

        （非 git 但结构完整的安装现在**可以**在线更新，见 TestArchiveUpdate。）
        """
        dep = _dep(form="other", git={"is_git": False, "root": "/srv/proxcenter"})
        ready, reason = update._apply_ready(dep, {})
        assert not ready and "手工升级" in reason

    def test_manual_instance_is_refused(self) -> None:
        """手工启动的实例：更新脚本最后重启的是 systemd 那个进程，代码不会生效。"""
        ready, reason = update._apply_ready(_dep(managed=False, service=""), {})
        assert not ready and "systemd" in reason

    def test_non_root_is_refused(self) -> None:
        ready, reason = update._apply_ready(_dep(is_root=False), {})
        assert not ready and "root" in reason

    def test_readonly_root_is_refused(self) -> None:
        ready, reason = update._apply_ready(_dep(writable=False), {})
        assert not ready and "不可写" in reason

    def test_missing_node_is_refused(self) -> None:
        """没有 Node 就构建不了前端：放行只会得到「后端换了、界面还是旧的」。"""
        ready, reason = update._apply_ready(_dep(node=False), {})
        assert not ready and "Node" in reason

    def test_no_remote_is_refused(self) -> None:
        git = dict(_dep()["git"], remote="")
        ready, reason = update._apply_ready(_dep(git=git), {})
        assert not ready and "origin" in reason

    def test_dirty_worktree_is_refused_unless_allowed(self) -> None:
        git = dict(_dep()["git"], dirty=True, dirty_files=3)
        dep = _dep(git=git)
        ready, reason = update._apply_ready(dep, {})
        assert not ready and "3" in reason
        assert update._apply_ready(dep, {}, allow_dirty=True)[0] is True

    def test_update_in_progress_is_refused(self) -> None:
        ready, reason = update._apply_ready(_dep(), {"tag": "v0.1.5"})
        assert not ready
        assert "v0.1.5" in reason


class TestManualCommands:
    def test_docker_uses_compose(self) -> None:
        lines = update.manual_commands(_dep(form="docker"))
        assert any("docker compose pull" in line for line in lines)

    def test_git_with_node_uses_deploy_sh(self) -> None:
        lines = update.manual_commands(_dep(), "v0.1.5")
        assert lines[-1] == "sudo ./deploy.sh"
        assert any("git checkout v0.1.5" in line for line in lines)

    def test_git_without_node_explains_skip_frontend(self) -> None:
        lines = update.manual_commands(_dep(node=False), "v0.1.5")
        assert lines[-1] == "sudo ./deploy.sh --skip-frontend"
        assert any("构建前端" in line for line in lines)


class TestUpdateScript:
    def test_every_step_is_checked_and_the_log_is_kept(self) -> None:
        log = Path("/srv/proxcenter/logs/update-20261006-120000.log")
        text = update._script_text(_dep(), "v0.1.5", log)
        assert f'exec >>"{log}" 2>&1' in text
        assert "git fetch --tags --prune origin" in text
        assert "git rev-parse --verify --quiet" in text
        assert 'git checkout "v0.1.5"' in text
        assert './deploy.sh --service "proxcenter.service"' in text
        # 刻意不用 set -e：失败时要把原因留在日志里，而不是静默退出
        assert "set -euo" not in text

    def test_local_changes_are_stashed_instead_of_clobbered(self) -> None:
        """开发机上工作区几乎总是脏的：更新必须先 stash，且不能再用 --force。

        ``--force`` 会把用户手里的改动直接覆盖掉；stash 之后 ``git stash pop`` 能原样
        找回，所以「点按钮就能更新」与「不丢东西」可以同时成立。
        """
        text = update._script_text(_dep(), "v0.1.5", Path("/tmp/x.log"))
        assert "git stash push -m \"proxcenter-update-v0.1.5\"" in text
        assert "git status --porcelain --untracked-files=no" in text
        # 关键：不再用 checkout --force（它会把本地改动直接覆盖掉）
        assert "checkout --force" not in text

    def test_home_and_path_are_defaulted_inside_the_script(self) -> None:
        """一次性 unit（systemd-run）里没有 HOME，而 deploy.sh 开了 set -u。

        实测报的是 ``deploy.sh: line 775: HOME: unbound variable``：脚本一进去就退出，
        依赖没装、服务没重启，界面却还显示「正在更新中」。所以脚本自己兜底，不依赖启动方。
        """
        text = update._script_text(_dep(), "v0.1.5", Path("/tmp/x.log"))
        assert 'export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"' in text
        assert 'export PATH="${PATH:-/usr/local/sbin:' in text

    def test_result_file_defaults_to_the_log_name(self) -> None:
        """结果文件让面板能立刻区分「还在跑」和「已经死了」，路径要能推出来。"""
        text = update._script_text(_dep(), "v0.1.5", Path("/srv/logs/update-x.log"))
        assert 'trap \'rc=$?; printf "code=%s' in text
        assert "/srv/logs/update-x.result" in text

    def test_tag_is_validated_before_it_reaches_shell(self) -> None:
        assert update._TAG_RE.match("v0.1.5")
        assert update._TAG_RE.match("v0.2.0-rc1")
        assert not update._TAG_RE.match("v0.1.5; rm -rf /")
        assert not update._TAG_RE.match("$(id)")
        assert not update._TAG_RE.match("")


class TestApplyingState:
    def test_finished_update_is_recorded_and_cleared(self) -> None:
        state: Dict[str, Any] = {
            "applying": {
                "tag": f"v{update.__version__}",
                "started_at": int(time.time()),
                "log": "/tmp/x.log",
            }
        }
        assert update._applying_state(state) == {}
        assert state["last_update"]["ok"] is True
        assert "applying" not in state

    def test_stuck_update_times_out(self) -> None:
        state: Dict[str, Any] = {
            "applying": {
                "tag": "v9.9.9",
                "started_at": int(time.time()) - update.APPLYING_TIMEOUT - 1,
            }
        }
        assert update._applying_state(state) == {}
        assert state["last_update"]["ok"] is False

    def test_recent_update_is_reported_as_running(self) -> None:
        state: Dict[str, Any] = {
            "applying": {"tag": "v9.9.9", "started_at": int(time.time())}
        }
        assert update._applying_state(state)["tag"] == "v9.9.9"

    def test_no_applying_field_is_empty(self) -> None:
        assert update._applying_state({}) == {}

    def test_failed_script_is_reported_at_once(self, tmp_path: Path) -> None:
        """脚本失败要立刻定性 —— 界面不该为此干等 30 分钟超时还显示「正在更新中」。"""
        result = tmp_path / "update.result"
        result.write_text("code=1\nat=1760000000\n", encoding="utf-8")
        state: Dict[str, Any] = {
            "applying": {
                "tag": "v9.9.9",
                "started_at": int(time.time()),
                "result": str(result),
            }
        }
        assert update._applying_state(state) == {}
        assert state["last_update"]["ok"] is False
        assert "applying" not in state

    def test_result_code_zero_does_not_fake_success(self, tmp_path: Path) -> None:
        """``code=0`` 只说明脚本跑完了：版本没换过来就还不能算成功。"""
        result = tmp_path / "update.result"
        result.write_text("code=0\nat=1760000000\n", encoding="utf-8")
        state: Dict[str, Any] = {
            "applying": {
                "tag": "v9.9.9",
                "started_at": int(time.time()),
                "result": str(result),
            }
        }
        assert update._applying_state(state)["tag"] == "v9.9.9"

    def test_missing_result_file_is_not_a_failure(self) -> None:
        """脚本刚启动、还没写结果文件 —— 不能当成失败。"""
        state: Dict[str, Any] = {
            "applying": {
                "tag": "v9.9.9",
                "started_at": int(time.time()),
                "result": "/nonexistent/update.result",
            }
        }
        assert update._applying_state(state)["tag"] == "v9.9.9"


# ------------------------------------------------------------------ 接口
def _fake_fetch(release: Dict[str, Any]):
    async def fetch(repo: str, *, transport: Any = None) -> Dict[str, Any]:
        tag = str(release.get("tag_name") or "")
        return {
            "tag": tag,
            "version": tag.lstrip("vV"),
            "name": str(release.get("name") or ""),
            "notes": str(release.get("body") or ""),
            "url": str(release.get("html_url") or ""),
            "published_at": str(release.get("published_at") or ""),
            "prerelease": False,
        }

    return fetch


class TestUpdateApi:
    def test_requires_settings_permission(self, api) -> None:  # noqa: F811
        viewer = _viewer_headers(api)
        assert api.get("/api/update/status", headers=viewer).status_code == 403
        assert api.post("/api/update/check", headers=viewer).status_code == 403
        assert (
            api.put("/api/update/settings", json={"auto_check": False}, headers=viewer).status_code
            == 403
        )
        assert api.post("/api/update/apply", json={}, headers=viewer).status_code == 403

    def test_status_reports_version_and_deployment(self, api) -> None:  # noqa: F811
        body = api.get("/api/update/status", headers=auth_headers(api)).json()
        assert body["current"] == update.__version__
        # 还没检查过：不该凭空说有新版本
        assert body["update_available"] is False
        assert body["deployment"]["form"] in {"git", "docker", "other"}
        assert isinstance(body["manual"], list) and body["manual"]
        assert body["can_apply"] is False
        assert body["reason"]

    def test_check_finds_new_release_and_notifies_admins(self, api, monkeypatch) -> None:  # noqa: F811
        headers = auth_headers(api)
        monkeypatch.setattr(update, "fetch_latest", _fake_fetch(RELEASE))
        body = api.post("/api/update/check", headers=headers).json()
        assert body["update_available"] is True
        assert body["latest"] == NEXT_VERSION
        assert body["error"] == ""
        items = api.get("/api/notifications", headers=headers).json()["items"]
        assert any(NEXT_VERSION in str(item.get("title") or "") for item in items)

    def test_same_version_is_notified_only_once(self, api, monkeypatch) -> None:  # noqa: F811
        headers = auth_headers(api)
        monkeypatch.setattr(update, "fetch_latest", _fake_fetch(RELEASE))
        api.post("/api/update/check", headers=headers)
        api.post("/api/update/check", headers=headers)
        items = api.get("/api/notifications", headers=headers).json()["items"]
        hits = [i for i in items if NEXT_VERSION in str(i.get("title") or "")]
        assert len(hits) == 1

    def test_check_failure_becomes_a_message_not_an_error(self, api, monkeypatch) -> None:  # noqa: F811
        headers = auth_headers(api)

        async def boom(repo: str, *, transport: Any = None) -> Dict[str, Any]:
            raise update.UpdateError("访问 GitHub 失败：网络不可达")

        monkeypatch.setattr(update, "fetch_latest", boom)
        body = api.post("/api/update/check", headers=headers).json()
        assert body["update_available"] is False
        assert "网络不可达" in body["error"]

    def test_skipping_a_version_hides_the_notice(self, api, monkeypatch) -> None:  # noqa: F811
        headers = auth_headers(api)
        monkeypatch.setattr(update, "fetch_latest", _fake_fetch(RELEASE))
        assert api.post("/api/update/check", headers=headers).json()["update_available"] is True
        body = api.put(
            "/api/update/settings",
            json={"skipped_version": NEXT_VERSION},
            headers=headers,
        ).json()
        assert body["skipped"] == NEXT_VERSION
        assert body["update_available"] is False

    def test_auto_check_can_be_turned_off(self, api) -> None:  # noqa: F811
        headers = auth_headers(api)
        assert api.get("/api/update/status", headers=headers).json()["auto_check"] is True
        body = api.put("/api/update/settings", json={"auto_check": False}, headers=headers).json()
        assert body["auto_check"] is False
        assert api.get("/api/update/status", headers=headers).json()["auto_check"] is False

    def test_apply_failure_is_400_with_a_reason(self, api, monkeypatch) -> None:  # noqa: F811
        async def boom(tag: str, *, allow_dirty: bool = False) -> Dict[str, Any]:
            raise update.UpdateError("当前进程不是 systemd 托管的")

        monkeypatch.setattr(update, "apply_update", boom)
        resp = api.post("/api/update/apply", json={}, headers=auth_headers(api))
        assert resp.status_code == 400
        assert "systemd" in resp.json()["detail"]

    def test_scheduler_job_is_registered(self, api) -> None:  # noqa: F811
        """自动检查挂在调度器上（间隔与启停可在「后台作业」页里改）。"""
        assert scheduler.is_registered("update_check")

    def test_finished_update_leaves_exactly_one_notification(self, api) -> None:  # noqa: F811
        """更新跑完要提醒一次 —— 脚本在面板之外跑完，这条消息只能由面板补。

        真实链路：脚本重启面板 → 面板下次读状态时发现版本已换，判定成功并写一条站内
        消息（见 app/update._announce_result）。这里直接把「已更新完」的状态塞进库里，
        验证提醒真的发出去、且只发一次。
        """
        headers = auth_headers(api)
        asyncio.run(
            store.set_setting(
                "update_state",
                json.dumps(
                    {
                        "latest": {"tag": "v0.9.9", "version": "0.9.9"},
                        "last_update": {
                            "tag": "v0.9.9",
                            "ok": True,
                            "at": 1760000000,
                            "log": "/tmp/update-x.log",
                        },
                    }
                ),
            )
        )
        body = api.get("/api/update/status", headers=headers).json()
        assert body["last_update"]["notified"] is True

        def hits() -> int:
            items = api.get("/api/notifications", headers=headers).json()["items"]
            return sum(1 for item in items if "0.9.9" in str(item.get("title") or ""))

        assert hits() == 1
        # 再读一次状态不该重复提醒
        api.get("/api/update/status", headers=headers)
        assert hits() == 1


def _archive_dep(**over: Any) -> Dict[str, Any]:
    """一个「从 Releases 下载源码包安装」的部署形态（目录里没有 .git）。"""
    dep = _dep(form="archive", git={"is_git": False, "root": "/srv/proxcenter"})
    dep["tools"] = {
        "download": "/usr/bin/curl",
        "tar": "/usr/bin/tar",
        "rsync": "/usr/bin/rsync",
    }
    dep.update(over)
    return dep


class TestArchiveUpdate:
    """源码包安装（没有 .git）也要能在面板里更新。

    以前这类安装只会得到一句「这个安装目录不是 git 工作区」，只能手工升级；现在走
    「下载目标 tag 的源码包 → rsync 覆盖（被替换的文件先备份）→ deploy.sh」，
    与 git 安装做的事完全一样。
    """

    def test_ready_when_everything_is_there(self) -> None:
        assert update._apply_ready(_archive_dep(), {}) == (True, "")

    def test_missing_tools_are_explained(self) -> None:
        ready, reason = update._apply_ready(
            _archive_dep(tools={"download": "", "tar": "", "rsync": ""}), {}
        )
        assert not ready
        for tool in ("download", "tar", "rsync"):
            assert tool in reason

    def test_manual_commands_download_the_tarball(self) -> None:
        text = "\n".join(
            update.manual_commands(_archive_dep(), "v0.1.8", "yjscloud/ProxCenter")
        )
        assert "https://github.com/yjscloud/ProxCenter/archive/refs/tags/v0.1.8.tar.gz" in text
        assert "rsync -a --delete" in text
        assert "sudo ./deploy.sh" in text

    def test_script_unpacks_and_backs_up_what_it_overwrites(self) -> None:
        log = Path("/srv/proxcenter/logs/update-20261006-120000.log")
        script = update._script_text(
            _archive_dep(), "v0.1.8", log, None, "yjscloud/ProxCenter"
        )
        assert "archive/refs/tags/v0.1.8.tar.gz" in script
        assert "tar -xzf" in script
        # 覆盖前先备份：源码包安装没有 git 可以 stash，改错了得能捞回来
        assert '--backup --backup-dir="/srv/proxcenter/logs/update-backup-20261006-120000"' in script
        # 配置 / 数据 / 日志 / 依赖与产物不能被动到
        for keep in ("backend/.env", "backend/data", "logs", "node_modules", "dist", ".venv"):
            assert keep in script
        # 这种安装没有 git：脚本里不该出现 git 命令（否则会白失败一次）
        assert "git fetch" not in script


class TestProgress:
    """更新进度：脚本自己打的 PROGRESS 标记 + deploy.sh 的分步标记。"""

    def test_reads_the_last_marker(self, tmp_path: Path) -> None:
        log = tmp_path / "u.log"
        log.write_text("PROGRESS 5 start\nnoise\nPROGRESS 12 fetch\n", encoding="utf-8")
        got = update._read_progress({"log": str(log)})
        assert got["percent"] == 12
        assert got["stage"] == "fetch"
        assert got["label"]

    def test_deploy_step_refines_the_percentage(self, tmp_path: Path) -> None:
        """装依赖 + 构建前端那一段最久，用 deploy.sh 自己的 [n/m] 把它细化。"""
        log = tmp_path / "u.log"
        log.write_text("PROGRESS 45 deploy\n==> [1/5] a\n==> [3/5] b\n", encoding="utf-8")
        assert update._read_progress({"log": str(log)})["percent"] == 75

    def test_build_and_restart_are_their_own_stages(self, tmp_path: Path) -> None:
        """「构建前端」与「重启服务」要分别显示 —— 一键更新必须自己做完这两件事。"""
        log = tmp_path / "u.log"
        log.write_text(
            "PROGRESS 45 deploy\n==> [3/5] Preparing the frontend build\n", encoding="utf-8"
        )
        build = update._read_progress({"log": str(log)})
        log.write_text(
            "PROGRESS 45 deploy\n==> [4/5] Installing the systemd service\n", encoding="utf-8"
        )
        restart = update._read_progress({"log": str(log)})
        assert build["percent"] == 75
        assert restart["percent"] == 85
        assert build["label"] != restart["label"]

    def test_no_marker_means_no_progress(self, tmp_path: Path) -> None:
        log = tmp_path / "u.log"
        log.write_text("[2026-10-06T22:40:05] 更新开始\n", encoding="utf-8")
        assert update._read_progress({"log": str(log)}) == {}

    def test_missing_log_is_empty(self) -> None:
        assert update._read_progress({"log": "/nonexistent/u.log"}) == {}


class TestGeneratedScriptSyntax:
    def test_both_forms_are_valid_bash(self, tmp_path: Path) -> None:
        """生成的脚本本身就是 shell 代码：语法错误只能靠 bash -n 提前拦住。"""
        for form, dep in (("git", _dep()), ("archive", _archive_dep())):
            script = tmp_path / f"{form}.sh"
            script.write_text(
                update._script_text(dep, "v0.1.8", tmp_path / "u.log", None, "o/r"),
                encoding="utf-8",
            )
            proc = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
            assert proc.returncode == 0, f"{form}: {proc.stderr}"
