/* ==========================================================================
   ProxCenter — i18n 一致性检查

   四件事，任一不满足就 exit 1：

   1. 英文表不能缺词条 —— 缺了会静默回退中文，英文界面里混中文最难发现；
   2. 英文表不能有多余的键 —— 拼错键名时不会报错，只会永远不生效；
   3. 代码里 `t('...')` 用到的键必须在中文表里存在（防拼写错误）；
   4. 后端 MESSAGES 的每条消息都要有 zh-CN 与 en 两份。

   为什么放进 CI：双语一定会漂移 —— 新增文案时最容易只写中文那份。
   让漏翻在 CI 里直接红掉，比在评审里靠人盯可靠得多。

   噪声控制：第 3 项只检查「形如 a.b 的键」（含点号），这样不会把
   `t(x)`、`t(变量)` 或某个恰好叫 t 的局部函数误判成词条引用。
   ========================================================================== */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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
