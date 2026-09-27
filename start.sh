#!/usr/bin/env bash
# ============================================================================
#  ProxCenter — 一键启动（后端 + 前端开发服务器）
#  首次运行会自动创建虚拟环境并安装依赖。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$ROOT/.venv"

# 按顺序尝试可用的 python
find_python() {
  for candidate in \
    "$HOME/.workbuddy/binaries/python/versions/3.13.12/bin/python3" \
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

# --- 1. 虚拟环境 ------------------------------------------------------------
# 交给 ensure_env.py：校验 .venv 的解释器版本，不一致时自动重新生成启动器
# （保留 site-packages），避免「解释器换过、依赖还是旧版本编译」导致的
# "No module named 'pydantic_core._pydantic_core'"。
echo "[1/4] 准备虚拟环境..."
"$PYTHON" "$ROOT/scripts/ensure_env.py" --venv "$VENV"

VPY="$VENV/bin/python"

echo "[2/4] 安装后端依赖..."
"$VPY" -m pip install -q -r "$ROOT/backend/requirements.txt"

# --- 2. .env ----------------------------------------------------------------
if [ ! -f "$ROOT/backend/.env" ]; then
  cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"
  echo "[i] 已生成 backend/.env，请按需填入 Proxmox 连接信息。"
fi

# --- 3. 前端依赖 ------------------------------------------------------------
if [ ! -d "$ROOT/node_modules" ]; then
  echo "[3/4] 安装前端依赖（可能需要几分钟）..."
  (cd "$ROOT" && npm install --no-audit --no-fund)
fi

# --- 4. 启动 ----------------------------------------------------------------
echo "[4/4] 启动服务..."
echo
echo "  后端 API : http://localhost:8080/api/docs"
echo "  前端界面 : http://localhost:5173"
echo "  默认账号 : admin / admin123"
echo
echo "  按 Ctrl+C 停止。"
echo

cleanup() {
  echo
  echo "[i] 正在停止..."
  [ -n "${BACKEND_PID:-}" ] && kill "$BACKEND_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

(cd "$ROOT/backend" && "$VPY" run.py) &
BACKEND_PID=$!

sleep 2
(cd "$ROOT" && npm run dev)

cleanup
