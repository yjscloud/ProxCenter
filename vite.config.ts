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
    sourcemap: true,
    // noVNC 使用了顶层 await，ES2020 目标会编译失败；
    // esnext 保留该语法（现代浏览器均支持）。
    target: 'esnext',
    rollupOptions: {
      output: {
        // 把体积大且很少变动的依赖拆出来，避免主包过大、
        // 也让浏览器能长期缓存它们。
        // 这里的每一个名字都必须是**已声明的依赖**：manualChunks 是给 Rollup 的
        // 入口清单，写进来却装不到的包会直接让构建失败
        // （"Could not resolve entry module"），而且只在全新 npm install 的环境里
        // 才暴露 —— 开发机上如果 node_modules 里恰好有那个包，本地照样能构建。
        // 控制台只用 @novnc/novnc（xterm / xterm-addon-fit 早已不用）。
        // scripts/check-graph.mjs 会核对这张表与 package.json。
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query', 'axios'],
          charts: ['recharts'],
          console: ['@novnc/novnc'],
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
  optimizeDeps: {
    esbuildOptions: {
      // 开发模式下预构建同样需要允许顶层 await。
      target: 'esnext',
    },
  },
});
