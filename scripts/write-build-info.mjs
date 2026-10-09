/* ==========================================================================
   写 dist/build-info.json —— 前端构建产物的「版本身份证」。

   为什么需要它：前端产物陈旧时，界面上此前**毫无迹象** —— 后端代码已是新版、
   服务照常运行、页面照常打开，只是某个功能悄悄跑着旧前端。造成这种状态的路径
   不止一条（见 backend/app/buildinfo.py 的说明）：跳版本升级时依赖没装上、
   用户按提示用了 --skip-frontend、源码包安装的 rsync 排除 dist、构建中途失败。

   后端启动时会读这份文件与 app.__version__ 比对，不一致就在日志里告警、并在
   「设置 → 面板版本与更新」里说明。所以这里写的是**构建那一刻** package.json
   里的版本号（与 backend/app/__init__.py 的 __version__ 同源）。
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const info = {
  version: pkg.version,
  // 秒级时间戳：前端与后端都用得上，且与项目其它地方的时间口径一致
  built_at: Math.floor(Date.now() / 1000),
};

writeFileSync(
  resolve(root, 'dist', 'build-info.json'),
  `${JSON.stringify(info, null, 2)}\n`,
);

console.log(`build-info.json → v${info.version}`);
