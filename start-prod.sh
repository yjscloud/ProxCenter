#!/usr/bin/env bash
# ============================================================================
#  ProxCenter — 生产部署启动脚本（后端 + 内置前端，同源，无需 Nginx）
#
#  后端（FastAPI，监听 0.0.0.0:8080）直接托管前端构建产物 dist/，
#  /api 与 WebSocket（VNC 控制台）都在同一端口上，免去反向代理。
#
#  用法：
#    ./start-prod.sh                                 # 前台运行
#    nohup ./start-prod.sh > logs/panel.log 2>&1 &   # 后台常驻
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$ROOT/.venv"

# --- 1. 选择 Python 解释器 ---------------------------------------------------
find_python() {
  for candidate in \
    "$HOME/.workbuddy/binaries/python/versions/3.13.12/bin/python3" \
    "$VENV/bin/python" \
    "python3" "python"
  do
    if command -v "$candidate" >/dev/null 2>&1; then
      echo "$candidate"; return 0
    fi
  done
  return 1
}

PYTHON="$(find_python || true)"
if [ -z "$PYTHON" ]; then
  echo "[x] 未找到 Python 3.11+，请先安装。" >&2
  exit 1
fi
echo "[i] 使用 Python: $PYTHON"

# --- 2. 虚拟环境与后端依赖 ---------------------------------------------------
if [ ! -x "$VENV/bin/python" ]; then
  echo "[1/3] 创建虚拟环境 $VENV ..."
  "$PYTHON" -m venv "$VENV"
fi
VPY="$VENV/bin/python"

echo "[2/3] 安装后端依赖..."
"$VPY" -m pip install -q -r "$ROOT/backend/requirements.txt"

# --- 3. 生成 .env（首次运行）------------------------------------------------
if [ ! -f "$ROOT/backend/.env" ]; then
  cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"
  SECRET="$("$VPY" -c 'import secrets; print(secrets.token_urlsafe(48))')"
  ADMIN_PW="$("$VPY" -c 'import secrets; print(secrets.token_urlsafe(16))')"
  sed -i "s|^SECRET_KEY=.*|SECRET_KEY=${SECRET}|" "$ROOT/backend/.env"
  # 首次建号的口令：留空或 admin123 会被后端直接拒绝启动（拒绝弱口令建号），
  # 所以这里一并随机生成。
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${ADMIN_PW}|" "$ROOT/backend/.env"
  echo "[i] 已生成 backend/.env：SECRET_KEY 与初始管理员口令均为随机值。"
  echo "    初始管理员账号：admin / ${ADMIN_PW}  （登录后请立即修改）"
fi

# --- 4. 校验前端构建产物 -----------------------------------------------------
if [ ! -f "$ROOT/dist/index.html" ]; then
  echo "[x] 未找到前端构建产物 $ROOT/dist/index.html" >&2
  echo "    请先在装有 Node.js 的机器上执行 npm install && npm run build，" >&2
  echo "    再把 dist/ 目录拷贝到 $ROOT/ 后重试。" >&2
  exit 1
fi

# --- 5. 启动 -----------------------------------------------------------------
echo "[3/3] 启动 ProxCenter ..."
echo
echo "  面板地址 : http://0.0.0.0:8080"
echo "  API 文档 : http://0.0.0.0:8080/api/docs"
echo "  默认账号 : admin / 口令见上方首次启动输出（登录后请立即修改）"
echo
echo "  按 Ctrl+C 停止。"
echo

cd "$ROOT/backend"
exec "$VPY" run.py
