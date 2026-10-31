/* ==========================================================================
   ProxCenter — i18n 一致性检查

   四件事，任一不满足就 exit 1：

   1. 英文表不能缺词条 —— 缺了会静默回退中文，英文界面里混中文最难发现；
   2. 英文表不能有多余的键 —— 拼错键名时不会报错，只会永远不生效；
   3. 代码里 `t('...')` 用到的键必须在中文表里存在（防拼写错误）；
   4. 后端 MESSAGES 的每条消息都要有 zh-CN 与 en 两份；
   5. 词条里的 `{占位符}` 必须在调用处都传了值 —— 少传一个，界面上就会原样
      显示 `{to}` 这种字符串（插值实现刻意保留占位符，方便一眼看出漏传，
      但它只有被看见时才有用）。这一项用 TypeScript AST 解析，不用正则：
      参数对象里出现嵌套 `t()` 或换行时正则很容易截断。

   为什么放进 CI：双语一定会漂移 —— 新增文案时最容易只写中文那份。
   让漏翻在 CI 里直接红掉，比在评审里靠人盯可靠得多。

   噪声控制：第 3 项只检查「形如 a.b 的键」（含点号），这样不会把
   `t(x)`、`t(变量)` 或某个恰好叫 t 的局部函数误判成词条引用。
   ========================================================================== */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const ZH_FILE = 'src/i18n/locales/zh-CN.ts';
const EN_FILE = 'src/i18n/locales/en.ts';
const BACKEND_I18N = 'backend/app/i18n.py';

const failures = [];

/** 从词条文件里提取扁平键（`  'a.b': '...'` 形式）。 */
function messageKeys(file) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const keys = new Set();
  for (const match of source.matchAll(/^\s*'([a-zA-Z][\w.-]*)':/gm)) {
    keys.add(match[1]);
  }
  return keys;
}

const zhKeys = messageKeys(ZH_FILE);
const enKeys = messageKeys(EN_FILE);

/* ---- 1 / 2：两表对齐 ---- */
const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key));
const extraInEn = [...enKeys].filter((key) => !zhKeys.has(key));

if (missingInEn.length) {
  failures.push(
    `英文表缺少 ${missingInEn.length} 条词条（会回退成中文）：\n` +
      missingInEn.map((key) => `    - ${key}`).join('\n'),
  );
}
if (extraInEn.length) {
  failures.push(
    `英文表有 ${extraInEn.length} 个中文表里不存在的键（拼错了？）：\n` +
      extraInEn.map((key) => `    - ${key}`).join('\n'),
  );
}

/* ---- 3：代码里引用的键必须存在 ---- */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const referenced = new Map(); // key -> [文件]
for (const file of walk(join(ROOT, 'src'))) {
  // 词条文件本身不参与（里面是定义，不是引用）
  const rel = relative(ROOT, file);
  if (rel === ZH_FILE || rel === EN_FILE) continue;

  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z][\w-]*\.[\w.]+)'/g)) {
    const key = match[1];
    if (!referenced.has(key)) referenced.set(key, []);
    referenced.get(key).push(rel);
  }
}

const unknownKeys = [...referenced.entries()].filter(([key]) => !zhKeys.has(key));
if (unknownKeys.length) {
  failures.push(
    `代码里引用了 ${unknownKeys.length} 个不存在的词条键：\n` +
      unknownKeys
        .map(([key, files]) => `    - ${key}（${files[0]}${files.length > 1 ? ` 等 ${files.length} 处` : ''}）`)
        .join('\n'),
  );
}

