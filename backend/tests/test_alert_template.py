"""告警通知模板：按用户存储、变量替换、邮件与飞书两条通道的接入。

模板是**给人写文案**用的，所以用例盯两件事：
* 写进去、读出来不变形（含只改一部分时其余字段保持内置）；
* 渲染后的内容确实替换掉了内置文案 —— 否则用户改了模板却什么都没变，
  这种「静默不生效」比报错更难查。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import alerting, database, notifications, store  # noqa: E402


async def _shutdown_pool(coro):
    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_shutdown_pool(coro))


@pytest.fixture()
def db(clean_mysql_db):
    """只建表、不启动 app（模板存在通用 settings 表里，告警历史表顺带建好）。"""
    _run(store.init_db())
    _run(alerting.init_table())
    _run(notifications.init_table())
    yield


def test_template_is_stored_per_user(db) -> None:
    _run(
        alerting.save_alert_template(
            {
                "enabled": True,
                "subject": "主题",
                "body": {"mem": "内存正文", "cpu": "CPU正文"},
                "feishu": {"mem": "内存卡片", "cpu": "CPU卡片"},
            },
            "alice",
        )
    )
    loaded = _run(alerting.load_alert_template("alice"))
    assert loaded["enabled"] is True
    assert loaded["subject"] == "主题"
    # 按指标分页签存储；没写的页签是空串（回落内置文案），"*" 兜底页签保留
    assert loaded["body"]["mem"] == "内存正文"
    assert loaded["body"]["cpu"] == "CPU正文"
    assert loaded["body"]["disk"] == ""
    assert loaded["body"]["*"] == ""
    assert loaded["feishu"]["mem"] == "内存卡片"
    # 别人的模板不受影响：文案是个人偏好，不是面板级配置
    assert _run(alerting.load_alert_template("bob"))["enabled"] is False


def test_legacy_string_body_spreads_to_all_metric_tabs(db) -> None:
    """旧格式（整段字符串）读取时平铺到每个页签，再按指标分别改写。"""
    _run(
        alerting.save_alert_template(
            {"enabled": True, "subject": "", "body": "旧正文", "feishu": "旧卡片"},
            "carol",
        )
    )
    loaded = _run(alerting.load_alert_template("carol"))
    assert loaded["body"]["mem"] == "旧正文"
    assert loaded["body"]["cpu"] == "旧正文"
    assert loaded["body"]["disk"] == "旧正文"
    assert loaded["body"]["*"] == "旧正文"


def test_saving_metric_tabs_keeps_fallback_section(db) -> None:
    """前端只传五个指标页签时，"*" 兜底页签沿用库里现值，不被静默清空。"""
    _run(
        alerting.save_alert_template(
            {"enabled": True, "subject": "", "body": "旧正文", "feishu": ""},
            "dave",
        )
    )
    _run(
        alerting.save_alert_template(
            {
                "enabled": True,
                "subject": "",
                "body": {"mem": "新内存正文", "cpu": "", "disk": "", "offline": "", "backup": ""},
                "feishu": {},
            },
            "dave",
        )
    )
    loaded = _run(alerting.load_alert_template("dave"))
    assert loaded["body"]["mem"] == "新内存正文"
    # "*" 沿用旧值：端口 / SSH 等来源继续用它
    assert loaded["body"]["*"] == "旧正文"
    assert loaded["body"]["cpu"] == ""


def test_dispatch_picks_template_section_by_metric(db, monkeypatch) -> None:
    """CPU 告警用 CPU 页签的模板渲染，内存告警用内存页签的，互不串台。"""
    _run(
        alerting.save_alert_template(
            {
                "enabled": True,
                "subject": "",
                "body": {"cpu": "这是CPU模板 {value}", "mem": "这是内存模板 {value}"},
                "feishu": {"cpu": "CPU卡片 {value}", "mem": "内存卡片 {value}"},
            },
            "admin",
        )
    )
    sent: List[Any] = []

    async def fake_mail(owner, title, text):
        sent.append(("mail", text))
        return True, "已发送"

    async def fake_feishu(card, owner):
        # 页签留空回落内置卡片时，首元素是字段 div（没有 text.content）
        sent.append(
            ("feishu", card["elements"][0].get("text", {}).get("content"))
        )
        return True, "已发送"

    monkeypatch.setattr(alerting, "send_alert_email", fake_mail)
    monkeypatch.setattr(alerting, "send_feishu", fake_feishu)
    card = alerting.build_card("warning", "t", "r", [], "note")

    def run_once(metric_key):
        sent.clear()
        _run(
            alerting.dispatch(
                "admin",
                {"enabled": True},
                {"enabled": True},
                "t",
                "内置正文",
                card,
                context={
                    "metric_key": metric_key,
                    "metric": "x",
                    "value": "50.0",
                },
            )
        )

    # dispatch 先发飞书再发邮件，顺序按实现来
    run_once("cpu")
    assert sent == [("feishu", "CPU卡片 50.0"), ("mail", "这是CPU模板 50.0")]
    run_once("mem")
    assert sent == [("feishu", "内存卡片 50.0"), ("mail", "这是内存模板 50.0")]
    # 没写对应页签 → 回落 "*"；"*" 也空 → 回落内置文案 / 内置卡片
    run_once("disk")
    assert sent == [("feishu", None), ("mail", "内置正文")]


def test_render_keeps_unknown_placeholders() -> None:
    """拼错的变量原样留着，好让人一眼看出问题。"""
    text = "{kind}：{target}，内存 {used}/{total}（{value}%），{typo}"
    out = alerting.render_alert_template(
        text,
        {
            "kind": "虚拟机",
            "target": "web-1",
            "used": "12.3 GB",
            "total": "16.0 GB",
            "value": "88.0",
        },
    )
    assert out == "虚拟机：web-1，内存 12.3 GB/16.0 GB（88.0%），{typo}"


def test_render_blank_for_empty_value() -> None:
    """变量为 None 时整行省略，而不是留下「节点=」这种空心行。"""
    assert alerting.render_alert_template("节点={node}", {"node": None}) == ""


def test_render_drops_lines_whose_variables_are_all_empty() -> None:
    """CPU 告警里照抄内存告警的模板：内存 / 磁盘行整行省略，其余照常渲染。

    这对应自定义模板最常见的翻车现场 —— 通知里出现「内存： /」
    「内存使用率： %（阈值 70.0%）」「状态：」一排空心字段。
    """
    text = (
        "{kind}：{target}（VMID {vmid}）\n"
        "节点：{node}\n"
        "内存：{used} / {total}\n"
        "{metric}：{value}%（阈值 {threshold}%）\n"
        "状态：{status}　IP：{ip}\n"
        "规则：{rule}\n"
        "时间：{time}"
    )
    out = alerting.render_alert_template(
        text,
        {
            "kind": "虚拟机",
            "target": "test",
            "vmid": "121",
            "node": "pve",
            "metric": "CPU 使用率",
            "value": "92.3",
            "threshold": "70",
            "used": "",
            "total": "",
            "status": "",
            "ip": "172.16.149.44",
            "rule": "虚拟机CPU告警",
            "time": "2026-10-25 21:26:53",
        },
    )
    assert out == (
        "虚拟机：test（VMID 121）\n"
        "节点：pve\n"
        "CPU 使用率：92.3%（阈值 70%）\n"
        "状态：　IP：172.16.149.44\n"
        "规则：虚拟机CPU告警\n"
        "时间：2026-10-25 21:26:53"
    )


def test_render_keeps_line_when_only_some_variables_are_empty() -> None:
    """「状态：{status}　IP：{ip}」里 status 空但 ip 有值：行保留，不误伤。"""
    out = alerting.render_alert_template(
        "状态：{status}　IP：{ip}", {"status": "", "ip": "10.0.0.5"}
    )
    assert out == "状态：　IP：10.0.0.5"


def test_metric_capacity_only_for_memory_and_disk() -> None:
    res = {"mem": 12 * 1024 ** 3, "maxmem": 16 * 1024 ** 3}
    assert alerting._metric_capacity(res, "mem") == ("12.0 GB", "16.0 GB")
    # CPU 的「已用」是占比，换算成 GB 只会误导
    assert alerting._metric_capacity({"cpu": 0.8}, "cpu") == ("", "")


def test_dispatch_uses_template_for_mail_and_feishu(db, monkeypatch) -> None:
    _run(
        alerting.save_alert_template(
            {
                "enabled": True,
                "subject": "【{kind}】{target} {metric} {value}%",
                "body": "虚拟机：{target}\n内存：{used} / {total}\n使用率：{value}%",
                "feishu": "**{target}** {metric} {value}%（{used}/{total}）",
            },
            "admin",
        )
    )

    sent: List[Any] = []

    async def fake_mail(owner, title, text):
        sent.append(("mail", owner, title, text))
        return True, "已发送"

    async def fake_feishu(card, owner):
        sent.append(("feishu", owner, card))
        return True, "已发送"

    monkeypatch.setattr(alerting, "send_alert_email", fake_mail)
    monkeypatch.setattr(alerting, "send_feishu", fake_feishu)

    card = alerting.build_card("warning", "内置标题", "规则", [("a", "b")], "12:00 触发")
    ok, _ = _run(
        alerting.dispatch(
            "admin",
            {"enabled": True},
            {"enabled": True},
            "内置标题",
            "内置正文",
            card,
            context={
                "level": "alarm",
                "kind": "虚拟机",
                "target": "web-1",
                "target_type": "vm",
                "metric": "内存",
                "value": "88.0",
                "threshold": "85",
                "used": "12.3 GB",
                "total": "16.0 GB",
            },
        )
    )
    assert ok

    channel, owner, title, text = next(item for item in sent if item[0] == "mail")
    assert (channel, owner) == ("mail", "admin")
    assert title == "【虚拟机】web-1 内存 88.0%"
    assert "内存：12.3 GB / 16.0 GB" in text
    assert "内置正文" not in text

    out_card = next(item for item in sent if item[0] == "feishu")[2]
    assert out_card["header"] == card["header"], "标题与配色保留内置的"
    assert out_card["elements"][0]["text"]["content"] == "**web-1** 内存 88.0%（12.3 GB/16.0 GB）"
    assert out_card["elements"][-1]["tag"] == "note", "页脚的触发时间不该被模板吃掉"


def test_preview_uses_editing_config(db, monkeypatch) -> None:
    """「发送测试」用**编辑中**（还没保存）的模板，变量要换样例值。"""
    sent: List[Any] = []

    async def fake_mail(owner, title, text):
        sent.append(("mail", title, text))
        return True, "已发送"

    async def fake_feishu(card, owner):
        sent.append(("feishu", card))
        return True, "已发送"

    monkeypatch.setattr(alerting, "send_alert_email", fake_mail)
    monkeypatch.setattr(alerting, "send_feishu", fake_feishu)

    ok, _ = _run(
        alerting.test_template(
            {
                "enabled": True,
                "subject": "【{kind}】{target}",
                "body": "虚拟机：{target}\n内存：{used} / {total}",
                "feishu": "",
            },
            "admin",
        )
    )
    assert ok
    _, title, text = next(item for item in sent if item[0] == "mail")
    assert "web-1" in title and "{target}" not in title
    assert "12.3 GB / 16.0 GB" in text
    # 飞书那格留空 → 卡片保持内置字段样式（只换正文，不动结构）
    card = next(item for item in sent if item[0] == "feishu")[1]
    assert card["elements"][0]["tag"] == "div"


def test_preview_ignores_channel_switches(db, monkeypatch) -> None:
    """通道开关关着也要发：点「测试」就是想看效果，被开关拦下会被当成模板没生效。"""
    calls: List[str] = []

    async def fake_mail(owner, title, text):
        calls.append("mail")
        return True, "已发送"

    async def fake_feishu(card, owner):
        calls.append("feishu")
        return True, "已发送"

    monkeypatch.setattr(alerting, "send_alert_email", fake_mail)
    monkeypatch.setattr(alerting, "send_feishu", fake_feishu)

    ok, _ = _run(
        alerting.test_template(
            {"enabled": False, "subject": "", "body": "", "feishu": ""}, "admin"
        )
    )
    assert ok
    assert calls == ["feishu", "mail"]


def test_preview_reports_missing_channels(db, monkeypatch) -> None:
    """一个通道都没配时如实报错，而不是假装成功。"""
    ok, detail = _run(
        alerting.test_template(
            {"enabled": True, "subject": "s", "body": "b", "feishu": "f"}, "admin"
        )
    )
    assert ok is False
    assert detail.strip(), "失败必须带原因，否则用户无从下手"


def test_dispatch_without_template_keeps_builtin(db, monkeypatch) -> None:
    """没启用模板时逐字用调用方渲染好的文案，升级后行为不变。"""
    sent: List[Any] = []

    async def fake_mail(owner, title, text):
        sent.append((title, text))
        return True, "已发送"

    async def fake_feishu(card, owner):
        return True, "已发送"

    monkeypatch.setattr(alerting, "send_alert_email", fake_mail)
    monkeypatch.setattr(alerting, "send_feishu", fake_feishu)

    _run(
        alerting.dispatch(
            "admin",
            {"enabled": False},
            {"enabled": True},
            "内置标题",
            "内置正文",
            alerting.build_card("warning", "内置标题", "规则", [], "note"),
        )
    )
    assert sent == [("内置标题", "内置正文")]
