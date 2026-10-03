# syntax=docker/dockerfile:1
# ============================================================================
#  ProxCenter — 一体化镜像（FastAPI 同源托管前端 dist/，监听 8080）
#
#  多阶段构建，产物只有一个运行时镜像，不需要额外的静态服务器：
#    ① frontend  用 Node 构建前端       → /build/web/dist
#    ② deps      装 Python 依赖到 venv  → /opt/venv
#    ③ runtime   只留 Python 运行时 + 依赖 venv + backend/ + dist/
#
#  构建：
#    docker build -t proxcenter:latest .
#
#  运行需要外部 MySQL（面板只支持 MySQL），推荐直接使用同目录的
#  docker-compose.yml（已内置 MySQL），或按 README 里的环境变量自行连接。
# ============================================================================

# ------------------------------------------------------------- ① 前端构建 ----
# --platform=$BUILDPLATFORM 是刻意加的：多架构构建时 buildx 会给**每个目标平台**
# 各跑一遍所有阶段，而 dist/ 是与架构无关的静态产物。不加这一行，arm64 那次会在
# QEMU 模拟下重跑一遍 npm ci + tsc + vite，白白多花十几分钟且结果完全一样。
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend
WORKDIR /build/web

# 依赖清单与镜像源先落地：这两样不变时这一层命中缓存，docker 不会重装依赖。
COPY package.json package-lock.json .npmrc ./
# package-lock.json 严格固定版本；npm ci 比 install 更适合可复现的镜像构建
RUN npm ci --no-audit --no-fund

# `npm run build` = `tsc -b && vite build`：类型检查需要 tsconfig，
# vite 需要 index.html / src / public 与配置文件。
COPY tsconfig.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
RUN npm run build

# ------------------------------------------------------------ ② Python 依赖 ---
FROM python:3.12-slim AS deps
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# 少数包在缺预编译轮子的平台上会退化到源码编译（Pillow 要 zlib/libjpeg，
# cryptography 要 libffi），这里预置编译工具；工具只留在本阶段，不进最终镜像。
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libffi-dev libjpeg62-turbo-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY backend/requirements.txt ./requirements.txt
RUN pip install --upgrade pip && pip install -r requirements.txt

# --------------------------------------------------------------- ③ 运行时 ---
FROM python:3.12-slim AS runtime

# 版本号由 CI / 构建脚本注入（未注入时是 dev），用于镜像仓库展示与溯源
ARG VERSION=dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="ProxCenter" \
      org.opencontainers.image.description="Proxmox VE 8.x / 9.x 自托管管理面板（FastAPI + React，前后端同源 :8080）" \
      org.opencontainers.image.url="https://github.com/yjscloud/ProxCenter" \
      org.opencontainers.image.source="https://github.com/yjscloud/ProxCenter" \
      org.opencontainers.image.documentation="https://github.com/yjscloud/ProxCenter#readme" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:$PATH" \
    TZ=Asia/Shanghai

# tzdata：日志 / 审计时间与 TZ 一致（Python 的 zoneinfo 也依赖系统时区库）
# libjpeg / zlib：Pillow 运行期需要（轮子自带时装了也无害）
RUN apt-get update && apt-get install -y --no-install-recommends \
        tzdata libjpeg62-turbo zlib1g \
    && rm -rf /var/lib/apt/lists/*

# 只搬运依赖虚拟环境，编译工具链留在上一阶段 —— 这是多阶段构建省体积的关键
COPY --from=deps /opt/venv /opt/venv

# 目录结构必须与代码里的路径假设一致：
#   config.BASE_DIR  = /app/backend
#   config.DATA_DIR  = /app/backend/data
#   main.DIST_DIR    = /app/dist
WORKDIR /app
COPY backend ./backend
COPY --from=frontend /build/web/dist ./dist

# 入口脚本：未提供 SECRET_KEY 时随机生成并落盘到数据卷（详见脚本内注释）
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 运行期数据（logo、登录背景、FRP 配置等）在这里，挂卷持久化，别随容器重建丢失
VOLUME ["/app/backend/data"]

WORKDIR /app/backend
EXPOSE 8080

# 就绪探针直接问后端，不依赖镜像里有没有 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=4)" || exit 1

# 入口脚本保证「没给 SECRET_KEY 也不会因为占位值被拒绝启动」：它会先生成随机密钥
# 并导出，再 exec 下面的 CMD —— 所以零配置也能起，且每个部署密钥各不相同。
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "run.py"]
