#!/usr/bin/env bash
# ============================================================================
#  ProxCenter — 一键部署（构建前端 + 装后端依赖 + 生成 .env + 装 systemd 服务 + 自检）
#
#  与 start-prod.sh 的分工：
#    start-prod.sh  把服务跑在**当前终端**里，适合临时验证、调试；
#    deploy.sh      把它装成 **systemd 常驻服务**（开机自启、崩溃自动拉起），
#                   并负责「构建产物 / 依赖 / 配置 / 数据库」这些一次性的准备工作。
#
#  三条设计原则（改动前请先读一遍）：
#    1. 幂等：重复执行不破坏已有配置。backend/.env 已存在时**只**覆盖命令行显式
#       给出的键，绝不动其他值 —— 尤其是 SECRET_KEY，它是库里密文的加密根，
#       一旦被覆盖，已存库的 PVE Token / SMTP 口令全部解不开。
#    2. 不猜：数据库名、连接账号这类「缺了服务根本起不来」的参数，宁可提前报错
#       并给出可直接粘贴的命令，也不要先生成一份跑不通的配置。
#    3. 不越界：只写 <仓库>/ 与 /etc/systemd/system/<服务名>.service，
#       不改 Nginx、不动防火墙、不碰 MySQL 的其它库。HTTPS 与反代见 README。
#
#  用法：
#    sudo ./deploy.sh --db-name proxcenter_panel --db-user proxcenter \
#                     --db-password '你的强口令'
#    sudo ./deploy.sh --port 9000 --service proxcenter --skip-frontend
#    ./deploy.sh --no-systemd          # 只准备环境与依赖（无需 root）
#    sudo ./deploy.sh --mysql-root-password 'root口令' \
#                     --db-name proxcenter_panel --db-user proxcenter --db-password 'xxx'
#    ./deploy.sh --help
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$ROOT/.venv"
ENV_FILE="$ROOT/backend/.env"
ENV_EXAMPLE="$ROOT/backend/.env.example"

# --- 参数（留空 = 未指定，绝不覆盖已有配置）---------------------------------
PORT=""
SERVICE="proxcenter"
RUN_USER="root"
SKIP_FRONTEND=0
USE_SYSTEMD=1
DB_NAME="${DB_NAME:-}"
DB_USER="${DB_USER:-}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_HOST="${DB_HOST:-}"
DB_PORT="${DB_PORT:-}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-}"

usage() {
  cat <<'EOF'
ProxCenter 一键部署

用法： sudo ./deploy.sh [选项]

选项：
  --port PORT             面板监听端口（默认沿用 .env，首次为 8080）
  --service NAME          systemd 服务名（默认 proxcenter）
  --user USER             systemd 运行用户（默认 root）
  --skip-frontend         跳过前端构建，复用已有的 dist/（服务器上没有 Node.js 时用）
  --no-systemd            只准备虚拟环境 / 依赖 / .env / 前端产物，不装服务（无需 root）
  --db-host HOST          数据库地址（默认 127.0.0.1）
  --db-port PORT          数据库端口（默认 3306）
  --db-name NAME          面板数据库名（必填，除非 backend/.env 里已经有）
  --db-user USER          面板数据库账号
  --db-password PASS      面板数据库口令
  --mysql-root-password P 仅用于自动建库建号的 MySQL 管理员口令（选填）
  -h, --help              显示本帮助

环境变量同名可用：DB_NAME / DB_USER / DB_PASSWORD / DB_HOST / DB_PORT /
MYSQL_ROOT_PASSWORD

示例：
  # 最常见的用法：建库 + 装服务 + 自检
  sudo ./deploy.sh --mysql-root-password 'root口令' \
       --db-name proxcenter_panel --db-user proxcenter --db-password '强口令'

  # 库和账号已经建好了，只填面板要用的凭据
  sudo ./deploy.sh --db-name proxcenter_panel --db-user proxcenter --db-password '强口令'

  # 只更新代码后重新部署（复用已有 .env 与 dist）
  sudo ./deploy.sh --skip-frontend

  # 没有 root 权限 / 不想装服务：只把环境和依赖备好
  ./deploy.sh --no-systemd
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --user) RUN_USER="${2:-}"; shift 2 ;;
    --skip-frontend) SKIP_FRONTEND=1; shift ;;
    --no-systemd) USE_SYSTEMD=0; shift ;;
    --db-host) DB_HOST="${2:-}"; shift 2 ;;
    --db-port) DB_PORT="${2:-}"; shift 2 ;;
    --db-name) DB_NAME="${2:-}"; shift 2 ;;
    --db-user) DB_USER="${2:-}"; shift 2 ;;
    --db-password) DB_PASSWORD="${2:-}"; shift 2 ;;
    --mysql-root-password) MYSQL_ROOT_PASSWORD="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[x] 未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

