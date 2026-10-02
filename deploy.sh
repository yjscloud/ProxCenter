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
#       唯一的例外在 [0/5] 步：**缺系统依赖时按发行版自动安装**（只装缺的那几个，
#       装完立刻验证；不想让它动系统就加 --skip-deps 退回「只检查不安装」）。
#
#  用法：
#    sudo ./deploy.sh --db-name proxcenter_panel --db-user proxcenter \
#                     --db-password '你的强口令'
#    sudo ./deploy.sh --port 9000 --service proxcenter --skip-frontend
#    ./deploy.sh --no-systemd          # 只准备环境与依赖（无需 root）
#    sudo ./deploy.sh --mysql-root-password 'root口令' --install-db \
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
INSTALL_DEPS=1        # 0 = --skip-deps：只检查系统依赖，不安装
INSTALL_DB=1          # 0 = --no-install-db：本机没数据库也不代装（默认代装，做到零参数可部署）
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
  --skip-deps             只检查系统依赖，不自动安装（离线 / 内网 / 想自己管依赖时用）
  --no-install-db         本机没有 MySQL/MariaDB 时也不代装（默认代装，见下）
  --install-db            兼容旧用法，等于默认行为（保留参数，不再需要显式指定）
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
  # 最常见的用法：什么都不用给 —— 缺系统依赖就装，本机没数据库就装 MariaDB，
  # 库名 / 账号 / 口令自动生成并写进 backend/.env，然后建库授权、装服务、自检
  sudo ./deploy.sh

  # 数据库已经有人管（远程库 / 已有实例），只填面板要用的凭据
  sudo ./deploy.sh --db-host 10.0.0.9 --db-name proxcenter_panel \
       --db-user proxcenter --db-password '强口令'

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
    --skip-deps) INSTALL_DEPS=0; shift ;;
    --install-db) INSTALL_DB=1; shift ;;
    --no-install-db) INSTALL_DB=0; shift ;;
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
# 0. 前置检查 + 系统依赖
# ---------------------------------------------------------------------------
step "检查运行环境"

if [ "$USE_SYSTEMD" -eq 1 ]; then
  [ "$(id -u)" -eq 0 ] || die "安装 systemd 服务需要 root：请用 sudo 执行，或加 --no-systemd 只准备环境。"
  need_cmd systemctl || die "本机没有 systemd（systemctl 不存在），请改用 --no-systemd。"
fi

# --- 系统识别（只读，不装任何东西）-------------------------------------------
OS_NAME="未知系统"; OS_ID=""; PKG=""; SUDO=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_NAME="${PRETTY_NAME:-${NAME:-Linux}}"
  OS_ID="${ID:-}"
fi
# 包管理器按命令探测：os-release 的家族名各发行版写法不一，命令最可靠
# （CentOS / Rocky / Alma / TencentOS / openEuler / Fedora 都是 dnf 或 yum）。
if   need_cmd apt-get; then PKG="apt-get"
elif need_cmd dnf;     then PKG="dnf"
elif need_cmd yum;     then PKG="yum"
elif need_cmd zypper;  then PKG="zypper"
elif need_cmd apk;     then PKG="apk"
fi
[ "$(id -u)" -eq 0 ] || { need_cmd sudo && SUDO="sudo"; }

CAN_INSTALL=1
if [ "$INSTALL_DEPS" -eq 0 ]; then
  CAN_INSTALL=0
  info "已指定 --skip-deps：只检查依赖、不自动安装"
elif [ -z "$PKG" ]; then
  CAN_INSTALL=0
  warn "没有找到 apt-get / dnf / yum / zypper / apk，无法自动安装依赖"
elif [ "$(id -u)" -ne 0 ] && [ -z "$SUDO" ]; then
  CAN_INSTALL=0
  warn "当前不是 root 且没有 sudo，无法自动安装依赖（改用 sudo 重跑，或手工装）"
fi
info "系统：$OS_NAME${OS_ID:+（$OS_ID）}｜包管理器：${PKG:-未识别}"

