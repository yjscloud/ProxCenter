/**
 * 在不装 Nginx 的情况下验收前端构建产物。
 *
 * 托管 dist/ 并把 /api 反向代理到后端（含 WebSocket 升级），
 * 用来验证「生产形态」下前端能否正常加载、SPA 深链接是否回退、
 * 以及 /api 是否连通。
 *
 * 用法：npm run serve:dist   [-- 端口 后端地址]
 *   npm run serve:dist                  # 8090 -> http://127.0.0.1:8080
 *   npm run serve:dist -- 9000 http://10.0.0.5:8080
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';

const args = process.argv.slice(2);
const PORT = Number(args[0]) || 8090;
const BACKEND = new URL(args[1] || 'http://127.0.0.1:8080');
const DIST = resolve('dist');

if (!existsSync(DIST)) {
  console.error(`✗ 未找到构建产物 ${DIST}，请先执行 npm run build`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** 把请求转发到后端，保留原始方法与请求头。 */
function proxy(req, res) {
  const options = {
    hostname: BACKEND.hostname,
    port: BACKEND.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: BACKEND.host },
  };

  const upstream = httpRequest(options, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });

  upstream.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ detail: `无法连接后端: ${err.message}` }));
  });

  req.pipe(upstream);
}

const server = createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];

  // API 与 WebSocket 一律转发给后端
  if (path.startsWith('/api/')) return proxy(req, res);

  // 静态文件；找不到时回退到 index.html 交给前端路由
  let filePath = join(DIST, decodeURIComponent(path));
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    if (path.startsWith('/assets/')) {
      res.writeHead(404).end('Not Found');
      return;
    }
    filePath = join(DIST, 'index.html');
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
  });
  createReadStream(filePath).pipe(res);
});

// WebSocket 升级请求也要代理，否则控制台无法连接
server.on('upgrade', (req, socket, head) => {
  const options = {
    hostname: BACKEND.hostname,
    port: BACKEND.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: BACKEND.host },
  };
  const upstream = httpRequest(options);
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(upRes.headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join('') +
        '\r\n',
    );
    if (upHead?.length) socket.unshift(upHead);
    upSocket.pipe(socket).pipe(upSocket);
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

server.listen(PORT, () => {
  console.log(`dist -> http://localhost:${PORT}   (/api -> ${BACKEND.origin})`);
});
