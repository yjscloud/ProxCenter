/**
 * 静态校验：确认全部源码模块都能被解析。
 *
 * 比 tsc 更早发现问题——tsc 关心类型，esbuild 关心语法。两者都过，
 * 才说明代码能被真正打包。tsc --noEmit 已由 npm run typecheck 覆盖，
 * 这里补一层语法/导入检查。
 *
 * 用法：node scripts/check-graph.mjs
 */
import { build } from 'esbuild';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

const files = walk('src');
console.log(`扫描到 ${files.length} 个源文件`);

try {
  await build({
    entryPoints: files,
    bundle: false, // 只解析，不解析依赖图
    write: false,
    format: 'esm',
    target: 'esnext',
    jsx: 'automatic',
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'error',
    outdir: 'node_modules/.tmp/check-graph', // 多入口时需要 outdir
  });
  console.log('✓ 全部模块解析通过');
} catch (error) {
  console.error('✗ 解析失败:');
  console.error(error.message);
  process.exit(1);
}

/* 额外检查：所有相对导入的目标文件真实存在（catch 拼写错误） */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const IMPORT_RE = /from\s+['"](\.[^'"]+)['"]/g;
const missing = [];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1];
    const base = resolve(dirname(file), spec);
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.d.ts`,
      join(base, 'index.ts'),
      join(base, 'index.tsx'),
    ];
    if (!candidates.some((c) => existsSync(c))) {
      missing.push(`${relative('.', file)} -> ${spec}`);
    }
  }
}

if (missing.length) {
  console.error(`✗ ${missing.length} 个相对导入找不到目标:`);
  missing.forEach((m) => console.error(`   ${m}`));
  process.exit(1);
}
console.log('✓ 全部相对导入均可解析');

/* ---------------------------------------------------------------------------
   额外检查：第三方包必须声明在 package.json 里

   这条规则是踩出来的：vite.config.ts 的 manualChunks 里曾写过一个没声明的
   'xterm'，开发机上 node_modules 里恰好有这个包，本地构建照过；换一台干净
   机器 npm install 之后构建直接失败：

       Could not resolve entry module "xterm"

   也就是「只在新环境炸」的那类问题。这里同时核对两处：
     1. 源码里的裸导入（bare import）；
     2. vite.config.ts 的 manualChunks 清单。
   --------------------------------------------------------------------------- */
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
]);

/** 取包名：@scope/name → @scope/name；name/sub → name */
const rootPkg = (spec) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dns', 'events', 'fs',
  'http', 'https', 'net', 'os', 'path', 'process', 'querystring', 'stream',
  'timers', 'tls', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

const BARE_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
const undeclared = new Set();

// 构建入口也要一起看：vite.config.ts 与 scripts/ 里的导入同样会在
// 「干净 npm install」的环境里炸（本文件自己 import 的 esbuild 就是这样被查出来的）。
const scanned = [
  ...files,
  ...walk('scripts').filter((f) => f.endsWith('.mjs')),
  'vite.config.ts',
].filter((f) => existsSync(f));

for (const file of scanned) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(BARE_RE)) {
    const spec = match[1];
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    if (spec.startsWith('@/')) continue; // vite alias → src/
    if (spec.startsWith('node:') || NODE_BUILTINS.has(spec)) continue;
    const name = rootPkg(spec);
    if (!declared.has(name)) undeclared.add(`${relative('.', file)} -> ${spec}`);
  }
}

const viteConfig = readFileSync('vite.config.ts', 'utf8');
const chunkBlock = viteConfig.match(/manualChunks:\s*\{([\s\S]*?)\n\s*\}/);
const chunkNames = chunkBlock
  ? [...chunkBlock[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
  : [];
for (const name of chunkNames) {
  if (!declared.has(rootPkg(name))) {
    undeclared.add(`vite.config.ts manualChunks -> ${name}`);
  }
}

if (undeclared.size) {
  console.error(`✗ ${undeclared.size} 个包没有声明在 package.json（干净环境里会构建失败）:`);
  undeclared.forEach((m) => console.error(`   ${m}`));
  process.exit(1);
}
console.log(
  `✓ 全部第三方依赖均已声明（${scanned.length} 个文件 + manualChunks ${chunkNames.length} 项）`,
);

/* ---------------------------------------------------------------------------
   额外检查：package-lock.json 必须与 package.json 一致

   与上面那条同一类「只在新环境炸」，但更隐蔽 —— 它不会让构建失败，只会让**每台
   机器在每次部署时莫名多出一处未提交改动**：

   package-lock.json 里也记着**根包自己的版本号**。发版时只改 package.json 的
   version、忘了同步 lock，npm install 就会在每次部署时把 lock 重写一遍（deploy.sh
   每次都会跑 install 检查依赖）。工作区于是永远是脏的，而面板的在线更新只要看到
   工作区有改动就要二次确认（见 backend/app/update.py 的 git_info）—— 用户看到的
   是「为什么不能一键更新」，而原因跟他的代码毫无关系。

   实测漏过三个版本（0.2.2 / 0.2.3 / 0.2.4 都只改了 package.json），所以在这里钉死：
   版本号与两张依赖表都必须对得上。
   --------------------------------------------------------------------------- */
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const lockRoot = (lock.packages || {})[''] || {};
const drift = [];

if (lock.version !== pkg.version) {
  drift.push(`version：package.json ${pkg.version} ≠ package-lock.json ${lock.version}`);
}
if (lockRoot.version && lockRoot.version !== pkg.version) {
  drift.push(
    `根包 version：package.json ${pkg.version} ≠ lock 的 packages[""] ${lockRoot.version}`,
  );
}
for (const field of ['dependencies', 'devDependencies']) {
  const inPkg = pkg[field] || {};
  const inLock = lockRoot[field] || {};
  for (const name of new Set([...Object.keys(inPkg), ...Object.keys(inLock)])) {
    if (inPkg[name] !== inLock[name]) {
      drift.push(
        `${field} 的 ${name}：package.json ${inPkg[name] ?? '(没有)'} ≠ lock ${inLock[name] ?? '(没有)'}`,
      );
    }
  }
}

if (drift.length) {
  console.error(`✗ package-lock.json 与 package.json 不一致（${drift.length} 处）:`);
  drift.forEach((line) => console.error(`   ${line}`));
  console.error('   修：npm install --package-lock-only --no-audit --no-fund');
  process.exit(1);
}
console.log('✓ package-lock.json 与 package.json 一致（版本号 + 依赖表）');