# --- 输出helper --------------------------------------------------------------
step() { echo; echo "==> $*"; }
info() { echo "    $*"; }
warn() { echo "    [!] $*" >&2; }
die()  { echo "[x] $*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# 从 backend/.env 读一个键（不存在则输出空串）
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  "$VPY" - "$ENV_FILE" "$1" <<'PY'
import pathlib, sys
path, key = sys.argv[1], sys.argv[2]
for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if line.startswith(key + "="):
        print(line.split("=", 1)[1].strip())
        break
PY
}

# 写入 / 覆盖一个键。
# 刻意用 Python 而不是 sed：数据库口令里出现 & | / \ 时，sed 的替换串会被
# 当成反向引用，写进去的就是一句错误的配置 —— 这种坑只在真实口令上才暴露。
env_set() {
  "$VPY" - "$ENV_FILE" "$1" "$2" <<'PY'
import pathlib, re, sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
text = p.read_text(encoding="utf-8")
pattern = re.compile(rf"^{re.escape(key)}=.*$", re.M)
line = f"{key}={value}"
if pattern.search(text):
    text = pattern.sub(lambda _m: line, text, count=1)
else:
    text = text.rstrip("\n") + "\n" + line + "\n"
p.write_text(text, encoding="utf-8")
PY
}

echo "============================================================"
echo " ProxCenter 部署"
echo " 仓库目录 : $ROOT"
echo " 服务名   : $SERVICE"
echo "============================================================"

# ---------------------------------------------------------------------------
# 0. 前置检查
# ---------------------------------------------------------------------------
step "检查运行环境"

if [ "$USE_SYSTEMD" -eq 1 ]; then
  [ "$(id -u)" -eq 0 ] || die "安装 systemd 服务需要 root：请用 sudo 执行，或加 --no-systemd 只准备环境。"
  need_cmd systemctl || die "本机没有 systemd（systemctl 不存在），请改用 --no-systemd。"
fi

# 找 Python 3.11+。与 start.sh / start-prod.sh 保持同一套候选顺序。
PYTHON=""
for candidate in \
  "${PYTHON_BIN:-}" \
  "$HOME/.workbuddy/binaries/python/versions/3.13.12/bin/python3" \
  "$VENV/bin/python" \
  "python3" "python"
do
  [ -n "$candidate" ] || continue
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
      PYTHON="$candidate"; break
    fi
  fi
done
[ -n "$PYTHON" ] || die "未找到 Python 3.11+，请先安装（Debian/Ubuntu：apt install python3 python3-venv）。"
info "Python：$PYTHON（$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")')）"

# 仓库完整性：脚本要用的三个入口文件缺一个都跑不下去。
# 提前检查而不是等 pip / npm 报「文件不存在」——那种报错看不出「需要重新拉取」。
for required in backend/requirements.txt backend/run.py package.json; do
  [ -f "$ROOT/$required" ] || die "缺少 $required，仓库不完整（建议重新 git clone 后再执行）。"
done

if [ "$SKIP_FRONTEND" -eq 0 ]; then
  if ! need_cmd npm; then
    die "未找到 npm，无法构建前端。两种选择：① 在装有 Node.js 18+ 的机器上执行
        npm install && npm run build，把 dist/ 拷到 $ROOT/ 后加 --skip-frontend 重跑；
        ② 用 nvm 装好 Node.js 后重跑本脚本。"
  fi
  info "Node.js：$(node --version 2>/dev/null || echo 未知) / npm：$(npm --version 2>/dev/null || echo 未知)"
fi

# ---------------------------------------------------------------------------
# 1. 后端虚拟环境与依赖
# ---------------------------------------------------------------------------
step "[1/5] 准备后端虚拟环境与依赖"

if [ ! -x "$VENV/bin/python" ]; then
  info "创建虚拟环境：$VENV"
  "$PYTHON" -m venv "$VENV"
