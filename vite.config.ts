import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

/*
  把版本号写进构建产物（dist/build-info.json）。后端启动时读它与 __version__
  比对，不一致就在日志与「设置 → 面板版本与更新」里说明「界面跑的是旧前端」
  （见 backend/app/buildinfo.py）。

  为什么放进 vite 插件、而不是一个独立的 node 脚本：构建链路只有一处，才不会
  出现「加了脚本，却忘了让别的构建环境也拿到它」。踩过 —— Dockerfile 的 frontend
  阶段只 COPY 了 src / public 与配置文件，独立脚本在那里根本不存在，镜像构建直接
  失败（而 npm run build 在开发机上好好的）。
*/
function writeBuildInfo(): Plugin {
  let outDir = 'dist';
  return {
    name: 'proxcenter-build-info',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const pkg = JSON.parse(
        readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
      );
      const info = {
        version: pkg.version,
        // 秒级时间戳：与项目其它地方的时间口径一致
        built_at: Math.floor(Date.now() / 1000),
      };
      writeFileSync(
        fileURLToPath(new URL(`./${outDir}/build-info.json`, import.meta.url)),
        `${JSON.stringify(info, null, 2)}\n`,
      );
      console.log(`build-info.json → v${info.version}`);
    },
  };
}

/* ---------------------------------------------------------------------------
   手动分包清单：键 = chunk 名，值 = 归属该 chunk 的包名。

   每一条都必须是**已声明的依赖**：分包清单里写了却装不到的包会直接让构建
   失败（"Could not resolve entry module"），而且只在全新 npm install 的环境
   里才暴露 —— 开发机上如果 node_modules 里恰好有那个包，本地照样能构建。
   scripts/check-graph.mjs 会核对这张表与 package.json。

   写成数据表而不是内联在 output 里，是因为 Vite 8 换用 rolldown 后
   `output.manualChunks` 的对象形式已不存在（Rollup 专有），改为
   `output.codeSplitting.groups` + 正则 test；保留一份纯包名清单，
   既方便脚本核对，也让「哪些包进哪个 chunk」一眼可见。
   --------------------------------------------------------------------------- */
const MANUAL_CHUNKS: Record<string, string[]> = {
  react: ['react', 'react-dom', 'react-router'],
  query: ['@tanstack/react-query', 'axios'],
  charts: ['recharts'],
  // 控制台只用 @novnc/novnc（xterm / xterm-addon-fit 早已不用）。
  console: ['@novnc/novnc'],
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 包名清单 → rolldown 的分组规则（命中 node_modules 下该包目录的模块）。 */
const chunkGroup = ([name, pkgs]: [string, string[]]) => ({
  name,
  test: new RegExp(`[\\\\/]node_modules[\\\\/](?:${pkgs.map(escapeRegExp).join('|')})[\\\\/]`),
});

export default defineConfig({
  plugins: [react(), writeBuildInfo()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        // VNC 控制台走 WebSocket，必须开启代理
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    /* 生产构建**不产出** sourcemap：.map 里的 sourcesContent 是完整 TS 源码，
       凭一个 URL 就能还原全部接口封装、请求字段与错误分支。本地调试用
       `npm run dev`（Vite 自带 sourcemap），或临时 `--sourcemap` 构建但不发布。 */
    sourcemap: false,
    // noVNC 使用了顶层 await，ES2020 目标会编译失败；
    // esnext 保留该语法（现代浏览器均支持）。
    target: 'esnext',
    rollupOptions: {
      output: {
        // 把体积大且很少变动的依赖拆出来，避免主包过大、
        // 也让浏览器能长期缓存它们。清单见文件顶部的 MANUAL_CHUNKS。
        codeSplitting: {
          groups: [
            ...Object.entries(MANUAL_CHUNKS).map(chunkGroup),
            // i18n 字典（zh-CN 400KB+ 源码）被所有页面共享，体积比任何业务页面
            // 都大。不显式命名时，rolldown 会把它并进「首个引用它的模块」所在
            // 的 chunk，产物里出现过 LanguageSelect-*.js 786KB 这种完全看不出
            // 内容的文件名 —— 排查体积和缓存问题时会被误导。
            //
            // **``locales/`` 排除在外**：英文词典是动态 import 的（见
            // i18n/index.tsx 的 preloadLang）。把它归进这个组，rolldown 会强行
            // 把它并回静态 chunk，按需加载直接失效（实测：分组后 i18n 仍是 777KB）。
            { name: 'i18n', test: /[\\/]src[\\/]i18n[\\/](?!locales[\\/])/ },
          ],
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
  /* 这里原本有 optimizeDeps.esbuildOptions.target = 'esnext'（放开顶层 await）。
     Vite 8 的依赖预构建已从 esbuild 换成 rolldown/oxc，该字段被标记废弃，
     而 rolldown 默认就按现代语法处理、不再降级顶层 await，所以整块删掉；
     dev 启动与 build 均已验证可用（见 README 的升级说明）。 */
});