/* ---- 4：后端消息表两语齐全 ---- */
const backendSource = readFileSync(join(ROOT, BACKEND_I18N), 'utf8');
const messageBlock = backendSource.slice(
  backendSource.indexOf('MESSAGES:'),
  backendSource.indexOf('def t('),
);
const backendKeys = [...messageBlock.matchAll(/^\s{4}"([\w.]+)":\s*\{/gm)].map((m) => m[1]);
const backendBroken = backendKeys.filter((key) => {
  const start = messageBlock.indexOf(`"${key}":`);
  const chunk = messageBlock.slice(start, start + 600);
  return !chunk.includes('"zh-CN"') || !chunk.includes('"en"');
});
if (backendBroken.length) {
  failures.push(
    `后端 MESSAGES 有 ${backendBroken.length} 条消息缺语言：\n` +
      backendBroken.map((key) => `    - ${key}`).join('\n'),
  );
}

/* ---- 5：词条占位符必须都传了值 ---- */
const zhText = readFileSync(join(ROOT, ZH_FILE), 'utf8');

/* 词条值都是单引号字符串（可能多行用 + 拼接）：把同一个键的片段拼起来再找 {name}。
   注意占位符只认 ASCII 标识符，`{变量}` 这类说明性文本不会被误当成占位符。 */
const placeholders = new Map();
const phraseRe = /'([a-zA-Z][\w.-]*)':\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)/g;
for (const match of zhText.matchAll(phraseRe)) {
  const key = match[1];
  const text = [...match[2].matchAll(/'(?:[^'\\]|\\.)*'/g)]
    .map((m) => m[0].slice(1, -1))
    .join('');
  const found = new Set([...text.matchAll(/\{([A-Za-z_]\w*)\}/g)].map((m) => m[1]));
  if (found.size) placeholders.set(key, found);
}

/* 注释换成等长空格（保留换行与下标）：参数对象里常有行注释和块注释，
   注释里的反引号会让字符串状态错乱、带逗号的注释会把两个键并成一段，
   两者都会把「其实传了」的参数误判成漏传。 */
function stripComments(src) {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        i += 1;
        out += src[i] ?? '';
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      out += '\n';
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/* 从 '(' 开始找配对的 ')'：跳过字符串字面量，按括号深度计数 */
function callArgs(source, openIndex) {
  let depth = 0;
  let start = -1;
  let quote = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') {
      depth += 1;
      if (depth === 1) start = i + 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i);
    }
  }
  return '';
}

/* 取参数对象顶层的属性名（简写与 key: value 都算）；参数不是字面量对象时返回 null */
function objectKeys(argText) {
  const text = argText.trim();
  if (!text.startsWith('{')) return null;
  const body = text.slice(1, text.lastIndexOf('}'));
  const keys = [];
  let seg = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      seg += ch;
      if (ch === '\\') {
        i += 1;
        seg += body[i] ?? '';
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('{[('.includes(ch)) depth += 1;
    else if ('}])'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      keys.push(seg);
      seg = '';
      continue;
    }
    seg += ch;
  }
  keys.push(seg);
  return keys
    .map((piece) => piece.trim())
    .filter(Boolean)
    .map((piece) => {
      const m = piece.match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/);
      return m ? m[1] : null;
    })
    .filter(Boolean);
}

const missingArgs = [];
for (const file of walk(join(ROOT, 'src'))) {
  const rel = relative(ROOT, file);
  if (rel === ZH_FILE || rel === EN_FILE) continue;
  const source = stripComments(readFileSync(file, 'utf8'));

  for (const match of source.matchAll(/\bt\(\s*'/g)) {
    const args = callArgs(source, match.index + 1);
    if (!args) continue;
    const keyMatch = args.match(/^\s*'([a-zA-Z][\w.-]*)'/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    const need = placeholders.get(key);
    if (!need) continue;
    const rest = args.slice(keyMatch[0].length).replace(/^\s*,/, '');
    if (!rest.trim()) {
      missingArgs.push([rel, key, [...need]]);
      continue;
    }
    const given = objectKeys(rest);
    if (!given) continue; // 动态传参，例如 t(key, vars)
    const lack = [...need].filter((name) => !given.includes(name));
    if (lack.length) missingArgs.push([rel, key, lack]);
  }
}

if (missingArgs.length) {
  failures.push(
    `有 ${missingArgs.length} 处 t() 少传了占位符（界面上会原样显示 {xxx}）：\n` +
      missingArgs
        .slice(0, 20)
        .map(([file, key, lack]) => `    - ${file} → ${key} 缺 ${lack.join(', ')}`)
        .join('\n'),
  );
}

/* ---- 结果 ---- */
if (failures.length) {
  console.error('✗ i18n 检查未通过：\n');
  failures.forEach((text) => console.error(`${text}\n`));
  process.exit(1);
}

const used = [...referenced.keys()].length;
console.log(
  `✓ i18n 一致：中文 ${zhKeys.size} 条 / 英文 ${enKeys.size} 条，` +
    `代码引用 ${used} 个键，后端消息 ${backendKeys.length} 条`,
);