fi
VPY="$VENV/bin/python"

info "安装 backend/requirements.txt（已装则跳过）"
# pip 自身升级失败不影响后面装依赖（内网可能连不上 PyPI），所以只提示不中断。
"$VPY" -m pip install -q --upgrade pip || warn "pip 自身升级失败，继续用现有版本"
"$VPY" -m pip install -q -r "$ROOT/backend/requirements.txt" \
  || die "后端依赖安装失败。请检查网络，或改用镜像源：
        $VPY -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r $ROOT/backend/requirements.txt"

# ---------------------------------------------------------------------------
# 2. 后端配置（backend/.env）
# ---------------------------------------------------------------------------
step "[2/5] 准备后端配置"

[ -f "$ENV_EXAMPLE" ] || die "缺少模板 $ENV_EXAMPLE，仓库不完整。"

if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  info "已从 .env.example 生成 backend/.env"

  # SECRET_KEY 与初始管理员口令必须是随机值：后端会拒绝占位 SECRET_KEY 与弱口令
  # 启动，所以这一步不能省。SECRET_KEY 一旦确定就不要再改 —— 它是库里密文的加密根。
  SECRET="$("$VPY" -c 'import secrets; print(secrets.token_urlsafe(48))')"
  ADMIN_PW="$("$VPY" -c 'import secrets; print(secrets.token_urlsafe(16))')"
  env_set SECRET_KEY "$SECRET"
  env_set ADMIN_PASSWORD "$ADMIN_PW"
  FIRST_RUN=1
else
  info "backend/.env 已存在，保留现有值（只覆盖命令行显式指定的项）"
  FIRST_RUN=0
fi

# 显式给出的值才写回
[ -n "$PORT" ] && env_set PORT "$PORT"
[ -n "$DB_HOST" ] && env_set DB_HOST "$DB_HOST"
[ -n "$DB_PORT" ] && env_set DB_PORT "$DB_PORT"
[ -n "$DB_NAME" ] && env_set DB_NAME "$DB_NAME"
[ -n "$DB_USER" ] && env_set DB_USER "$DB_USER"
[ -n "$DB_PASSWORD" ] && env_set DB_PASSWORD "$DB_PASSWORD"

# --- 数据库：能用 mysql 客户端就顺手把库和账号建好 ---------------------------
DB_NAME_NOW="$(env_get DB_NAME)"
DB_USER_NOW="$(env_get DB_USER)"
DB_HOST_NOW="$(env_get DB_HOST)"
DB_PORT_NOW="$(env_get DB_PORT)"

if [ -n "$DB_NAME" ] && [ -n "$DB_USER" ] && [ -n "$DB_PASSWORD" ]; then
  if need_cmd mysql && [ -n "$MYSQL_ROOT_PASSWORD" ]; then
    info "在 MySQL 上创建数据库 $DB_NAME 与账号 $DB_USER"
    # 口令走 MYSQL_PWD 而不是 --password：命令行参数会出现在 ps 里，
    # 也会触发 mysql 客户端的「口令不安全」告警。
    # IF NOT EXISTS + 重复授权都是幂等的；只动这一个库，不碰其它。
    MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql \
      -h "${DB_HOST_NOW:-127.0.0.1}" -P "${DB_PORT_NOW:-3306}" -u root <<SQL \
      || warn "自动建库失败（管理员口令可能不对），请手工执行下面这段 SQL"
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'%' IDENTIFIED BY '$DB_PASSWORD';
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'%';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL

    # 建完就用面板自己的账号试连一次。
    # 刻意不做 ALTER USER 去强行对齐口令：这个账号可能还被别的应用用着，
    # 悄悄改掉它的口令等于把别人的服务弄挂 —— 只提示，由人来决定。
    if MYSQL_PWD="$DB_PASSWORD" mysql -h "${DB_HOST_NOW:-127.0.0.1}" \
         -P "${DB_PORT_NOW:-3306}" -u "$DB_USER" "$DB_NAME" -e 'SELECT 1' >/dev/null 2>&1; then
      info "已用面板账号连库验证通过"
    else
      warn "建库授权之后，用面板账号仍连不上 $DB_NAME。若该账号早已存在且口令与
     本次传入的不同，请自行确认后对齐（会同时影响这个账号的其它用途）：
       ALTER USER '$DB_USER'@'%' IDENTIFIED BY '<你在 .env 里填的口令>';"
    fi
  elif [ -z "$MYSQL_ROOT_PASSWORD" ]; then
    info "未提供 --mysql-root-password，跳过自动建库"
  else
    warn "本机没有 mysql 客户端，跳过自动建库；请手工建库"
  fi
