#!/usr/bin/env bash
# ============================================================================
#  ProxCenter — 一键启动（后端 + 前端开发服务器）
#  首次运行会自动创建虚拟环境并安装依赖。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$ROOT/.venv"

# 按顺序尝试可用的 python，**必须 ≥3.11**。
# 这里必须真的校验版本：Ubuntu 20.04 / Debian 11 的 python3 是 3.9、Ubuntu 22.04
# 是 3.10，只看「命令存在」会静默建出低版本虚拟环境。而 requirements.txt 里的
# Pillow 12 要求 Python ≥3.10，3.9 上 pip 根本解析不出可安装的组合 —— 最终表现
# 成「面板能起来，但某些功能（典型是告警邮件）莫名其妙不工作」，很难排查。
find_python() {
  local candidate
  for candidate in \
    "${PYTHON_BIN:-}" \
    "$HOME/.workbuddy/binaries/python/versions/3.13.12/bin/python3" \
    "$VENV/bin/python" \
    "python3.13" "python3.12" "python3.11" "python3" "python"
  do
    [ -n "$candidate" ] || continue
    if command -v "$candidate" >/dev/null 2>&1; then
      if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
        printf '%s' "$candidate"; return 0
      fi
    fi
  done
  return 1
}

PYTHON="$(find_python || true)"
if [ -z "$PYTHON" ]; then
  DETECTED="$(
    for candidate in python3 python; do
      if command -v "$candidate" >/dev/null 2>&1; then
        "$candidate" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])'
        break
      fi
    done
  )"
  echo "[x] 需要 Python 3.11+，当前系统 python3 是 ${DETECTED:-未找到}。" >&2
  echo "    Debian 12+ / Ubuntu 24.04+ : sudo apt install python3 python3-venv" >&2
  echo "    Ubuntu 20.04 / 22.04        : sudo add-apt-repository ppa:deadsnakes/ppa && sudo apt install python3.11 python3.11-venv" >&2
  echo "    RHEL 9 / Rocky / Alma       : sudo dnf install python3.11" >&2
  echo "    RHEL 8 / CentOS 8           : sudo dnf module enable python311 && sudo dnf install python3.11" >&2
  echo "    自定义路径                  : PYTHON_BIN=/usr/bin/python3.11 ./start.sh" >&2
  exit 1
fi
echo "[i] 使用 Python: $PYTHON（$("$PYTHON" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')）"

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