# 需求名 → 该发行版要装的包。返回非 0 = 这个发行版没有对应包（调用方给手工指引）。
# 只列真正用得上的：Python 运行时 / venv / MySQL 客户端 / 构建前端用的 Node.js。
pkgs_for() {
  case "$PKG:$1" in
    apt-get:python)    echo "python3" ;;
    apt-get:venv)      echo "python3-venv" ;;
    apt-get:pip)       echo "python3-pip" ;;
    apt-get:dev)       echo "python3-dev" ;;
    apt-get:build)     echo "build-essential" ;;
    apt-get:mysql-cli) echo "default-mysql-client" ;;
    apt-get:mysql-srv) echo "default-mysql-server" ;;
    apt-get:node)      echo "nodejs" ;;
    apt-get:npm)       echo "npm" ;;
    apt-get:curl)      echo "curl" ;;
    apt-get:tar)       echo "tar" ;;
    apt-get:gzip)      echo "gzip" ;;
    # RHEL 支系（dnf / yum / zypper / apk）包名基本一致，合在一起写
    dnf:python|yum:python|zypper:python|apk:python)          echo "python3" ;;
    # RHEL 的 venv 靠 python3-pip 带进来的 ensurepip；Debian 是独立的 python3-venv
    dnf:venv|yum:venv|zypper:venv|apk:venv)                  echo "python3-pip" ;;
    dnf:pip|yum:pip|zypper:pip|apk:pip)                      echo "python3-pip" ;;
    dnf:dev|yum:dev|zypper:dev|apk:dev)                      echo "python3-devel" ;;
    dnf:build|yum:build|zypper:build|apk:build)              echo "gcc" ;;
    dnf:mysql-cli|yum:mysql-cli|zypper:mysql-cli|apk:mysql-cli) echo "mariadb" ;;
    dnf:mysql-srv|yum:mysql-srv|zypper:mysql-srv|apk:mysql-srv) echo "mariadb-server" ;;
    dnf:node|yum:node|zypper:node|apk:node)                  echo "nodejs" ;;
    dnf:npm|yum:npm|zypper:npm|apk:npm)                      echo "npm" ;;
    dnf:curl|yum:curl|zypper:curl|apk:curl)                  echo "curl" ;;
    dnf:tar|yum:tar|zypper:tar|apk:tar)                      echo "tar" ;;
    dnf:gzip|yum:gzip|zypper:gzip|apk:gzip)                  echo "gzip" ;;
    *) return 1 ;;
  esac
}

APT_UPDATED=0
# 装一批「需求名」。任何一个包名不认识就跳过它（并返回非 0），其余照装。
pkg_install() {
  local want names all=()
  for want in "$@"; do
    if names="$(pkgs_for "$want")"; then
      # shellcheck disable=SC2206
      all+=($names)
    else
      warn "本系统（${PKG:-未知}）不认识「$want」对应的包，跳过"
    fi
  done
  [ ${#all[@]} -gt 0 ] || return 1
  info "安装：${all[*]}"
  case "$PKG" in
    apt-get)
      # 只 update 一次：多轮安装时反复 update 既慢又容易撞上镜像抖动
      if [ "$APT_UPDATED" -eq 0 ]; then
        $SUDO apt-get update -qq || warn "apt-get update 失败，继续尝试安装（离线环境属正常）"
        APT_UPDATED=1
      fi
      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${all[@]}" ;;
    dnf)    $SUDO dnf install -y "${all[@]}" ;;
    yum)    $SUDO yum install -y "${all[@]}" ;;
    zypper) $SUDO zypper --non-interactive install "${all[@]}" ;;
    apk)    $SUDO apk add --no-cache "${all[@]}" ;;
    *) return 1 ;;
  esac
}

# 缺什么装什么；装不上就返回 1，由调用方决定是报错还是退让。
ensure_pkg() {
  local want="$1"
  if [ "$CAN_INSTALL" -eq 1 ]; then
    pkg_install "$want"
  else
    warn "缺少「$want」，且当前条件下不能自动安装（--skip-deps / 无包管理器 / 无 root）"
    return 1
  fi
}

# --- 基础工具：脚本自己就要用（curl 做健康检查，tar/gzip 解压前端产物）--------
for tool in curl tar gzip; do
  need_cmd "$tool" || ensure_pkg "$tool" || true
done