fi

# 连不上库 = 服务起不来。装服务前把话说明白，比等 systemd 反复重启强。
# --no-systemd（只准备环境与依赖）时不拦：那种用法的目的可能只是装依赖。
db_problem() {
  if [ "$USE_SYSTEMD" -eq 0 ]; then
    warn "$1"
    warn "--no-systemd：继续执行，但这样生成的配置装成服务后起不来。"
  else
    die "$1"
  fi
}

if [ -z "$DB_NAME_NOW" ] || [ -z "$DB_USER_NOW" ]; then
  db_problem "backend/.env 里还没有数据库配置（DB_NAME / DB_USER / DB_PASSWORD）。
    面板只支持 MySQL，且启动时要建表。请先建库：
      CREATE DATABASE proxcenter_panel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    然后二选一：
      ① 重跑本脚本并带上参数（会自动写入 .env）：
         sudo ./deploy.sh --db-name proxcenter_panel --db-user <账号> --db-password '<口令>'
      ② 手工编辑 $ENV_FILE 的 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
         后再执行： sudo ./deploy.sh --skip-frontend
    提示：库和账号都建好时，加上 --mysql-root-password '<root口令>' 可以让本脚本
    自动完成建库与授权。"
else
  if "$VPY" - "$DB_HOST_NOW" "$DB_PORT_NOW" <<'PY'
import socket, sys
host, port = sys.argv[1] or "127.0.0.1", int(sys.argv[2] or 3306)
s = socket.socket()
s.settimeout(3)
try:
    s.connect((host, port))
except OSError as exc:
    print(f"无法连接 {host}:{port} —— {exc}")
    raise SystemExit(1)
finally:
    s.close()
PY
  then
    info "MySQL 可达：${DB_HOST_NOW:-127.0.0.1}:${DB_PORT_NOW:-3306} / 库 ${DB_NAME_NOW}"
  else
    db_problem "连不上 MySQL（${DB_HOST_NOW:-127.0.0.1}:${DB_PORT_NOW:-3306}），服务即使装上
    也会一直重启。请确认数据库已启动、地址与端口正确、防火墙已放通。"
  fi
fi

# ---------------------------------------------------------------------------
# 3. 前端构建产物
# ---------------------------------------------------------------------------
step "[3/5] 准备前端构建产物"

if [ "$SKIP_FRONTEND" -eq 1 ]; then
  [ -f "$ROOT/dist/index.html" ] || die "--skip-frontend 要求 dist/index.html 已存在，请先构建或去掉该参数。"
  info "跳过构建，复用已有 dist/"
else
  # npm ci 只在 lock 与 package.json 完全一致时可用，且会**清空** node_modules；
  # 这里用 install，配合 .npmrc 里的国内镜像，首次约几分钟。
  if [ ! -d "$ROOT/node_modules" ]; then
    info "安装前端依赖（首次较慢）"
    (cd "$ROOT" && npm install --no-audit --no-fund)
  else
    info "复用已有 node_modules（要强制重装请先删除该目录）"
  fi
  info "构建：npm run build → dist/"
  (cd "$ROOT" && npm run build)
  [ -f "$ROOT/dist/index.html" ] || die "构建结束但 dist/index.html 不存在，请检查上面的构建输出。"
fi

# ---------------------------------------------------------------------------
# 4. systemd 服务
# ---------------------------------------------------------------------------
PORT_NOW="$(env_get PORT)"
PORT_NOW="${PORT_NOW:-8080}"

if [ "$USE_SYSTEMD" -eq 0 ]; then
  step "[4/5] 跳过 systemd（--no-systemd）"
  info "手动启动：$ROOT/start-prod.sh"
