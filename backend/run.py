"""Entrypoint: run the panel's ASGI app under uvicorn.

生产环境下由仓库根目录的 ``deploy.sh`` 生成 systemd 单元并托管启动；
也可以直接用 ``start-prod.sh`` 跑在前台。
"""
import sys

import uvicorn

try:
    from app.config import settings
except Exception as exc:  # noqa: BLE001 -— 配置不合法（如 SECRET_KEY 占位值）
    # 直接给一句人话而不是一整屏 traceback：报错里已经写清改哪里、怎么生成随机值。
    print("[面板启动被拒绝] 配置不合法：", file=sys.stderr)
    print(str(exc), file=sys.stderr)
    raise SystemExit(2) from exc

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        # 反代（Nginx/Caddy）要能把客户端的真实 scheme 传进来，FORCE_HTTPS 才
        # 认得出 https；只信任指定来源的 X-Forwarded-Proto，否则任何公网请求
        # 都能自称「我是 https」绕过强制跳转。
        proxy_headers=True,
        forwarded_allow_ips=settings.forwarded_allow_ips,
        # 不要把 "server: uvicorn" 发给客户端：这一行是 uvicorn 在协议层写的，
        # 应用中间件拦不到，只能在启动参数里关（审计项 FD-14）。
        server_header=False,
        # 日期头保留（缓存语义要用），但 server 头与版本无关的信息一律不发
    )
