import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
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
        // VNC / 串口控制台走 WebSocket，必须开启代理
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
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query', 'axios'],
          charts: ['recharts'],
          console: ['@novnc/novnc', 'xterm', 'xterm-addon-fit'],
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