else
  step "[4/5] 安装 systemd 服务：$SERVICE"

  mkdir -p "$ROOT/logs"
  UNIT="/etc/systemd/system/${SERVICE}.service"

  # 非 root 运行是更安全的做法，但代价是「这个用户得能读仓库、能写日志」——
  # 脚本只能替它把 logs/ 的属主改对，仓库本身的权限（尤其是 backend/.env）
  # 只能提醒：.env 里是明文口令，权限放宽给所有人读反而更糟。
  if [ "$RUN_USER" != "root" ]; then
    id "$RUN_USER" >/dev/null 2>&1 || die "指定的运行用户 $RUN_USER 不存在。"
    chown -R "$RUN_USER" "$ROOT/logs" 2>/dev/null || true
    warn "服务将以 $RUN_USER 运行，请确认该用户能读 $ROOT（含 .venv / dist / backend/.env）。"
  fi

  # 单元文件由脚本渲染，而不是仓库里放一份写死路径的模板：
  # 安装目录、端口、运行用户都是部署时才知道的，模板里的占位符反而容易漏改。
  cat > "$UNIT" <<EOF
[Unit]
Description=ProxCenter - Proxmox VE 管理面板 (FastAPI :${PORT_NOW})
Documentation=file://${ROOT}/README.md
After=network-online.target
Wants=network-online.target
Before=nginx.service

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${ROOT}/backend
Environment=PYTHONUNBUFFERED=1
ExecStart=${VENV}/bin/python ${ROOT}/backend/run.py
Restart=always
RestartSec=5
# 该进程优雅退出较慢：15 秒后强制结束，避免重启被拖住
TimeoutStopSec=15
KillSignal=SIGTERM
StandardOutput=append:${ROOT}/logs/panel.log
StandardError=append:${ROOT}/logs/panel.log

[Install]
WantedBy=multi-user.target
EOF
  info "已写入 $UNIT"

  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE"
  info "服务已启动并设为开机自启"
fi

# ---------------------------------------------------------------------------
# 5. 自检
# ---------------------------------------------------------------------------
step "[5/5] 健康检查"

if [ "$USE_SYSTEMD" -eq 0 ]; then
  info "未安装服务，跳过（起服务后自行访问 /api/health 即可）"
else
  OK=0
  for _ in $(seq 1 20); do
    if need_cmd curl; then
      if curl -fsS -m 2 "http://127.0.0.1:${PORT_NOW}/api/health" >/tmp/pc_health.$$ 2>/dev/null; then OK=1; break; fi
    else
      if "$VPY" -c "
import urllib.request
urllib.request.urlopen('http://127.0.0.1:${PORT_NOW}/api/health', timeout=2)
" >/dev/null 2>&1; then OK=1; break; fi
    fi
    sleep 1
  done

  if [ "$OK" -eq 1 ]; then
    info "面板已就绪：$(cat /tmp/pc_health.$$ 2>/dev/null || true)"
    rm -f /tmp/pc_health.$$
  else
    echo
    warn "健康检查未通过（服务可能在反复重启）。排查命令："
    echo "      systemctl status ${SERVICE}"
    echo "      journalctl -u ${SERVICE} -n 50"
    echo "      tail -n 50 ${ROOT}/logs/panel.log"
    echo "    最常见的三个原因：数据库口令不对 / SECRET_KEY 仍是占位值 / PVE 地址填错。"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 完成
# ---------------------------------------------------------------------------
echo
echo "============================================================"
echo " 部署完成"
echo "   面板地址 : http://<本机IP>:${PORT_NOW}"
echo "   API 文档 : http://<本机IP>:${PORT_NOW}/api/docs"
echo "   配置文件 : $ENV_FILE"
echo "   服务管理 : systemctl {status|restart|stop} $SERVICE"
echo "   日志     : journalctl -u $SERVICE -f   或   tail -f $ROOT/logs/panel.log"
if [ "${FIRST_RUN:-0}" -eq 1 ]; then
  echo
  echo "  初始管理员账号：admin"
  echo "  初始管理员口令：$(env_get ADMIN_PASSWORD)"
  echo "  ↑ 只显示这一次，请立即登录并修改。"
fi
echo
echo " 下一步（公网访问必做）："
echo "   1) 按 README「用 Nginx 上 HTTPS」配好反代与证书；"
echo "   2) 在 backend/.env 里设 FORCE_HTTPS=true 后 systemctl restart $SERVICE；"
echo "   3) 登录后在「设置 → Proxmox 连接配置」填入 PVE 地址与 API Token。"
echo "============================================================"