# --- Python 3.11+ -------------------------------------------------------------
# 与 start.sh / start-prod.sh 保持同一套候选顺序。
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
if [ -z "$PYTHON" ] && [ "$CAN_INSTALL" -eq 1 ]; then
  info "本机没有 Python 3.11+，尝试安装"
  # 发行版自带的 python3 在 Debian 12 / Ubuntu 22.04+ / RHEL 9 系上就是 3.11 或更高；
  # 老一点的 RHEL 8 系把 3.11 放在模块流里，所以下面再补一次模块流的尝试。
  pkg_install python || true
  if [ "$PKG" = "dnf" ] || [ "$PKG" = "yum" ]; then
    info "尝试启用 python311 模块流（RHEL 8 系需要）"
    $SUDO "$PKG" module reset python311    -y >/dev/null 2>&1 || true
    $SUDO "$PKG" module enable python311   -y >/dev/null 2>&1 || true
    $SUDO "$PKG" install -y python3.11 python3.11-pip >/dev/null 2>&1 || true
  fi
  PYTHON="$(find_python || true)"
fi
if [ -z "$PYTHON" ]; then
  die "未找到 Python 3.11+，且自动安装没成功。请手工装一个再重跑：
      Debian / Ubuntu : sudo apt install python3 python3-venv
      RHEL 8 / CentOS 8: sudo dnf module enable python311 && sudo dnf install python3.11 python3.11-pip
      RHEL 9 / TencentOS 4 / Rocky / Alma: sudo dnf install python3.11
      其它发行版      : 用系统包管理器装 python3 ≥ 3.11
    装好后也可以指定路径重跑：PYTHON_BIN=/usr/bin/python3.11 ./deploy.sh ..."
fi
info "Python：$PYTHON（$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")')）"

# 仓库完整性：脚本要用的三个入口文件缺一个都跑不下去。
# 提前检查而不是等 pip / npm 报「文件不存在」——那种报错看不出「需要重新拉取」。
for required in backend/requirements.txt backend/run.py package.json; do
  [ -f "$ROOT/$required" ] || die "缺少 $required，仓库不完整（建议重新 git clone 后再执行）。"
done

# --- Node.js（只有要构建前端时才需要，且要 ≥ 18：Vite 5 的下限）--------------
node_major() {
  need_cmd node || return 1
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || return 1
}

if [ "$SKIP_FRONTEND" -eq 0 ]; then
  if ! need_cmd npm || [ "$(node_major || echo 0)" -lt 18 ]; then
    if [ "$CAN_INSTALL" -eq 0 ]; then
      warn "缺少可用的 Node.js 18+，且当前条件下不能自动安装（--skip-deps / 无包管理器 / 无 root）"
    fi
    if [ "$CAN_INSTALL" -eq 1 ]; then
      info "本机没有可用的 Node.js 18+，尝试安装"
      pkg_install node npm || true
      # 发行版仓库给的 nodejs 可能低于 18（RHEL 8 默认 10/12），试着切到 20 模块流
      if [ "$(node_major || echo 0)" -lt 18 ] && { [ "$PKG" = "dnf" ] || [ "$PKG" = "yum" ]; }; then
        info "尝试启用 nodejs:20 模块流"
        $SUDO "$PKG" module reset  nodejs     -y >/dev/null 2>&1 || true
        $SUDO "$PKG" module enable nodejs:20  -y >/dev/null 2>&1 || true
        $SUDO "$PKG" install -y nodejs npm    >/dev/null 2>&1 || true
      fi
    fi
  fi

  if ! need_cmd npm || [ "$(node_major || echo 0)" -lt 18 ]; then
    die "未找到可用的 Node.js 18+，无法构建前端（当前：$(node --version 2>/dev/null || echo 无)）。三种选择：
      ① 手工装 Node.js 18+（Debian/Ubuntu：apt install nodejs npm；RHEL 系：dnf module enable nodejs:20 && dnf install nodejs npm）后重跑；
      ② 在装有 Node.js 18+ 的机器上执行 npm install && npm run build，把 dist/ 拷到 $ROOT/ 后加 --skip-frontend 重跑；
      ③ 用 nvm 装好 Node.js 后重跑本脚本。"
  fi
  info "Node.js：$(node --version 2>/dev/null || echo 未知) / npm：$(npm --version 2>/dev/null || echo 未知)"
fi

# MySQL / MariaDB 的安装与建库放到 [2/5] 步做：只有读完 .env 才知道库地址是不是
# 本机、库名账号口令是不是已经有了 —— 在这里猜等于替用户做决定。

# ---------------------------------------------------------------------------
# 1. 后端虚拟环境与依赖
# ---------------------------------------------------------------------------
step "[1/5] 准备后端虚拟环境与依赖"

