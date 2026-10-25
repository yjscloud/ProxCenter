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

# --- 1. 选择 Python 解释器（必须 3.11+）--------------------------------------
# 与 start.sh / deploy.sh 同一套候选顺序与判定。**必须校验版本**：Ubuntu 20.04 /
# Debian 11 的 python3 是 3.9、Ubuntu 22.04 是 3.10，只判断命令存在就会静默使用
# 低版本解释器；而 requirements.txt 里的 Pillow 12 要求 ≥3.10，3.9 上 pip 解析
# 不出可安装组合，最后表现为「面板能开、告警邮件发不出」这类难排查的半残状态。
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
  echo "    自定义路径                  : PYTHON_BIN=/usr/bin/python3.11 ./start-prod.sh" >&2
  exit 1
fi
echo "[i] 使用 Python: $PYTHON（$("$PYTHON" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')）"

# --- 2. 虚拟环境与后端依赖 ---------------------------------------------------
# 交给 ensure_env.py：环境不存在则创建；已存在但解释器版本不一致时重建启动器，
# 避免「.venv 还是 3.9 建的、依赖二进制却是别的版本」这类问题（见脚本注释）。
echo "[1/3] 准备虚拟环境 $VENV ..."
"$PYTHON" "$ROOT/scripts/ensure_env.py" --venv "$VENV"
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
