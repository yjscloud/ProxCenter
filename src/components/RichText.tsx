import { Fragment, useMemo, type ReactNode } from 'react';

/**
 * AI 回答的正文渲染。
 *
 * 为什么需要它：模型爱写 `**加粗**`、`- 列表`、`` `命令` ``，而这段文字原先是
 * 直接塞进气泡的**纯文本** —— 记号原样显示，一屏灰字里夹着几个星号，读起来像
 * 日志而不像结论。提示词那边已经要求「不要 Markdown 装饰」，但那管的是**以后**
 * 的输出；历史会话里那些回答也得能读，所以渲染这层是必需的，提示词只是让它更
 * 少被用到。
 *
 * 只解析模型真正会用到的四种记号，其余一律当纯文本：
 * 段落（空行分隔）· `**粗体**` · 行内 `代码` · `- / 1.` 短列表。
 *
 * **刻意不解析 HTML**：整棵树是用 React 元素拼出来的，没有 dangerouslySetInnerHTML。
 * 这条边界不该为了「支持富文本」让给模型输出 —— 它要是回了
 * `<img src=x onerror=…>`，在我们这儿就只是屏幕上的几个字符而已。
 */

/**
 * 列表项：`- ` / `* ` / `+ `，以及 `1. ` / `1) `。
 *
 * 两个正则都刻意让**正文**落在按「记号有无」约定的那一个捕获组上：
 * bullet 用 ``[1]``（无记号组），ordered 用 ``[2]``（前一组是序号）。
 * 下面 `list.items.push(...)` 直接按这个下标取正文 —— 少一个组就会取到
 * ``undefined``，而 ``undefined.trim()`` 会让整页崩掉（历史上正是这么崩的）。
 */
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;

/**
 * 刻意拆成三个成员，而不是把 `'ul' | 'ol'` 塞在同一个成员里 —— 那样不是可判别
 * 联合，排查完 ul/ol 之后 TypeScript 收窄不回去，下面读 `block.lines` 会报错。
 */
type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] };

/**
 * 把一段回答切成块。
 *
 * 两个容易踩的地方：
 *
 * * **列表项会折行**。模型常把一条长项写成两行，第二行没有记号 —— 严格只认
 *   「每行都以记号开头」的话，这一块就退化成段落，两个 `-` 会原样露出来。所以
 *   走的是顺序扫描：遇到没有记号的行，若当前在列表里就并回上一项。
 * * **段落内的单换行要留住**。中文写作里单换行通常是有意的断句，不是排版折行，
 *   压成一行会让「结论」和「依据」黏在一起。
 */
function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push({ kind: 'p', lines: para });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push({ kind: list.kind, items: list.items });
      list = null;
    }
  };

  // 正文来自模型或落库的会话消息，历史数据里可能是 undefined/null：
  // 这里兜一下，别让一段缺失的文本把整页（ErrorBoundary）带崩。
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      // 空行是块边界：段落与列表都到此为止
      flushPara();
      flushList();
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flushPara();
      const kind = bullet ? 'ul' : 'ol';
      // 列表类型换了就收尾，否则「1. a」接「- b」会被串成一串
      if (list && list.kind !== kind) flushList();
      if (!list) list = { kind, items: [] };
      // 取「去掉记号后的正文」；万一正则改动导致组下标错位，退回整行而非崩页
      list.items.push((bullet ? bullet[1] : ordered![2] ?? line).trim());
      continue;
    }
    if (list) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushList();
  return out;
}

/** 段内记号：`代码` 与 **粗体**。函数内新建正则，避免模块级 `lastIndex` 被复用。 */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(
        <code key={`${keyBase}-c${index}`} className="ai-rich-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(
        <strong key={`${keyBase}-b${index}`}>{token.slice(2, -2)}</strong>,
      );
    }
    last = match.index + token.length;
    index += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * 渲染一段 AI 回答。
 *
 * 逐字流式期间也能用：未闭合的 `**` 会原样显示，闭合的那一刻自动变成粗体 ——
 * 比为了「不闪」而等整段结束再渲染要自然。
 */
export function RichText({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="ai-rich">
      {blocks.map((block, i) => {
        if (block.kind === 'ul' || block.kind === 'ol') {
          const Tag = block.kind;
          return (
            <Tag key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item, `${i}-${j}`)}</li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={i}>
            {block.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                {renderInline(line, `${i}-${j}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