if [ ! -x "$VENV/bin/python" ]; then
  info "创建虚拟环境：$VENV"
  # venv 在 Debian 系是独立包（python3-venv），RHEL 系靠 python3-pip 提供
  # ensurepip。不猜包名，直接试一次，失败了补包再试。
  if ! "$PYTHON" -m venv "$VENV" 2>/tmp/pc_venv.$$; then
    warn "创建虚拟环境失败：$(tail -n 1 /tmp/pc_venv.$$ 2>/dev/null)"
    rm -f /tmp/pc_venv.$$
    if ensure_pkg venv && "$PYTHON" -m venv "$VENV"; then
      info "补装 venv 相关包后创建成功"
    else
      die "无法创建虚拟环境。请手工安装 venv 支持后重跑：
      Debian / Ubuntu : sudo apt install python3-venv
      RHEL 系         : sudo dnf install python3-pip"
    fi
  fi
  rm -f /tmp/pc_venv.$$
fi
VPY="$VENV/bin/python"

info "安装 backend/requirements.txt（已装则跳过）"
# pip 自身升级失败不影响后面装依赖（内网可能连不上 PyPI），所以只提示不中断。
"$VPY" -m pip install -q --upgrade pip || warn "pip 自身升级失败，继续用现有版本"
"$VPY" -m pip install -q -r "$ROOT/backend/requirements.txt" \
  || {
    # 少数架构 / 发行版上没有预编译轮子，pip 会退化成从源码编译 —— 这时缺的是
    # 编译器而不是网络。补上 gcc 与 python 头文件再试一次，比直接报「网络问题」准确。
    warn "依赖安装失败，尝试补装编译工具后重试（可能是缺预编译轮子的架构）"
    if ensure_pkg build && ensure_pkg dev && \
       "$VPY" -m pip install -q -r "$ROOT/backend/requirements.txt"; then
      info "补装编译工具后安装成功"
    else
      die "后端依赖安装失败。请检查网络，或改用镜像源：
        $VPY -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r $ROOT/backend/requirements.txt"
    fi
  }

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

# 数据库参数没给就直接生成一套 —— 「零参数一键部署」的关键一步：库名与账号用默认值，
# 口令一律随机。想接现成的库/实例，用 --db-* 传进来即可（上面那段已经写回 .env）。
DB_GENERATED=0
[ -n "$(env_get DB_NAME)" ] || { env_set DB_NAME "${DB_NAME:-proxcenter_panel}"; DB_GENERATED=1; }
[ -n "$(env_get DB_USER)" ] || { env_set DB_USER "${DB_USER:-proxcenter}"; DB_GENERATED=1; }
if [ -z "$(env_get DB_PASSWORD)" ]; then
  env_set DB_PASSWORD "$("$VPY" -c 'import secrets; print(secrets.token_urlsafe(18))')"
  DB_GENERATED=1
fi
[ -n "$(env_get DB_HOST)" ] || env_set DB_HOST "127.0.0.1"
[ -n "$(env_get DB_PORT)" ] || env_set DB_PORT "3306"
if [ "$DB_GENERATED" -eq 1 ]; then
  info "数据库凭据缺失，已自动生成并写入 backend/.env（口令随机生成，不回显）"
fi

# --- 数据库：能自动装、自动建库、自动授权 -------------------------------------
DB_NAME_NOW="$(env_get DB_NAME)"
DB_USER_NOW="$(env_get DB_USER)"
DB_PASSWORD_NOW="$(env_get DB_PASSWORD)"
DB_HOST_NOW="$(env_get DB_HOST)"
DB_PORT_NOW="$(env_get DB_PORT)"
DBH="${DB_HOST_NOW:-127.0.0.1}"
DBP="${DB_PORT_NOW:-3306}"
# SQL 里的口令要转义：用户自带的口令经常含 ' 或 \，直接塞进单引号字符串会语法错。
# 自动生成的口令是 token_urlsafe（只有 - _），但手工传进来的就不好说了。
DB_PASSWORD_SQL="${DB_PASSWORD_NOW//\\/\\\\}"
DB_PASSWORD_SQL="${DB_PASSWORD_SQL//\'/\\\'}"

