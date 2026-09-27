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
