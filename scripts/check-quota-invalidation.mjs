/* ==========================================================================
   ProxCenter — 额度缓存作废检查

   规则：**会改变额度的写操作，必须让额度读数失效。**

   额度读数有好几份（我的额度 / 平台台数 / 用户额度 / 角色默认额度…），散在
   多个页面与向导里。它们不会自己更新 —— 漏掉作废的表现是「删了机器额度没还
   回来」「额度改完还是打开旧数字」，而且不报错，只能靠人发现。

   这类问题在本项目连着出过好几次，根因都是**要求几十个调用点各自记得同一件
   事**。现在有两个出口，满足其一即可：

   1. 走 `runner.run(...)` —— `useTaskRunner` 会无条件把额度读数一起作废
      （全站写操作的集中入口，覆盖了绝大多数路径）；
   2. 显式调用 `invalidateQuota()`，或在 `invalidate` 里展开 `QUOTA_QUERY_KEYS`
      （不走 runner 的直连写操作用这条）。

   **已知的边界**：这是文件级判断。一个文件若同时有「走 runner 的写操作」和
   「绕过 runner 的直连写操作」，只看文件层面不会报出来。要收紧到语句级需要
   真正的 AST 分析，收益不值那个复杂度 —— 把直连写入集中到少数几个文件，
   然后让这道检查盯住那几个文件，已经能拦住绝大多数的漏。

   用法：node scripts/check-quota-invalidation.mjs
   ========================================================================== */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/**
 * 会改变额度的 API 调用。
 *
 * 每一条都对应后端的一个额度判定或归属变更，不是随手列的：
 *   - 增减一台机器 → 用量变化（create / clone / delete / bulk / toTemplate / restore）
 *   - 改规格      → enforce_grow（resize / addDisk / addMount / updateConfig / removeHardware）
 *   - 快照        → 快照额度（createSnapshot / deleteSnapshot / rollbackSnapshot）
 *   - 归属        → 算在谁头上（assignOwner）
 *   - 额度配置    → saveQuota
 *
 * 新增「会改变额度」的接口时，把它加到这里 —— 这是这道检查唯一需要维护的地方。
 */
const QUOTA_MUTATING = [
  // 客户机的增减
  'vmsApi.create',
  'vmsApi.clone',
  'vmsApi.delete',
  'vmsApi.bulk',
  'vmsApi.toTemplate',
  'lxcApi.create',
  'lxcApi.clone',
  'lxcApi.delete',
  'lxcApi.toTemplate',
  'guestsApi.remove',
  'backupsApi.restore',
  // 规格变化（后端 enforce_grow 那三处）
  'vmsApi.resize',
  'vmsApi.addDisk',
  'vmsApi.updateConfig',
  'vmsApi.removeHardware',
  'lxcApi.resize',
  'lxcApi.addMount',
  'lxcApi.updateConfig',
  'lxcApi.removeHardware',
  'lxcApi.moveVolume',
  // 快照（快照额度）
  'vmsApi.createSnapshot',
  'vmsApi.deleteSnapshot',
  'vmsApi.rollbackSnapshot',
  'lxcApi.createSnapshot',
  'lxcApi.deleteSnapshot',
  'lxcApi.rollbackSnapshot',
  'guestsApi.createSnapshot',
  'guestsApi.deleteSnapshot',
  'guestsApi.rollbackSnapshot',
  // 归属（决定算在谁头上）
  'vmsApi.assignOwner',
  'lxcApi.assignOwner',
  'guestsApi.assignOwner',
  // 额度配置本身
  'usersApi.saveQuota',
  'rolesApi.saveQuota',
];

/** 只有这两处出口算「作废了额度读数」。 */
const INVALIDATION_EXITS = /\binvalidateQuota\s*\(|\bQUOTA_QUERY_KEYS\b/;

/** 走 runner 就等于额度读数会被自动作废（见 useTaskRunner 的 flush）。 */
const VIA_RUNNER = /\brunner\.run\s*\(/;

/** 这两个目录是 API 定义与词条表，不是调用点。 */
const SKIP_DIRS = ['src/api', 'src/i18n'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(join(ROOT, 'src')).filter((file) => {
  const rel = relative(ROOT, file);
  return !SKIP_DIRS.some((dir) => rel.startsWith(`${dir}/`));
});

const failures = [];
let checked = 0;
let viaRunner = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  const source = readFileSync(file, 'utf8');

  const hits = QUOTA_MUTATING.filter((call) => source.includes(call));
  if (hits.length === 0) continue;

  checked += 1;
  if (VIA_RUNNER.test(source) || INVALIDATION_EXITS.test(source)) {
    if (VIA_RUNNER.test(source)) viaRunner += 1;
    continue;
  }

  failures.push({ rel, hits });
}

if (failures.length) {
  console.error(
    `✗ ${failures.length} 个文件在改额度，却没有让额度读数失效：\n`,
  );
  for (const { rel, hits } of failures) {
    console.error(`    - ${rel}`);
    console.error(`      （调用了 ${hits.join('、')}）`);
    console.error(
      '      修法：走 runner.run(...)，或调用 invalidateQuota(queryClient)。\n',
    );
  }
  process.exit(1);
}

console.log(
  `✓ 额度作废检查通过：${checked} 个文件会改额度，` +
    `其中 ${viaRunner} 个走 runner（自动作废），其余显式作废`,
);