# 只有目标是本机时才谈得上「帮你装一个库」；远程库得由人来给地址与凭据。
db_is_local() {
  case "$DBH" in 127.0.0.1|localhost|::1) return 0 ;; *) return 1 ;; esac
}
db_listening() { (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null; }

# 试出一种能用的本机管理员连接方式。覆盖四种常见情形，按「最可能是权威凭据」排序：
#   --root-pw    命令行给了 --mysql-root-password（TCP）
#   --root-nopw  root 走 unix_socket / 免密（RHEL 系装完 MariaDB 的默认状态）
#   --debian     Debian / Ubuntu 的 debian-sys-maint（凭据在 /etc/mysql/debian.cnf）
#   --mycnf      root 家目录里存好的 .my.cnf
# 统一带 $SUDO：unix_socket 认证认的是 OS 用户，sudo 场景下必须用 root 身份去连。
find_mysql_admin() {
  if [ -n "$MYSQL_ROOT_PASSWORD" ] \
     && MYSQL_PWD="$MYSQL_ROOT_PASSWORD" $SUDO mysql -h "$DBH" -P "$DBP" -u root -e 'SELECT 1' >/dev/null 2>&1; then
    printf '%s' "--root-pw"; return 0
  fi
  if $SUDO mysql -u root -e 'SELECT 1' >/dev/null 2>&1; then
    printf '%s' "--root-nopw"; return 0
  fi
  if [ -r /etc/mysql/debian.cnf ] \
     && $SUDO mysql --defaults-file=/etc/mysql/debian.cnf -e 'SELECT 1' >/dev/null 2>&1; then
    printf '%s' "--debian"; return 0
  fi
  if [ -r "$HOME/.my.cnf" ] \
     && $SUDO mysql --defaults-file="$HOME/.my.cnf" -e 'SELECT 1' >/dev/null 2>&1; then
    printf '%s' "--mycnf"; return 0
  fi
  return 1
}

# $1 = find_mysql_admin 给出的方式；其余参数原样透传（SQL 走 stdin）。
mysql_admin() {
  local mode="$1"; shift
  case "$mode" in
    --root-pw)   MYSQL_PWD="$MYSQL_ROOT_PASSWORD" $SUDO mysql -h "$DBH" -P "$DBP" -u root "$@" ;;
    --root-nopw) $SUDO mysql -u root "$@" ;;
    --debian)    $SUDO mysql --defaults-file=/etc/mysql/debian.cnf "$@" ;;
    --mycnf)     $SUDO mysql --defaults-file="$HOME/.my.cnf" "$@" ;;
    *)           return 1 ;;
  esac
}

# 1) 客户端：建库脚本与自检都要用
if ! need_cmd mysql; then
  ensure_pkg mysql-cli || warn "装 MySQL 客户端失败，稍后跳过自动建库"
fi

# 2) 本机没有库就装一个（默认行为；--no-install-db 可关）
if db_is_local && ! db_listening "$DBH" "$DBP"; then
  if [ "$INSTALL_DB" -eq 1 ]; then
    info "本机 $DBH:$DBP 没有数据库在跑，安装 MariaDB"
    if ensure_pkg mysql-srv; then
      # 发行版里这个服务的 unit 名有 mariadb / mysqld / mysql 三种写法，挨个试
      if need_cmd systemctl; then
        for unit in mariadb mysqld mysql; do
          if systemctl cat "${unit}.service" >/dev/null 2>&1; then
            info "启动并设为开机自启：${unit}.service"
            $SUDO systemctl enable --now "$unit" >/dev/null 2>&1 \
              || warn "启动 ${unit} 失败，请手工检查：systemctl status ${unit}"
            break
          fi
        done
      else
        warn "本机没有 systemd，请手工启动 MariaDB 后重跑"
      fi
      # 首次启动要初始化数据目录（慢盘上能跑十几秒），端口不会立刻起来 —— 等它
      for _ in $(seq 1 30); do
        db_listening "$DBH" "$DBP" && break
        sleep 1
      done
      db_listening "$DBH" "$DBP" || warn "MariaDB 装好但端口还没起来（初始化可能仍在进行），稍后自检会再确认"
    else
      warn "自动安装 MariaDB 失败，请手工装好数据库后重跑"
    fi
  else
    warn "本机没有数据库在跑，且指定了 --no-install-db：请手工准备"
  fi
fi

