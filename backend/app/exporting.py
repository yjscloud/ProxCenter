"""CSV 导出：把审计日志 / 任务队列 / 资产清单 / 告警历史导成能直接进 Excel 的表。

为什么要走后端流式导出
----------------------
审计日志这类表是「只追加、不删除」的，几十万行是常态；前端拿到的那一页只有
50 条，拿它导出对合规归档没有意义。这里按**键集分页**（``WHERE id < ?``）在
服务端边读边吐，内存占用与总行数无关，也不会像 ``OFFSET`` 那样越翻越慢。

三个必须处理的细节
------------------
1. **BOM**：Excel（尤其 Windows 版）见到 UTF-8 的中文 CSV 若没有 ``\\ufeff``
   开头，会按本地编码（GBK）解析，整张表变乱码。前端现有那份导出也是这么做的。
2. **公式注入**：对象名、标签、描述都是用户可填的，而 ``=cmd|'/c calc'!A1``
   这类内容的单元格会被 Excel 当公式执行。导出文件通常还会被转发给同事双击
   打开 —— 等于把注入点从面板搬到了别人的办公机上。因此所有以
   ``= + - @ Tab CR`` 开头的单元格都要加前缀撇号转成纯文本。
3. **中断可见**：流已经开始吐字节之后就没法再改 HTTP 状态码了。若中途读库失败，
   不能静默截断（拿到的半张表看起来和「数据就这么多」一模一样），必须往末尾
   补一行显式说明。
"""
from __future__ import annotations

import logging
from typing import Any, AsyncIterator, Iterable, Optional, Sequence
from urllib.parse import quote

from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

CSV_MEDIA_TYPE = "text/csv; charset=utf-8"

# UTF-8 BOM：没有它 Excel 会把中文按 GBK 解，整表乱码
BOM = "\ufeff"

# RFC 4180 用 CRLF；Excel 对它最友好
LINE_END = "\r\n"

# 单次导出的行数上限。审计表可以很大，但没人会去翻 200 万行的表，而一次拖走
# 全部数据会长时间占住连接与内存。到顶后追加一行说明，让调用方知道被截断了。
DEFAULT_MAX_ROWS = 200_000

# 每批从库里取多少行
DEFAULT_BATCH = 2_000

# 会被 Excel / WPS 当作公式起始的字符
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")

# 需要加引号的字符：分隔符与引号本身；另外首尾空格不引号会被吃掉
_QUOTE_NEEDED = (",", '"')


def safe_cell(value: Any) -> str:
    """把任意值转成 CSV 安全的单元格文本。"""
    if value is None:
        return ""
    text = value if isinstance(value, str) else str(value)
    # 换行会把 Excel 里的一行拆成两行，统一压成空格
    if "\n" in text or "\r" in text:
        text = text.replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
    if text[:1] in _FORMULA_PREFIXES:
        # 前缀撇号：Excel 会把它当「后面是文本」的标记，不再当公式求值
        text = "'" + text
    return text


def encode_row(cells: Iterable[Any]) -> str:
    """编码一行 CSV（含行尾）。"""
    encoded = []
    for cell in cells:
        text = safe_cell(cell)
        if any(ch in text for ch in _QUOTE_NEEDED) or text != text.strip():
            text = '"' + text.replace('"', '""') + '"'
        encoded.append(text)
    return ",".join(encoded) + LINE_END


def _deep_quote_char(value: str) -> str:
    """去掉文件名里不能出现在头部的字符（引号、反斜杠、控制字符）。"""
    return "".join(ch for ch in value if ch.isprintable() and ch not in '"\\')


def content_disposition(filename: str, ascii_filename: Optional[str] = None) -> str:
    """同时给出 ASCII 回退名与 RFC 5987 的 UTF-8 名。

    ASCII 名不能靠「把中文删掉」得到：``审计日志-20260926.csv`` 删完只剩
    ``-20260926.csv``，老客户端看到的就是这么个莫名其妙的名字。所以由调用方
    显式给一个英文名（``audit-log-20260926.csv``）。
    """
    safe = _deep_quote_char(filename)
    fallback = _deep_quote_char(ascii_filename or "") or "export.csv"
    return (
        f'attachment; filename="{fallback}"; '
        f"filename*=UTF-8''{quote(safe, safe='')}"
    )


def csv_attachment(
    *,
    filename: str,
    header: Sequence[str],
    rows: AsyncIterator[Sequence[Any]],
    ascii_filename: Optional[str] = None,
    max_rows: int = DEFAULT_MAX_ROWS,
) -> StreamingResponse:
    """把一组异步行拼成 CSV 附件流。

    ``rows`` 由各数据源自己的流式查询提供（见 ``store.stream_audit`` /
    ``alerting.stream_history`` 等），这里只负责编码与收尾。
    """

    async def generate() -> AsyncIterator[str]:
        yield BOM + encode_row(header)
        emitted = 0
        truncated = False
        try:
            async for row in rows:
                if emitted >= max_rows:
                    truncated = True
                    break
                yield encode_row(row)
                emitted += 1
        except Exception:  # noqa: BLE001 - 流已开始，只能把失败写进文件
            logger.exception("导出 %s 时中断", filename)
            yield encode_row(
                [f"（导出中途出错，以上 {emitted} 行可能不完整，请重试或缩小范围）"]
            )
            return

        if truncated:
            yield encode_row(
                [
                    f"（已达到单次导出上限 {max_rows} 行，其余数据未导出；"
                    "请缩小时间范围或筛选条件后分批导出）"
                ]
            )

    return StreamingResponse(
        generate(),
        media_type=CSV_MEDIA_TYPE,
        headers={
            "Content-Disposition": content_disposition(filename, ascii_filename),
            # 让反代不要缓存导出结果（内容随筛选条件变化，且含敏感数据）
            "Cache-Control": "no-store",
        },
    )