# 3) 建库 + 建号 + 授权（幂等：重复执行不会报错，也只动这一个库）
if need_cmd mysql && db_listening "$DBH" "$DBP"; then
  ADMIN_MODE="$(find_mysql_admin || true)"
  if [ -n "$ADMIN_MODE" ]; then
    info "创建数据库 $DB_NAME_NOW 与账号 $DB_USER_NOW（管理员连接方式：$ADMIN_MODE）"
    # 口令走 MYSQL_PWD 而不是 --password：命令行参数会出现在 ps 里，
    # 也会触发 mysql 客户端的「口令不安全」告警。
    if mysql_admin "$ADMIN_MODE" <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME_NOW\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER_NOW'@'%' IDENTIFIED BY '$DB_PASSWORD_SQL';
CREATE USER IF NOT EXISTS '$DB_USER_NOW'@'localhost' IDENTIFIED BY '$DB_PASSWORD_SQL';
GRANT ALL PRIVILEGES ON \`$DB_NAME_NOW\`.* TO '$DB_USER_NOW'@'%';
GRANT ALL PRIVILEGES ON \`$DB_NAME_NOW\`.* TO '$DB_USER_NOW'@'localhost';
FLUSH PRIVILEGES;
SQL
    then
      # 建完就用面板自己的账号试连一次 —— 这是「真的能用」而不是「命令没报错」
      if MYSQL_PWD="$DB_PASSWORD_NOW" mysql -h "$DBH" -P "$DBP" \
           -u "$DB_USER_NOW" "$DB_NAME_NOW" -e 'SELECT 1' >/dev/null 2>&1; then
        info "已用面板账号连库验证通过"
      else
        # 刻意不做 ALTER USER 强行对齐口令：这个账号可能还被别的应用用着，
        # 悄悄改掉它的口令等于把别人的服务弄挂 —— 只提示，由人来决定。
        warn "建库授权完成，但用面板账号仍连不上 $DB_NAME_NOW。若该账号早已存在且口令
    与本次生成的不同，请自行确认后对齐（会同时影响这个账号的其它用途）：
      ALTER USER '$DB_USER_NOW'@'%' IDENTIFIED BY '<backend/.env 里的 DB_PASSWORD>';"
      fi
    else
      warn "自动建库失败，请手工执行下面这段 SQL：
      CREATE DATABASE IF NOT EXISTS \`$DB_NAME_NOW\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE USER IF NOT EXISTS '$DB_USER_NOW'@'%' IDENTIFIED BY '<backend/.env 里的 DB_PASSWORD>';
      GRANT ALL PRIVILEGES ON \`$DB_NAME_NOW\`.* TO '$DB_USER_NOW'@'%';"
    fi
  else
    warn "连不上数据库的管理员账号（试过 --mysql-root-password / 免密 root /
    /etc/mysql/debian.cnf / ~/.my.cnf），跳过自动建库。手工建库命令：
      mysql -u root -e \"CREATE DATABASE IF NOT EXISTS \\\`$DB_NAME_NOW\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\"
      mysql -u root -e \"CREATE USER IF NOT EXISTS '$DB_USER_NOW'@'%' IDENTIFIED BY '<backend/.env 里的 DB_PASSWORD>';\"
      mysql -u root -e \"GRANT ALL PRIVILEGES ON \\\`$DB_NAME_NOW\\\`.* TO '$DB_USER_NOW'@'%';\"
    给管理员口令也行：sudo ./deploy.sh --mysql-root-password '<root口令>'"
  fi
else
  warn "数据库不可达（$DBH:$DBP）或没有 mysql 客户端，跳过自动建库"
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
  db_problem "backend/.env 里读不到数据库配置（DB_NAME / DB_USER）。正常情况下本脚本会
    自动生成并写入 $ENV_FILE —— 出现这句通常是文件不可读或键名被改坏了。
    也可以直接显式指定后重跑：
      sudo ./deploy.sh --db-name proxcenter_panel --db-user proxcenter --db-password '<口令>'"
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
    db_problem "连不上 MySQL（$DBH:$DBP），服务即使装上也会一直重启。请确认：
      · 数据库已启动（本机：systemctl status mariadb / mysqld）
      · 地址与端口正确、防火墙已放通
      · 本机有库但没起来时，去掉 --no-install-db 重跑，脚本会尝试安装并启动它"
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
    echo "    （数据库默认会自动装/自动建库；若用了 --no-install-db 或指向远程库，请先确认库可用）"
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
echo "   数据库   : ${DB_NAME_NOW:-?} @ ${DBH:-?}:${DBP:-?}（账号 ${DB_USER_NOW:-?}）"
echo "   配置文件 : $ENV_FILE  ← 数据库口令在里面（自动生成，不回显）"
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
