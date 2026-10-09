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
#    4. 不问：默认**全程不提问**，一条命令跑到底 —— 端口 / 库名 / 账号用默认值，
#       SECRET_KEY 与各口令随机生成，装完把「面板地址 + 管理员口令 + 下一步」
#       一次打印清楚。需要自己指定的走命令行参数（--port / --db-*），需要逐项
#       确认的加 --reconfigure，两条路都不必让脚本停下等输入。
#
#  用法：
#    sudo ./deploy.sh                 # 全自动：默认值 + 随机口令，装完打印账号口令
#    sudo ./deploy.sh --reconfigure   # 想自己定端口 / 库名 / 口令时用（逐项提问，回车即默认）
#    sudo ./deploy.sh --port 9000 --service proxcenter --skip-frontend
#    ./deploy.sh --no-systemd         # 只准备环境与依赖（无需 root）
#    ./deploy.sh --help
# ============================================================================
# 这个脚本用了 bash 专有语法（数组、$'\n'、local、read -s …）。Debian / Ubuntu 上
# /bin/sh 是 dash，直接 `sh deploy.sh` 会在中途报一堆莫名其妙的语法错；而
# RHEL 系的 sh 恰好是 bash，同一条命令却没事 —— 这种「换个发行版就炸」的坑要在
# 第一行拦住：发现当前 shell 不是 bash 就用 bash 重新执行自己。
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
  echo "[x] 本脚本需要 bash（当前 shell 不是 bash，且系统里找不到 bash）。" >&2
  echo "    请改用： bash $0 $*" >&2
  exit 2
fi

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
RESET_DB_PASSWORD=0   # 1 = --reset-db-password：把已存在账号的口令对齐成 .env 里的值
ASSUME_YES=0          # 1 = --yes：不提问（现在这就是默认行为，保留参数兼容旧脚本）
RECONFIGURE=0         # 1 = --reconfigure：逐项提问一遍（默认值取自现有 .env，SECRET_KEY 不动）
INTERACTIVE=0         # 只有 --reconfigure 且有终端时才置 1，见下面的判定
ADMIN_PASSWORD_INPUT=""   # 交互里填的初始管理员口令；留空则随机生成
DB_NAME="${DB_NAME:-}"
DB_USER="${DB_USER:-}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_HOST="${DB_HOST:-}"
DB_PORT="${DB_PORT:-}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-}"
LANG_OPT=""

# --- 界面语言 -----------------------------------------------------------------
# 与前端（src/i18n）、后端（backend/app/i18n.py）**同一套约定**：
# 中文是源文案，英文译文放在下面的 MSG_EN 里查表，查不到就原样返回中文。
# 所以漏翻一条不会让脚本崩掉，只会在英文界面下继续显示中文 —— 与后端
# tr() 的兜底行为一致，不会出现「因为少一句译文就装不上」的情况。
#
# 优先级：--lang > PROXCENTER_LANG > $LC_ALL/$LC_MESSAGES/$LANG > 中文
LANG_UI="zh"

resolve_lang() {
  local want="$LANG_OPT"
  [ -n "$want" ] || want="${PROXCENTER_LANG:-}"
  if [ -z "$want" ]; then
    case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
      en|en_US|en_US.*|en_GB|en_GB.*) want="en" ;;
      *) want="zh" ;;
    esac
  fi
  case "$want" in
    en|en-US|en_US|en-GB|en_GB|english) LANG_UI="en" ;;
    *) LANG_UI="zh" ;;
  esac
}

# 「挂着一个可交互的终端」吗？
#
# 刻意不写 `[ -r /dev/tty ]`：在**没有控制终端**的环境里（容器、cron、CI、
# 某些 IDE 的终端面板），/dev/tty 依然存在、ls 出来也是可读的 rwx，
# 可一 open 就失败并报 `No such device or address`。用 -r 判断会把这些环境
# 误判成「有终端」，于是该问的不问、不该问的乱问，输出也被搅乱。
#
# 所以这里真开一次：开得到才算数。失败时的 2>/dev/null 是必须的 ——
# 关着的 tty 会往 stderr 吐一行错误，而 set -e 下这行会直接终止脚本。
have_tty() {
  # 放在子 shell 里试，且把 2>/dev/null 写在**外面**：
  # `exec 3<>/dev/tty 2>/dev/null` 那种写法救不了 —— 重定向是按从左到右生效的，
  # 3<> 先失败，2>/dev/null 还没来得及把 stderr 收走，shell 已经把
  # 「No such device or address」打出去了。子 shell 里 fd 3 也天然不会漏给父 shell。
  ( exec 3<>/dev/tty ) 2>/dev/null
}

# 语言选择：只在「用户没指定语言 + 挂着终端」时问一次，然后照常往下自动装。
#
# 三条克制，是刻意加的：
#   1. 显式指定过（--lang / PROXCENTER_LANG）就不问 —— 用户已经说过了，再问是噪音；
#   2. 没有可交互终端就不问 —— cron / CI / 管道里提问会把部署直接卡死，
#      这条比「是否提示」重要得多；
#   3. 放在主解析循环**之后** —— --help 与未知参数要在解析阶段就说话，
#      提前插一句提问会让「看个帮助」也被问一遍。
# 读 /dev/tty 而不是 stdin：与下面的 ask() 同一套做法，stdout 被 tee 进日志、
# stdin 是管道时交互依然正常。
choose_lang() {
  resolve_lang   # 先按 --lang / 环境变量 / locale 定出默认值，供回车采纳

  [ -n "$LANG_OPT" ] && return 0
  [ -n "${PROXCENTER_LANG:-}" ] && return 0
  have_tty || return 0

  local reply="" tries=0
  while [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    # 提示语中英并列：此刻还没决定用哪种语言，只印一种的话，
    # 另一种语言的用户只能靠数字猜。语言名也照原样写 ——
    # 把「中文 / English」翻译成第三种语言反而更难认。
    printf '\n  请选择界面语言 / Choose the interface language:\n' >&2
    printf '    1) 中文\n' >&2
    printf '    2) English\n' >&2
    printf '    序号（直接回车 = 按系统语言判定）/ Number (Enter = the system-locale default) [1]: ' >&2
    reply=""
    IFS= read -r reply < /dev/tty || reply=""
    case "$reply" in
      1 | zh | cn | 中文)         LANG_UI="zh"; return 0 ;;
      2 | en | English | english) LANG_UI="en"; return 0 ;;
      '')                                return 0 ;;   # 回车 = 保持默认
    esac
    printf '    只能输入 1 或 2。/ Please enter 1 or 2.\n' >&2
  done
  # 连着三次都不认，按默认值继续 —— 不该为了界面语言把部署堵在这儿
  return 0
}

declare -A MSG_EN=(
  # ---- 启动横幅 ----
  ['本脚本需要 bash（当前 shell 不是 bash，且系统里找不到 bash）。']='This script needs bash (the current shell is not bash, and bash was not found on this system).'
  ['ProxCenter 部署']='ProxCenter deployment'
  ['部署完成']='Deployment complete'
  ['下一步：']='Next steps:'

  # ---- 运行环境 ----
  ['检查运行环境']='Checking the environment'
  ['已指定 --skip-deps：只检查依赖、不自动安装']='--skip-deps given: checking dependencies only, nothing will be installed'
  ['没有找到 apt-get / dnf / yum / zypper / apk，无法自动安装依赖']='None of apt-get / dnf / yum / zypper / apk was found, cannot install dependencies automatically'
  ['当前不是 root 且没有 sudo，无法自动安装依赖（改用 sudo 重跑，或手工装）']='Not running as root and sudo is unavailable, cannot install dependencies automatically (re-run with sudo, or install them yourself)'
  ['未识别']='unrecognised'
  ['未知']='unknown'
  ['无']='none'
  ['<本机IP>']='<this host IP>'
  ['未知参数：%s（用 --help 看用法）']='Unknown option: %s (run --help for usage)'

  # ---- 帮助文本（usage）----------------------------------------------------
  ['ProxCenter 一键部署']='ProxCenter one-click deployment'
  ['用法： sudo ./deploy.sh [选项]']='Usage: sudo ./deploy.sh [options]'
  ['选项：']='Options:'
  ['--port PORT|面板监听端口（默认沿用 .env，首次为 8080）']='--port PORT|Port the panel listens on (defaults to the value in .env, or 8080 on a first run)'
  ['--service NAME|systemd 服务名（默认 proxcenter）']='--service NAME|systemd service name (default: proxcenter)'
  ['--user USER|systemd 运行用户（默认 root）']='--user USER|User the systemd service runs as (default: root)'
  ['--skip-frontend|跳过前端构建，复用已有的 dist/（服务器上没有 Node.js 时用）']='--skip-frontend|Skip the frontend build and reuse the existing dist/ (for servers without Node.js)'
  ['--skip-deps|只检查系统依赖，不自动安装（离线 / 内网 / 想自己管依赖时用）']='--skip-deps|Only check system dependencies, install nothing (offline, intranet, or when you manage dependencies yourself)'
  ['--no-install-db|本机没有 MySQL/MariaDB 时也不代装（默认是代装的）']='--no-install-db|Do not install MySQL/MariaDB even if it is missing locally (it is installed by default)'
  ['--install-db|兼容旧用法，等于默认行为（保留参数，不再需要显式指定）']='--install-db|Kept for compatibility; this is already the default behaviour'
  ['--reset-db-password|把数据库账号的口令对齐成 .env 里的值（账号被别的应用共用时别用）']='--reset-db-password|Align the database account password with the value in .env (do not use it when the account is shared with another application)'
  ['-y, --yes|不提问，全部用默认值（**这就是默认行为**，保留参数以便旧脚本）']='-y, --yes|Ask nothing and use every default (**this is already the default**; kept so older scripts keep working)'
  ['--reconfigure|逐项提问一遍；默认值取自现有配置，回车即保持不变']='--reconfigure|Ask for each value; defaults come from the current configuration and pressing Enter keeps them'
  ['--no-systemd|只准备虚拟环境 / 依赖 / .env / 前端产物，不装服务（无需 root）']='--no-systemd|Only prepare the virtualenv, dependencies, .env and frontend build; install no service (no root needed)'
  ['--db-host HOST|数据库地址（默认 127.0.0.1）']='--db-host HOST|Database host (default: 127.0.0.1)'
  ['--db-port PORT|数据库端口（默认 3306）']='--db-port PORT|Database port (default: 3306)'
  ['--db-name NAME|面板数据库名（默认 proxcenter_panel）']='--db-name NAME|Database name for the panel (default: proxcenter_panel)'
  ['--db-user USER|面板数据库账号（默认 proxcenter）']='--db-user USER|Database user for the panel (default: proxcenter)'
  ['--db-password PASS|面板数据库口令（默认随机生成）']='--db-password PASS|Database password for the panel (generated randomly by default)'
  ['--mysql-root-password P|仅用于自动建库建号的 MySQL 管理员口令（选填）']='--mysql-root-password P|MySQL administrator password, used only to create the database and grant rights (optional)'
  ['--lang LANG|界面语言：zh 或 en（默认按系统语言判定）']='--lang LANG|Interface language: zh or en (defaults to the system locale)'
  ['-h, --help|显示本帮助']='-h, --help|Show this help'
  ['没指定语言时会先问一句']='When no language is given, the script asks first'
  ['直接在命令上给 --lang 时不会再问；没有终端（cron / CI / 管道）也不问，按系统语言（$LC_ALL / $LANG）静默判定。']='It does not ask when --lang is given on the command line, nor when there is no terminal (cron / CI / a pipe); in that case the system locale ($LC_ALL / $LANG) decides silently.'
  ['环境变量同名可用：DB_NAME / DB_USER / DB_PASSWORD / DB_HOST / DB_PORT / MYSQL_ROOT_PASSWORD']='The same names also work as environment variables: DB_NAME / DB_USER / DB_PASSWORD / DB_HOST / DB_PORT / MYSQL_ROOT_PASSWORD'
  ['交互：']='Interactive mode:'
  ['**默认不提问。** sudo ./deploy.sh 会一条命令跑到底：端口用 8080、库名用
  proxcenter_panel、账号用 proxcenter，SECRET_KEY / 数据库口令 / 管理员口令全部随机生成
  （后端要求「首次建号口令」至少 12 位且不是常见弱口令，所以这里必须给随机强口令）。
  装完最后一屏会把面板地址、管理员账号与初始口令打印出来 —— 口令只显示这一次，
  请登录后立即在「个人中心 → 修改密码」里改掉。
  要自己指定参数：加 --port / --db-* 等（仍然不提问）；
  要逐项确认：加 --reconfigure（默认值取自现有 backend/.env，回车即保持不变）。
  重复执行只覆盖命令行显式给的值，不会动已有配置。
  没有终端（cron / CI / 管道）时不提问，全部用默认值。']='**It asks nothing by default.** sudo ./deploy.sh runs all the way through in one command: port 8080, database
  proxcenter_panel, user proxcenter, and randomly generated SECRET_KEY / database password /
  administrator password (the backend requires the initial administrator password to be at
  least 12 characters and not a common weak password, so it has to be a strong random one).
  The last screen prints the panel address, the administrator account and the initial password —
  the password is shown only once, so change it under "Profile → Change password" right after
  signing in.
  To choose values yourself, pass --port / --db-* and friends (still without questions);
  to be asked about each one, add --reconfigure (defaults come from the existing backend/.env,
  and pressing Enter keeps them).
  Re-running only overwrites values given explicitly on the command line.
  Without a terminal (cron / CI / a pipe) nothing is asked and every default is used.'
  ['示例：']='Examples:'
  ['# 最常见的用法：全自动一键部署（不提问；缺依赖就装，缺库就装 MariaDB，口令随机）']='# The common case: fully automatic (no questions; missing dependencies are installed, a missing database gets MariaDB, passwords are random)'
  ['# 想自己定端口 / 库名 / 口令：逐项提问，回车即用默认值']='# To pick the port / database name / password yourself: asked one by one, Enter accepts the default'
  ['# 数据库已经有人管（远程库 / 已有实例），只填面板要用的凭据']='# When the database is already managed elsewhere (remote host, existing instance), just supply the credentials'
  ['强口令']='a-strong-password'
  ['# 只更新代码后重新部署（复用已有 .env 与 dist）']='# To redeploy after a code update (reusing the existing .env and dist)'
  ['# 没有 root 权限 / 不想装服务：只把环境和依赖备好']='# Without root, or when you do not want a service: prepare the environment and dependencies only'

  # ---- 交互提问（--reconfigure）--------------------------------------------
  ['回车保留已设置的值']='press Enter to keep the value already set'
  ['面板监听端口']='Port the panel listens on'
  ['数据库名']='Database name'
  ['数据库账号']='Database user'
  ['数据库口令（留空 = 随机生成）']='Database password (empty = generate a random one)'
  ['MySQL 管理员口令（留空 = 试本机免密凭据；只用于建库授权）']='MySQL administrator password (empty = try the local passwordless credentials; only used to grant rights)'
  ['面板初始管理员口令（admin 用；留空 = 随机生成）']='Initial password for the panel administrator (used by admin; empty = generate a random one)'
  ['面板管理员口令（留空 = 不改）']='Panel administrator password (empty = leave it unchanged)'
  ['本机没有数据库时自动安装 MariaDB 并启动']='Install and start MariaDB automatically when this machine has no database'
  ['面板管理员（admin）口令（至少 12 位；留空 = 随机生成）']='Password for the panel administrator (admin), at least 12 characters (empty = generate a random one)'

  # ---- 故障排查用的「标签|命令」对照表（print_hint_list）--------------------
  ['Debian / Ubuntu|sudo apt install python3 python3-venv']='Debian / Ubuntu|sudo apt install python3 python3-venv'
  ['RHEL 8 / CentOS 8|sudo dnf module enable python311 && sudo dnf install python3.11 python3.11-pip']='RHEL 8 / CentOS 8|sudo dnf module enable python311 && sudo dnf install python3.11 python3.11-pip'
  ['RHEL 9 / TencentOS 4 / Rocky / Alma|sudo dnf install python3.11']='RHEL 9 / TencentOS 4 / Rocky / Alma|sudo dnf install python3.11'
  ['其它发行版|用系统包管理器装 python3 ≥ 3.11']='Other distributions|install python3 ≥ 3.11 with your package manager'
  ['Debian / Ubuntu|sudo apt install python3-venv']='Debian / Ubuntu|sudo apt install python3-venv'
  ['RHEL 系|sudo dnf install python3-pip']='RHEL family|sudo dnf install python3-pip'

  # ---- 故障排查的长提示 ----------------------------------------------------
  ['未找到 Python 3.11+，且自动安装没成功。请手工装一个再重跑：']='No Python 3.11+ was found and installing it automatically did not work. Install one and re-run:'
  ['装好后也可以指定路径重跑：PYTHON_BIN=/usr/bin/python3.11 ./deploy.sh ...']='Once installed you can also point at it explicitly: PYTHON_BIN=/usr/bin/python3.11 ./deploy.sh ...'
  ['无法创建虚拟环境。请手工安装 venv 支持后重跑：']='Could not create the virtualenv. Install venv support and re-run:'
  ['后端依赖安装失败。请检查网络，或改用镜像源：']='Installing the backend dependencies failed. Check the network, or use a mirror:'
  ['自动建库失败，请手工执行下面这段 SQL：']='Automatic database creation failed; run this SQL yourself:'
  ['backend/.env 里的 DB_PASSWORD']='DB_PASSWORD in backend/.env'
  ['连不上数据库的管理员账号（试过 --mysql-root-password / 免密 root / /etc/mysql/debian.cnf / ~/.my.cnf），跳过自动建库。手工建库命令：']='Could not connect to the database as administrator (tried --mysql-root-password / passwordless root / /etc/mysql/debian.cnf / ~/.my.cnf), so automatic creation is skipped. Commands to create it yourself:'
  ["给管理员口令也行：sudo ./deploy.sh --mysql-root-password '<root口令>'"]="You can also supply the administrator password: sudo ./deploy.sh --mysql-root-password '<root password>'"
  ['backend/.env 里的 SECRET_KEY 太短或仍是占位值，后端会拒绝启动。']='SECRET_KEY in backend/.env is too short or still a placeholder, and the backend will refuse to start.'
  ['它既是登录 JWT 的签名密钥，也是库里密文的加密根 ——']='It is both the signing key for login JWTs and the encryption root for the secrets stored in the database —'
  ['· 全新安装：删掉 .env 里那一行（或删掉整个 .env 重新生成）再重跑即可；']='· fresh install: delete that line from .env (or delete .env entirely to regenerate it) and re-run;'
  ['· 已有数据：换掉它会让已存的密文（PVE Token / SMTP 口令）全部解不开，确认清楚再改：']='· existing data: replacing it makes every stored secret (PVE tokens, SMTP passwords) undecryptable — change it only if you are sure:'
  ['backend/.env 里的 ADMIN_PASSWORD 偏弱，但库里已有管理员（改它不影响现有登录）；以后若要重建账号，请先换成至少 12 位的随机口令。']='ADMIN_PASSWORD in backend/.env is weak, but the database already has an administrator (changing it does not affect existing sign-ins); replace it with a random password of at least 12 characters before recreating any account.'

  # ---- Python ----
  ['本机没有 Python 3.11+，尝试安装']='No Python 3.11+ on this machine, trying to install it'
  ['尝试启用 python311 模块流（RHEL 8 系需要）']='Trying to enable the python311 module stream (needed on RHEL 8)'

  # ---- Node.js ----
  ['缺少可用的 Node.js 18+，且当前条件下不能自动安装（--skip-deps / 无包管理器 / 无 root）']='No usable Node.js 18+, and it cannot be installed automatically under the current conditions (--skip-deps / no package manager / not root)'
  ['本机没有可用的 Node.js 18+，尝试安装']='No usable Node.js 18+ on this machine, trying to install it'
  ['尝试启用 nodejs:20 模块流']='Trying to enable the nodejs:20 module stream'
  ['构建：npm run build → dist/']='Building: npm run build → dist/'

  # ---- 虚拟环境与依赖 ----
  ['[1/5] 准备后端虚拟环境与依赖']='[1/5] Preparing the backend virtualenv and dependencies'
  ['补装 venv 相关包后创建成功']='Created successfully after installing the venv packages'
  ['安装 backend/requirements.txt（已装则跳过）']='Installing backend/requirements.txt (skipped if already satisfied)'
  ['依赖安装失败，尝试补装编译工具后重试（可能是缺预编译轮子的架构）']='Dependency installation failed, retrying with build tools installed (this architecture may lack prebuilt wheels)'
  ['补装编译工具后安装成功']='Installed successfully after adding the build tools'

  # ---- 配置 ----
  ['[2/5] 准备后端配置']='[2/5] Preparing the backend configuration'
  ['已从 .env.example 生成 backend/.env']='Generated backend/.env from .env.example'
  ['backend/.env 已存在，保留现有值（只覆盖命令行显式指定的项）']='backend/.env already exists, keeping the current values (only options given on the command line are overwritten)'
  ['（--reconfigure）默认值取自现有 backend/.env，回车即保持不变；']='(--reconfigure) Defaults come from the existing backend/.env; pressing Enter keeps them unchanged;'
  ['口令留空则沿用（不会被换成新生成的）。SECRET_KEY 不动。']='leaving a password empty keeps the current one (it is never replaced with a freshly generated value). SECRET_KEY is left alone.'
  ['下面几项可以直接回车用默认值（口令留空 = 自动生成随机值）：']='You can press Enter to accept the defaults below (an empty password means a random one is generated):'
  ['数据库凭据缺失，已自动生成并写入 backend/.env（口令随机生成，不回显）']='Database credentials were missing; they have been generated and written to backend/.env (passwords are random and never echoed)'
  ['--no-systemd：继续执行，但这样生成的配置装成服务后起不来。']='--no-systemd: continuing, but a service installed from this configuration will not start.'

  # ---- 数据库 ----
  ['本机没有 systemd，请手工启动 MariaDB 后重跑']='This machine has no systemd; start MariaDB yourself and re-run'
  ['自动安装 MariaDB 失败，请手工装好数据库后重跑']='Automatic MariaDB installation failed; install the database yourself and re-run'
  ['本机没有数据库在跑，且指定了 --no-install-db：请手工准备']='No database is running locally and --no-install-db was given: please prepare one yourself'
  ['已用面板账号连库验证通过']='Verified by connecting to the database with the panel account'
  ['已生成随机 SECRET_KEY']='Generated a random SECRET_KEY'
  ['backend/.env 里的 ADMIN_PASSWORD 为空或太弱，而库里还没有管理员 ——']='ADMIN_PASSWORD in backend/.env is empty or too weak, and the database has no administrator yet —'
  ['后端会以「首次建号口令过弱」为由拒绝启动（至少 12 位，且不能是常见弱口令）。']='the backend will refuse to start because the initial password is too weak (at least 12 characters, and not a common weak password).'
  ['已自动生成面板管理员（admin）的初始口令（装完在结尾打印一次）']='Generated the initial password for the panel administrator (admin) (printed once at the end)'
  ['已写入 backend/.env 的 ADMIN_PASSWORD']='Wrote ADMIN_PASSWORD to backend/.env'
  ['太短或太常见，请再试一次（至少 12 位）']='Too short or too common, please try again (at least 12 characters)'
  ['配置预检通过']='Configuration pre-check passed'
  ['后端拒绝了这份配置（原文如下）：']='The backend rejected this configuration (message below):'

  # ---- 前端构建 ----
  ['[3/5] 准备前端构建产物']='[3/5] Preparing the frontend build'
  ['跳过构建，复用已有 dist/']='Skipping the build, reusing the existing dist/'
  ['安装前端依赖（已满足时很快）']='Installing frontend dependencies (quick when already satisfied)'

  # ---- systemd ----
  ['[4/5] 跳过 systemd（--no-systemd）']='[4/5] Skipping systemd (--no-systemd)'
  ['服务已启动并设为开机自启']='Service started and enabled at boot'

  # ---- 健康检查 ----
  ['[5/5] 健康检查']='[5/5] Health check'
  ['未安装服务，跳过（起服务后自行访问 /api/health 即可）']='No service installed, skipping (once it runs, visit /api/health yourself)'
  ['健康检查未通过（服务没起来，或在反复重启）。先把最近的日志抓出来：']='Health check failed (the service did not start, or it is restarting repeatedly). Here are the most recent logs:'
  ['怎么读这几段：']='How to read these:'
  ['    ·「面板启动被拒绝」→ .env 配置问题，后面那句已写明改哪个键']='    · "Panel startup was rejected" → a backend/.env problem; the message names the key to change'
  ['    · Access denied for user      → 数据库账号/授权不对（带 --db-* 重跑可改写 .env）']='    · Access denied for user      → wrong database account or grants (re-run with --db-* to rewrite .env)'
  ["    · Can't connect to MySQL      → 数据库没起（本机：systemctl status mariadb）"]="    · Can't connect to MySQL      → the database is not running (locally: systemctl status mariadb)"
  ['    · ModuleNotFoundError / 找不到 app → 依赖没装好，去掉 --skip-deps 重跑']='    · ModuleNotFoundError / app not found → dependencies are incomplete; re-run without --skip-deps'

  # ---- 结尾提示 ----
  ['★ 初始管理员口令（只显示这一次）：']='★ Initial administrator password (shown only this once):'
  ['请立即登录后改掉：右上角用户名 →「个人中心」→ 修改密码。']='Change it right after signing in: top-right username → "Profile" → Change password.'
  ['（管理员也可以去「设置 → 用户管理」给自己重置密码。）']='(Administrators can also reset it under "Settings → Users".)'
  ['库里已有管理员时，本次只改了 backend/.env，现有登录口令不变。']='When the database already has an administrator, only backend/.env was changed and existing passwords still work.'
  ['1) 用上面的账号登录，先改掉初始口令；']='1) Sign in with the account above and change the initial password;'
  ['2) 在「设置 → Proxmox 连接配置」填入 PVE 地址与 API Token；']='2) Add the PVE address and API token under "Settings → Proxmox connection";'
  ['3) 公网访问：按 README「用 Nginx 上 HTTPS」配好反代与证书，再在']='3) For public access, set up the reverse proxy and certificate as described in the README ("put it behind Nginx with HTTPS"), then'

  # ---- 带变量的整句（tf）----------------------------------------------------
  # 键是中文模板，%s 按「含义」占位；英文可以自己决定语序。
  [' 仓库目录 : %s']=' Repository   : %s'
  [' 服务名   : %s']=' Service     : %s'
  ['系统：%s｜包管理器：%s']='OS: %s | package manager: %s'
  ['本系统（%s）不认识「%s」对应的包，跳过']='This system (%s) has no package for "%s"; skipping'
  ['安装：%s']='Installing: %s'
  ['缺少「%s」，且当前条件下不能自动安装（--skip-deps / 无包管理器 / 无 root）']='Missing "%s", and it cannot be installed automatically under the current conditions (--skip-deps / no package manager / not root)'
  ['Node.js：%s / npm：%s']='Node.js: %s / npm: %s'
  ['Python：%s（%s）']='Python: %s (%s)'
  ['[4/5] 安装 systemd 服务：%s']='[4/5] Installing the systemd service: %s'
  ['创建虚拟环境：%s']='Creating the virtualenv: %s'
  ['创建虚拟环境失败：%s']='Failed to create the virtualenv: %s'
  ['本机 %s:%s 没有数据库在跑，安装 MariaDB']='No database is running on %s:%s, installing MariaDB'
  ['启动并设为开机自启：%s']='Enabling and starting %s'
  ['创建数据库 %s 与账号 %s（管理员连接方式：%s）']='Creating database %s and account %s (admin connection method: %s)'
  ['（--reset-db-password）把 %s 的口令对齐成 %s 里的值']='(--reset-db-password) aligning the password of %s with the value in %s'
  ['数据库不可达（%s:%s）或没有 mysql 客户端，跳过自动建库']='Database unreachable (%s:%s) or no mysql client available, skipping automatic database creation'
  ['MySQL 可达：%s:%s / 库 %s']='MySQL reachable: %s:%s / database %s'
  ['手动启动：%s']='Start manually: %s'
  ['[4/5] 安装 systemd 服务：%s']='[4/5] Installing the systemd service: %s'
  ['服务将以 %s 运行，请确认该用户能读 %s（含 .venv / dist / backend/.env）。']='The service will run as %s; make sure that user can read %s (including .venv / dist / backend/.env).'
  ['已写入 %s']='Wrote %s'
  ['面板已就绪：%s']='Panel is ready: %s'
  ['---- journalctl -u %s（最近 40 行）----']='---- journalctl -u %s (last 40 lines)----'
  ['---- %s/logs/panel.log（最近 40 行）----']='---- %s/logs/panel.log (last 40 lines)----'
  ['    · Address already in use      → %s 被占用，用 --port 换一个']='    · Address already in use      → port %s is already taken, pick another one with --port'
  ['    持续跟踪： journalctl -u %s -f']='    Follow along: journalctl -u %s -f'
  ['   面板地址 : http://%s:%s']='   Panel      : http://%s:%s'
  ['   登录账号 : %s']='   Sign in as : %s'
  ['   API 文档 : http://%s:%s/api/docs']='   API docs  : http://%s:%s/api/docs'
  ['   数据库   : %s @ %s:%s（账号 %s）']='   Database  : %s @ %s:%s (account %s)'
  ['   配置文件 : %s  ← 数据库口令在里面（自动生成，不回显）']='   Config    : %s  ← the database password lives here (generated, never echoed)'
  ['   服务管理 : systemctl {status|restart|stop} %s']='   Service   : systemctl {status|restart|stop} %s'
  ['   日志     : journalctl -u %s -f   或   tail -f %s/logs/panel.log']='   Logs      : journalctl -u %s -f   or   tail -f %s/logs/panel.log'
  ['      backend/.env 里设 FORCE_HTTPS=true 并 systemctl restart %s。']='      set FORCE_HTTPS=true in backend/.env and run systemctl restart %s.'

  # ---- 多行的整句：单引号串可以跨行，直接原样保留原来的排版 ----------
  ['未找到可用的 Node.js 18+，无法构建前端（当前：%s）。三种选择：
      ① 手工装 Node.js 18+（Debian/Ubuntu：apt install nodejs npm；RHEL 系：dnf module enable nodejs:20 && dnf install nodejs npm）后重跑；
      ② 在装有 Node.js 18+ 的机器上执行 npm install && npm run build，把 dist/ 拷到 %s/ 后加 --skip-frontend 重跑；
      ③ 用 nvm 装好 Node.js 后重跑本脚本。']='No usable Node.js 18+ was found, so the frontend cannot be built (currently: %s). Three options:
      ① install Node.js 18+ yourself (Debian/Ubuntu: apt install nodejs npm; RHEL family: dnf module enable nodejs:20 && dnf install nodejs npm) and re-run;
      ② run npm install && npm run build on a machine that has Node.js 18+, copy dist/ to %s/, then re-run with --skip-frontend;
      ③ install Node.js with nvm and re-run this script.'
)

# t：整句查表。英文模式下查不到就原样返回中文（与后端 tr() 同一套兜底）。
t() {
  if [ "$LANG_UI" = "zh" ]; then printf '%s' "$1"; return 0; fi
  local out="${MSG_EN["$1"]-}"
  [ -n "$out" ] || out="$1"
  printf '%s' "$out"
}

# tf：带变量的整句。中文模板作为译表键，参数按「含义」顺序传入；
# 两种语言各自决定 %s 的顺序，所以英文可以自由调整语序而不用改调用点。
tf() {
  local zh="$1"; shift
  local fmt="$zh"
  [ "$LANG_UI" = "zh" ] || fmt="${MSG_EN["$zh"]-$zh}"
  # shellcheck disable=SC2059
  printf "$fmt" "$@"
}

# --- 输出helper --------------------------------------------------------------
# 这四个是全脚本唯一的输出出口，所以翻译放在这里做 —— 纯文案调用点
# 一行都不用改，只有内嵌变量的句子才需要显式走 tf。
step() { echo; echo "==> $(t "$*")"; }
info() { echo "    $(t "$*")"; }
warn() { echo "    [!] $(t "$*")" >&2; }
die()  { echo "[x] $(t "$*")" >&2; exit 1; }

# 故障排查用的「标签 : 命令」对照表。查表用的是**整行**（标签|命令），
# 译表里也存整行 —— 与 usage() 的选项表同一套做法：键天然唯一，
# 标签与命令的顺序/断行两种语言可以各自决定，命令本身两边一致、可直接复制。
# 只在失败路径用，所以一律写 stderr。
print_hint_list() {
  local line translated
  while IFS= read -r line; do
    [ -n "${line:-}" ] || continue
    translated="$(t "$line")"
    printf '      %-40s %s\n' "${translated%%|*}" "${translated#*|}" >&2
  done
  return 0
}

usage() {
  resolve_lang
  printf '%s\n\n' "$(t 'ProxCenter 一键部署')"
  printf '%s\n\n' "$(t '用法： sudo ./deploy.sh [选项]')"
  printf '%s\n' "$(t '选项：')"
  # 选项表：左边参数、右边说明。查表用的是**整行**（参数 + 说明），译表里存的
  # 也是整行 —— 键因此天然唯一（两个选项的说明文字撞车也不会互相覆盖）。
  # 于是选项列表只有这一份：加一条就是加一行，中英文说明都在译表里，不会漏。
  # 宽度固定 26 列：两个语言的参数名都是 ASCII，列宽自然对齐。
  while IFS= read -r optline; do
    [ -n "${optline:-}" ] || continue
    # 先整行翻译，再按第一个 | 拆开排版：说明的语序/长度两种语言可以各自决定，
    # 而参数名与列宽仍然对齐。
    __line="$(t "$optline")"
    printf '  %-26s %s\n' "${__line%%|*}" "${__line#*|}"
  done <<'OPTS'
--port PORT|面板监听端口（默认沿用 .env，首次为 8080）
--service NAME|systemd 服务名（默认 proxcenter）
--user USER|systemd 运行用户（默认 root）
--skip-frontend|跳过前端构建，复用已有的 dist/（服务器上没有 Node.js 时用）
--skip-deps|只检查系统依赖，不自动安装（离线 / 内网 / 想自己管依赖时用）
--no-install-db|本机没有 MySQL/MariaDB 时也不代装（默认是代装的）
--install-db|兼容旧用法，等于默认行为（保留参数，不再需要显式指定）
--reset-db-password|把数据库账号的口令对齐成 .env 里的值（账号被别的应用共用时别用）
-y, --yes|不提问，全部用默认值（**这就是默认行为**，保留参数以便旧脚本）
--reconfigure|逐项提问一遍；默认值取自现有配置，回车即保持不变
--no-systemd|只准备虚拟环境 / 依赖 / .env / 前端产物，不装服务（无需 root）
--db-host HOST|数据库地址（默认 127.0.0.1）
--db-port PORT|数据库端口（默认 3306）
--db-name NAME|面板数据库名（默认 proxcenter_panel）
--db-user USER|面板数据库账号（默认 proxcenter）
--db-password PASS|面板数据库口令（默认随机生成）
--mysql-root-password P|仅用于自动建库建号的 MySQL 管理员口令（选填）
--lang LANG|界面语言：zh 或 en（默认按系统语言判定）
-h, --help|显示本帮助
OPTS
  printf '\n%s\n' "$(t '环境变量同名可用：DB_NAME / DB_USER / DB_PASSWORD / DB_HOST / DB_PORT / MYSQL_ROOT_PASSWORD')"
  printf '\n%s\n' "$(t '交互：')"
  printf '%s\n' "$(t '**默认不提问。** sudo ./deploy.sh 会一条命令跑到底：端口用 8080、库名用
  proxcenter_panel、账号用 proxcenter，SECRET_KEY / 数据库口令 / 管理员口令全部随机生成
  （后端要求「首次建号口令」至少 12 位且不是常见弱口令，所以这里必须给随机强口令）。
  装完最后一屏会把面板地址、管理员账号与初始口令打印出来 —— 口令只显示这一次，
  请登录后立即在「个人中心 → 修改密码」里改掉。
  要自己指定参数：加 --port / --db-* 等（仍然不提问）；
  要逐项确认：加 --reconfigure（默认值取自现有 backend/.env，回车即保持不变）。
  重复执行只覆盖命令行显式给的值，不会动已有配置。
  没有终端（cron / CI / 管道）时不提问，全部用默认值。')"
  printf '  %s\n' "$(t '没指定语言时会先问一句')"
  printf '  %s\n' "$(t '直接在命令上给 --lang 时不会再问；没有终端（cron / CI / 管道）也不问，按系统语言（$LC_ALL / $LANG）静默判定。')"
  printf '\n%s\n' "$(t '示例：')"
  # 命令本身与语言无关，只有注释要翻译。
  printf '  %s\n' "$(t '# 最常见的用法：全自动一键部署（不提问；缺依赖就装，缺库就装 MariaDB，口令随机）')"
  printf '  sudo ./deploy.sh\n'
  printf '\n  %s\n' "$(t '# 想自己定端口 / 库名 / 口令：逐项提问，回车即用默认值')"
  printf '  sudo ./deploy.sh --reconfigure\n'
  printf '\n  %s\n' "$(t '# 数据库已经有人管（远程库 / 已有实例），只填面板要用的凭据')"
  printf "  sudo ./deploy.sh --db-host 10.0.0.9 --db-name proxcenter_panel --db-user proxcenter --db-password '%s'\n" \
    "$(t '强口令')"
  printf '\n  %s\n' "$(t '# 只更新代码后重新部署（复用已有 .env 与 dist）')"
  printf '  sudo ./deploy.sh --skip-frontend\n'
  printf '\n  %s\n' "$(t '# 没有 root 权限 / 不想装服务：只把环境和依赖备好')"
  printf '  ./deploy.sh --no-systemd\n'
  printf '\n'
}

# 预扫一遍 --lang：--help 与「未知参数」都发生在主解析循环里那时 LANG_OPT
# 还没赋值，所以这里先取一次语言，否则「英文用户跑 --help 看中文帮助」没意义。
# 只认 --lang X 与 --lang=X 两种写法；认错了最坏结果是回落中文，不会误事。
__prev=""
for __a in "$@"; do
  if [ "$__prev" = "--lang" ]; then LANG_OPT="$__a"; break; fi
  case "$__a" in
    --lang=*) LANG_OPT="${__a#--lang=}"; break ;;
  esac
  __prev="$__a"
done
resolve_lang

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --user) RUN_USER="${2:-}"; shift 2 ;;
    --skip-frontend) SKIP_FRONTEND=1; shift ;;
    --skip-deps) INSTALL_DEPS=0; shift ;;
    --install-db) INSTALL_DB=1; shift ;;
    --no-install-db) INSTALL_DB=0; shift ;;
    --reset-db-password) RESET_DB_PASSWORD=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --reconfigure) RECONFIGURE=1; shift ;;
    --no-systemd) USE_SYSTEMD=0; shift ;;
    --db-host) DB_HOST="${2:-}"; shift 2 ;;
    --db-port) DB_PORT="${2:-}"; shift 2 ;;
    --db-name) DB_NAME="${2:-}"; shift 2 ;;
    --db-user) DB_USER="${2:-}"; shift 2 ;;
    --db-password) DB_PASSWORD="${2:-}"; shift 2 ;;
    --mysql-root-password) MYSQL_ROOT_PASSWORD="${2:-}"; shift 2 ;;
    --lang) LANG_OPT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "$(tf '未知参数：%s（用 --help 看用法）' "$1")" ;;
  esac
done

# 主循环把 --lang 也认了一遍，这里再定一次语言：预扫只为了 --help / 未知参数
# 能说对语言，真正生效的取值以主循环解析出来的 LANG_OPT 为准。
resolve_lang

# 没指定语言且挂着终端时，问一句就往下走。必须在下面任何输出之前 ——
# 横幅、步骤名、结尾汇总全都要跟着选出来的语言走。
choose_lang

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# --- 交互提问 -----------------------------------------------------------------
# 默认**不提问**（见文件头的原则 4）：一条命令跑到底，装完把账号口令打印出来。
# 只有显式 --reconfigure 才逐项提问，且必须有终端 —— 加 -y 或读不到 /dev/tty
# （cron / CI / 管道）时仍旧走默认值，脚本永远不会卡在等输入上。
# 注意方向：默认值是 0，这里要**显式打开**（早先默认是开、判定只负责关，改默认值
# 时很容易漏掉另一半 —— 那样 --reconfigure 会变成空操作）。
# 提示写 stderr、输入读 /dev/tty —— 这样即使 stdout 被 tee 进日志，交互也照常。
if [ "$RECONFIGURE" -eq 1 ] && [ "$ASSUME_YES" -ne 1 ] && have_tty; then
  INTERACTIVE=1
else
  INTERACTIVE=0
fi

# 普通提问：显示默认值，直接回车即接受
# 提示语在这一层统一翻译：调用点有十来处（全在 --reconfigure 分支里），
# 逐个包 t() 容易漏，而漏一条就是「英文界面里冒出一句中文提问」。
ask() {
  local prompt="$1" default="$2" reply=""
  [ "$INTERACTIVE" -eq 1 ] || { printf '%s' "$default"; return 0; }
  printf '    %s [%s]: ' "$(t "$prompt")" "$default" >&2
  IFS= read -r reply < /dev/tty || reply=""
  printf '%s' "${reply:-$default}"
}

# 口令提问：不回显，也不把已有值打到屏幕上（只写「回车保留」）
ask_secret() {
  local prompt="$1" default="$2" reply=""
  [ "$INTERACTIVE" -eq 1 ] || { printf '%s' "$default"; return 0; }
  if [ -n "$default" ]; then
    printf '    %s [%s]: ' "$(t "$prompt")" "$(t '回车保留已设置的值')" >&2
  else
    printf '    %s: ' "$(t "$prompt")" >&2
  fi
  IFS= read -r -s reply < /dev/tty || reply=""
  printf '\n' >&2
  printf '%s' "${reply:-$default}"
}

# 是/否提问：返回 0 = 是（回车取默认值）
ask_yesno() {
  local prompt="$1" default="${2:-y}" reply="" hint="Y/n"
  [ "$default" = "y" ] || hint="y/N"
  [ "$INTERACTIVE" -eq 1 ] || { [ "$default" = "y" ]; return $?; }
  printf '    %s [%s]: ' "$(t "$prompt")" "$hint" >&2
  IFS= read -r reply < /dev/tty || reply=""
  case "${reply:-$default}" in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

# 从 backend/.env 读一个键（不存在则输出空串）
#
# 解析规则刻意与 python-dotenv（后端 pydantic-settings 用的就是它）保持一致：
# 去掉值两侧空白、剥掉一层成对引号、未加引号时把「 #」之后当注释截掉。
# 两边规则不一致的后果很隐蔽：脚本用完整值去建库、应用用截断值来连 ——
# 命令全绿，装完服务才 Access denied。
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  "$VPY" - "$ENV_FILE" "$1" <<'PY'
import pathlib, sys
path, key = sys.argv[1], sys.argv[2]
for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#") or not line.startswith(key + "="):
        continue
    value = line.split("=", 1)[1].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]          # 成对引号：原样取值，里面的 # 是内容
    elif " #" in value:
        value = value.split(" #", 1)[0].rstrip()   # 未加引号：空格+# 起是注释
    print(value)
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
echo " $(t 'ProxCenter 部署')"
echo "$(tf ' 仓库目录 : %s' "$ROOT")"
echo "$(tf ' 服务名   : %s' "$SERVICE")"
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

# 系统名带上发行版 ID。括号用半角：发行版 ID 是标识符的一部分而不是正文，
# 中文界面下写成「（TencentOS 4）」和后面的「｜」挤在一起反而不匀。
os_label="$OS_NAME"
[ -n "$OS_ID" ] && os_label="$OS_NAME ($OS_ID)"

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
info "$(tf '系统：%s｜包管理器：%s' "$os_label" "${PKG:-$(t '未识别')}")"

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
    # 图形验证码用系统 TTF 画字；没有字体时靠 Pillow 内置字体兜底（字会小一圈）
    apt-get:fonts)     echo "fonts-dejavu-core" ;;
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
    dnf:fonts|yum:fonts|zypper:fonts)                        echo "dejavu-sans-fonts" ;;
    apk:fonts)                                               echo "ttf-dejavu" ;;
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
      warn "$(tf '本系统（%s）不认识「%s」对应的包，跳过' "${PKG:-$(t '未知')}" "$want")"
    fi
  done
  [ ${#all[@]} -gt 0 ] || return 1
  info "$(tf '安装：%s' "${all[*]}")"
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
    warn "$(tf '缺少「%s」，且当前条件下不能自动安装（--skip-deps / 无包管理器 / 无 root）' "$want")"
    return 1
  fi
  }

# --- 基础工具：脚本自己就要用（curl 做健康检查，tar/gzip 解压前端产物）--------
for tool in curl tar gzip; do
  need_cmd "$tool" || ensure_pkg "$tool" || true
done

# 一个 TTF 字体：图形验证码要靠系统字体画字。代码里对「一个字都没有」有兜底
# （改用 Pillow 内置的可缩放字体），但装了字体渲染效果更好，也不影响其它绘图功能。
if ! ls /usr/share/fonts/**/*.ttf >/dev/null 2>&1; then
  ensure_pkg fonts || warn "没装字体，图形验证码将使用 Pillow 内置字体（能看清，但不如系统字体好看）"
fi

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
  echo "[x] $(t '未找到 Python 3.11+，且自动安装没成功。请手工装一个再重跑：')" >&2
  print_hint_list <<'CMDS'
Debian / Ubuntu|sudo apt install python3 python3-venv
RHEL 8 / CentOS 8|sudo dnf module enable python311 && sudo dnf install python3.11 python3.11-pip
RHEL 9 / TencentOS 4 / Rocky / Alma|sudo dnf install python3.11
其它发行版|用系统包管理器装 python3 ≥ 3.11
CMDS
  echo "    $(t '装好后也可以指定路径重跑：PYTHON_BIN=/usr/bin/python3.11 ./deploy.sh ...')" >&2
  exit 1
fi
info "$(tf 'Python：%s（%s）' "$PYTHON" "$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")')")"

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
    die "$(tf '未找到可用的 Node.js 18+，无法构建前端（当前：%s）。三种选择：
      ① 手工装 Node.js 18+（Debian/Ubuntu：apt install nodejs npm；RHEL 系：dnf module enable nodejs:20 && dnf install nodejs npm）后重跑；
      ② 在装有 Node.js 18+ 的机器上执行 npm install && npm run build，把 dist/ 拷到 %s/ 后加 --skip-frontend 重跑；
      ③ 用 nvm 装好 Node.js 后重跑本脚本。' "$(node --version 2>/dev/null || echo "$(t '无')")" "$ROOT")"
  fi
  info "$(tf 'Node.js：%s / npm：%s' \
    "$(node --version 2>/dev/null || echo "$(t '未知')")" \
    "$(npm --version 2>/dev/null || echo "$(t '未知')")")"
fi

# MySQL / MariaDB 的安装与建库放到 [2/5] 步做：只有读完 .env 才知道库地址是不是
# 本机、库名账号口令是不是已经有了 —— 在这里猜等于替用户做决定。

# ---------------------------------------------------------------------------
# 1. 后端虚拟环境与依赖
# ---------------------------------------------------------------------------
step "[1/5] 准备后端虚拟环境与依赖"

if [ ! -x "$VENV/bin/python" ]; then
  info "$(tf '创建虚拟环境：%s' "$VENV")"
  # venv 在 Debian 系是独立包（python3-venv），RHEL 系靠 python3-pip 提供
  # ensurepip。不猜包名，直接试一次，失败了补包再试。
  if ! "$PYTHON" -m venv "$VENV" 2>/tmp/pc_venv.$$; then
    warn "$(tf '创建虚拟环境失败：%s' "$(tail -n 1 /tmp/pc_venv.$$ 2>/dev/null)")"
    rm -f /tmp/pc_venv.$$
    if ensure_pkg venv && "$PYTHON" -m venv "$VENV"; then
      info "补装 venv 相关包后创建成功"
    else
      echo "[x] $(t '无法创建虚拟环境。请手工安装 venv 支持后重跑：')" >&2
      print_hint_list <<'CMDS'
Debian / Ubuntu|sudo apt install python3-venv
RHEL 系|sudo dnf install python3-pip
CMDS
      exit 1
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
      echo "[x] $(t '后端依赖安装失败。请检查网络，或改用镜像源：')" >&2
      echo "      $VPY -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r $ROOT/backend/requirements.txt" >&2
      exit 1
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
  FIRST_RUN=1
else
  info "backend/.env 已存在，保留现有值（只覆盖命令行显式指定的项）"
  FIRST_RUN=0
fi

# --- 逐项确认（只有 --reconfigure 才会真的提问）--------------------------------
# 不提问时这几个 ask 直接返回默认值：端口 8080 / 库名 proxcenter_panel / 账号
# proxcenter，口令留空则由下一段用随机值补上。所以自动化场景里这一段等价于
# 「全部默认」，不会停下来等输入。
if [ "$FIRST_RUN" -eq 1 ] || [ "$RECONFIGURE" -eq 1 ]; then
  # --reconfigure 时默认值取自现有 .env：一路回车就等于「什么都不改」，
  # 尤其不会把已有口令换成新生成的（那会让应用连不上库）。
  if [ "$RECONFIGURE" -eq 1 ]; then
    PORT="${PORT:-$(env_get PORT)}"
    DB_NAME="${DB_NAME:-$(env_get DB_NAME)}"
    DB_USER="${DB_USER:-$(env_get DB_USER)}"
    DB_PASSWORD="${DB_PASSWORD:-$(env_get DB_PASSWORD)}"
    if [ "$INTERACTIVE" -eq 1 ]; then
      echo
      info "（--reconfigure）默认值取自现有 backend/.env，回车即保持不变；"
      info "口令留空则沿用（不会被换成新生成的）。SECRET_KEY 不动。"
    fi
  elif [ "$INTERACTIVE" -eq 1 ]; then
    echo
    info "下面几项可以直接回车用默认值（口令留空 = 自动生成随机值）："
  fi

  PORT="$(ask "面板监听端口" "${PORT:-8080}")"
  DB_NAME="$(ask "数据库名" "${DB_NAME:-proxcenter_panel}")"
  DB_USER="$(ask "数据库账号" "${DB_USER:-proxcenter}")"
  DB_PASSWORD="$(ask_secret "数据库口令（留空 = 随机生成）" "$DB_PASSWORD")"
  MYSQL_ROOT_PASSWORD="$(ask_secret "MySQL 管理员口令（留空 = 试本机免密凭据；只用于建库授权）" "$MYSQL_ROOT_PASSWORD")"
  if [ "$FIRST_RUN" -eq 1 ]; then
    ADMIN_PASSWORD_INPUT="$(ask_secret "面板初始管理员口令（admin 用；留空 = 随机生成）" "")"
  else
    ADMIN_PASSWORD_INPUT="$(ask_secret "面板管理员口令（留空 = 不改）" "")"
  fi
  if ask_yesno "本机没有数据库时自动安装 MariaDB 并启动" "y"; then
    INSTALL_DB=1
  else
    INSTALL_DB=0
  fi
fi

# SECRET_KEY 与初始管理员口令必须是随机值：后端会拒绝占位 SECRET_KEY 与弱口令
# 启动，所以这一步不能省。SECRET_KEY 一旦确定就不要再改 —— 它是库里密文的加密根，
# 换了它，库里已存的 PVE Token / SMTP 口令就全解不开（所以重配置时绝不动它）。
if [ "$FIRST_RUN" -eq 1 ]; then
  env_set SECRET_KEY "$("$VPY" -c 'import secrets; print(secrets.token_urlsafe(48))')"
  env_set ADMIN_PASSWORD "${ADMIN_PASSWORD_INPUT:-$("$VPY" -c 'import secrets; print(secrets.token_urlsafe(16))')}"
elif [ -n "$ADMIN_PASSWORD_INPUT" ]; then
  # 已有安装：只有明确填了新口令才改
  env_set ADMIN_PASSWORD "$ADMIN_PASSWORD_INPUT"
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

# 1) 客户端：建库脚本与自检都要用
if ! need_cmd mysql; then
  ensure_pkg mysql-cli || warn "装 MySQL 客户端失败，稍后跳过自动建库"
fi

# 2) 本机没有库就装一个（默认行为；--no-install-db 可关）
if db_is_local && ! db_listening "$DBH" "$DBP"; then
  if [ "$INSTALL_DB" -eq 1 ]; then
    info "$(tf '本机 %s:%s 没有数据库在跑，安装 MariaDB' "$DBH" "$DBP")"
    if ensure_pkg mysql-srv; then
      # 发行版里这个服务的 unit 名有 mariadb / mysqld / mysql 三种写法，挨个试
      if need_cmd systemctl; then
        for unit in mariadb mysqld mysql; do
          if systemctl cat "${unit}.service" >/dev/null 2>&1; then
            info "$(tf '启动并设为开机自启：%s' "${unit}.service")"
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
    info "$(tf '创建数据库 %s 与账号 %s（管理员连接方式：%s）' \
      "$DB_NAME_NOW" "$DB_USER_NOW" "$ADMIN_MODE")"
    # CREATE USER IF NOT EXISTS 对**已存在**的账号不会改口令 —— 这是最容易踩的一步：
    # .env 里的口令被重新生成过（例如删过 .env 再重跑），账号却还停在旧口令上，
    # 于是命令全绿、应用启动时才报 Access denied。--reset-db-password 显式对齐。
    RESET_SQL=""
    if [ "$RESET_DB_PASSWORD" -eq 1 ]; then
      info "$(tf '（--reset-db-password）把 %s 的口令对齐成 %s 里的值' "$DB_USER_NOW" "$ENV_FILE")"
      RESET_SQL="ALTER USER '$DB_USER_NOW'@'%' IDENTIFIED BY '$DB_PASSWORD_SQL';
ALTER USER '$DB_USER_NOW'@'localhost' IDENTIFIED BY '$DB_PASSWORD_SQL';"
    fi
    # 口令走 MYSQL_PWD 而不是 --password：命令行参数会出现在 ps 里，
    # 也会触发 mysql 客户端的「口令不安全」告警。
    if mysql_admin "$ADMIN_MODE" <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME_NOW\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER_NOW'@'%' IDENTIFIED BY '$DB_PASSWORD_SQL';
CREATE USER IF NOT EXISTS '$DB_USER_NOW'@'localhost' IDENTIFIED BY '$DB_PASSWORD_SQL';
GRANT ALL PRIVILEGES ON \`$DB_NAME_NOW\`.* TO '$DB_USER_NOW'@'%';
GRANT ALL PRIVILEGES ON \`$DB_NAME_NOW\`.* TO '$DB_USER_NOW'@'localhost';
$RESET_SQL
FLUSH PRIVILEGES;
SQL
    then
      # 建完就用面板自己的账号试连一次 —— 这是「真的能用」而不是「命令没报错」
      if MYSQL_PWD="$DB_PASSWORD_NOW" mysql -h "$DBH" -P "$DBP" \
           -u "$DB_USER_NOW" "$DB_NAME_NOW" -e 'SELECT 1' >/dev/null 2>&1; then
        info "已用面板账号连库验证通过"
      else
        # 这里不能自动 ALTER：账号可能被别的应用共用，悄悄改口令等于把别人的服务
        # 弄挂。但也不能只 warn —— 那样部署会「看起来成功」、装完服务才开始崩溃。
        # 所以直接失败，并把两种成因与对策写清楚（含一键开关）。
        db_problem "用面板账号连不上数据库：$DB_USER_NOW@$DBH:$DBP 库 $DB_NAME_NOW
    （服务装上后会一直重启：Access denied for user）。两种成因与对策：
      ① 账号早已存在且口令与 .env 里的不同 —— CREATE USER IF NOT EXISTS 不会改口令，
         而 .env 的口令可能被重新生成过（删过 .env 再重跑）。该账号没被别的应用共用时：
              sudo ./deploy.sh --reset-db-password
      ② .env 里 DB_PASSWORD 的写法让解析截断了（值里有 # 空格 或引号时 dotenv 会截断）。
         对比一下两边读到的长度：
              awk -F= '/^DB_PASSWORD=/{print \"env 长度\", length(\$2)}' $ENV_FILE
              cd $ROOT && ./.venv/bin/python -c \"import sys; sys.path.insert(0,'backend'); from app.config import settings; print('app 长度', len(settings.db_password))\""
      fi
    else
      warn "自动建库失败，请手工执行下面这段 SQL："
      echo "      CREATE DATABASE IF NOT EXISTS \`$DB_NAME_NOW\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" >&2
      echo "      CREATE USER IF NOT EXISTS '$DB_USER_NOW'@'%' IDENTIFIED BY '<$(t 'backend/.env 里的 DB_PASSWORD')>';" >&2
      echo "      GRANT ALL PRIVILEGES ON \`$DB_NAME_NOW\`.* TO '$DB_USER_NOW'@'%';" >&2
    fi
  else
    warn "$(t '连不上数据库的管理员账号（试过 --mysql-root-password / 免密 root / /etc/mysql/debian.cnf / ~/.my.cnf），跳过自动建库。手工建库命令：')"
    echo "      mysql -u root -e \"CREATE DATABASE IF NOT EXISTS \\\`$DB_NAME_NOW\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\"" >&2
    echo "      mysql -u root -e \"CREATE USER IF NOT EXISTS '$DB_USER_NOW'@'%' IDENTIFIED BY '<$(t 'backend/.env 里的 DB_PASSWORD')>';\"" >&2
    echo "      mysql -u root -e \"GRANT ALL PRIVILEGES ON \\\`$DB_NAME_NOW\\\`.* TO '$DB_USER_NOW'@'%';\"" >&2
    echo "    $(t "给管理员口令也行：sudo ./deploy.sh --mysql-root-password '<root口令>'")" >&2
  fi
else
  warn "$(tf '数据库不可达（%s:%s）或没有 mysql 客户端，跳过自动建库' "$DBH" "$DBP")"
fi

# --- 口令强度：后端会拒绝启动的两件事，在这里先说清楚并补上 ---------------------
# 规则与 app/config.py 一致：
#   SECRET_KEY      空 / 短于 32 位 / 仍是占位值  → 直接拒绝启动
#                   （它既是登录 JWT 的签名密钥，也是库里密文的加密根）
#   ADMIN_PASSWORD  空 / 短于 12 位 / 属于弱口令表 → **首次建号**时拒绝启动
# 老版本部署的 .env 里 ADMIN_PASSWORD 是留空的（.env.example 就是这么给的），只要
# 库里还没建过管理员，服务就会反复重启 —— 实测踩到过，所以这里主动处理。
ADMIN_PW_CHANGED=0

admin_pw_ok() {
  local v="$1" lower
  [ ${#v} -ge 12 ] || return 1
  lower="$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    admin123|admin|admin@123|password|passw0rd|123456|root) return 1 ;;
  esac
  return 0
}

secret_key_ok() {
  local v="$1"
  [ ${#v} -ge 32 ] || return 1
  case "$v" in change-me*|changeme|secret) return 1 ;; esac
  return 0
}

# .env 里的 ADMIN_PASSWORD 还有没有机会被用上：只有库里一个管理员都没有时，它才会
# 被拿去建号。已经建过号的部署改这里不影响现有登录，所以不该去打扰用户。
admin_still_needs_creating() {
  need_cmd mysql || return 0
  local mode count
  mode="$(find_mysql_admin || true)"
  [ -n "$mode" ] || return 0
  # 全新库连 users 表都还没有，这句会报错 —— 按「还没有管理员」处理
  count="$(mysql_admin "$mode" -N -B -e 'SELECT COUNT(*) FROM users' "$DB_NAME_NOW" 2>/dev/null || echo '')"
  case "$count" in ""|0) return 0 ;; *) return 1 ;; esac
}

if ! secret_key_ok "$(env_get SECRET_KEY)"; then
  if [ "$FIRST_RUN" -eq 1 ]; then
    env_set SECRET_KEY "$("$VPY" -c 'import secrets; print(secrets.token_urlsafe(48))')"
    info "已生成随机 SECRET_KEY"
  else
    echo "[x] $(t 'backend/.env 里的 SECRET_KEY 太短或仍是占位值，后端会拒绝启动。')" >&2
    echo "    $(t '它既是登录 JWT 的签名密钥，也是库里密文的加密根 ——')" >&2
    echo "      $(t '· 全新安装：删掉 .env 里那一行（或删掉整个 .env 重新生成）再重跑即可；')" >&2
    echo "      $(t '· 已有数据：换掉它会让已存的密文（PVE Token / SMTP 口令）全部解不开，确认清楚再改：')" >&2
    echo "        $ENV_FILE" >&2
    exit 1
  fi
fi

if admin_pw_ok "$(env_get ADMIN_PASSWORD)"; then
  :
elif admin_still_needs_creating; then
  # 库里还没有管理员 → 这份口令就是建号用的，弱了会把服务直接挡在门外
  if [ "$INTERACTIVE" -eq 1 ]; then
    warn "backend/.env 里的 ADMIN_PASSWORD 为空或太弱，而库里还没有管理员 ——"
    warn "后端会以「首次建号口令过弱」为由拒绝启动（至少 12 位，且不能是常见弱口令）。"
  fi
  tries=0
  admin_fixed=0
  while [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    reply=""
    generated=0
    if [ "$INTERACTIVE" -eq 1 ]; then
      reply="$(ask_secret "面板管理员（admin）口令（至少 12 位；留空 = 随机生成）" "")"
    fi
    if [ -z "$reply" ]; then
      reply="$("$VPY" -c 'import secrets; print(secrets.token_urlsafe(16))')"
      ADMIN_PW_CHANGED=1
      generated=1
    fi
    if admin_pw_ok "$reply"; then
      env_set ADMIN_PASSWORD "$reply"
      admin_fixed=1
      if [ "$generated" -eq 1 ]; then
        info "已自动生成面板管理员（admin）的初始口令（装完在结尾打印一次）"
      else
        info "已写入 backend/.env 的 ADMIN_PASSWORD"
      fi
      break
    fi
    warn "太短或太常见，请再试一次（至少 12 位）"
  done
  if [ "$admin_fixed" -ne 1 ]; then
    db_problem "ADMIN_PASSWORD 仍不满足强度要求，后端会拒绝启动。请手工在 $ENV_FILE 里
    设一个至少 12 位的新口令后重跑；生成一个可用：
      python -c \"import secrets; print(secrets.token_urlsafe(16))\""
  fi
else
  warn "backend/.env 里的 ADMIN_PASSWORD 偏弱，但库里已有管理员（改它不影响现有登录）；以后若要重建账号，请先换成至少 12 位的随机口令。"
fi

# 配置预检：让后端自己读一遍 .env。弱 SECRET_KEY / 弱管理员口令 / 缺项都会在这里
# 原样报出来，而不是等装完服务反复重启才发现。
if ( cd "$ROOT/backend" && "$VPY" -c 'from app.config import settings' ) 2>/tmp/pc_cfg.$$; then
  info "配置预检通过"
  rm -f /tmp/pc_cfg.$$
else
  warn "后端拒绝了这份配置（原文如下）："
  sed 's/^/    /' /tmp/pc_cfg.$$ >&2 || true
  rm -f /tmp/pc_cfg.$$
  db_problem "请按上面那句话修 $ENV_FILE 后重跑本脚本。"
fi

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
    info "$(tf 'MySQL 可达：%s:%s / 库 %s' \
      "${DB_HOST_NOW:-127.0.0.1}" "${DB_PORT_NOW:-3306}" "$DB_NAME_NOW")"
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
  # 每次都跑，不拿「node_modules 目录在不在」当判断依据 —— 目录在，不代表依赖齐。
  # 跳版本升级时（如 0.2.0 → 0.2.2）新加的包永远装不上，构建会直接报「找不到
  # 模块」，而这一步的输出看起来完全正常。依赖没变时 npm 只做一次解析就返回
  # （几秒），这点代价换掉一整类问题很划算；后端那一步一直是这么做的
  # （pip install -r requirements.txt，已满足时秒退）。
  # 注：npm ci 只在 lock 与 package.json 完全一致时可用，且会**清空** node_modules，
  # 所以这里仍用 install（配合 .npmrc 里的国内镜像）。
  info "安装前端依赖（已满足时很快）"
  (cd "$ROOT" && npm install --no-audit --no-fund)
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
  info "$(tf '手动启动：%s' "$ROOT/start-prod.sh")"
else
  step "$(tf '[4/5] 安装 systemd 服务：%s' "$SERVICE")"

  mkdir -p "$ROOT/logs"
  UNIT="/etc/systemd/system/${SERVICE}.service"

  # 非 root 运行是更安全的做法，但代价是「这个用户得能读仓库、能写日志」——
  # 脚本只能替它把 logs/ 的属主改对，仓库本身的权限（尤其是 backend/.env）
  # 只能提醒：.env 里是明文口令，权限放宽给所有人读反而更糟。
  if [ "$RUN_USER" != "root" ]; then
    id "$RUN_USER" >/dev/null 2>&1 || die "指定的运行用户 $RUN_USER 不存在。"
    chown -R "$RUN_USER" "$ROOT/logs" 2>/dev/null || true
    warn "$(tf '服务将以 %s 运行，请确认该用户能读 %s（含 .venv / dist / backend/.env）。' "$RUN_USER" "$ROOT")"
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
  info "$(tf '已写入 %s' "$UNIT")"

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
    info "$(tf '面板已就绪：%s' "$(cat /tmp/pc_health.$$ 2>/dev/null || true)")"
    rm -f /tmp/pc_health.$$
  else
    echo
    warn "健康检查未通过（服务没起来，或在反复重启）。先把最近的日志抓出来："
    echo
    echo "---- systemctl status ${SERVICE} ----"
    systemctl status "$SERVICE" --no-pager -l 2>&1 | tail -n 14 || true
    echo
    echo "$(tf '---- journalctl -u %s（最近 40 行）----' "$SERVICE")"
    journalctl -u "$SERVICE" -n 40 --no-pager 2>&1 || true
    if [ -f "$ROOT/logs/panel.log" ]; then
      echo
      echo "$(tf '---- %s/logs/panel.log（最近 40 行）----' "$ROOT")"
      tail -n 40 "$ROOT/logs/panel.log" || true
    fi
    echo
    warn "怎么读这几段："
    echo " $(t '    ·「面板启动被拒绝」→ .env 配置问题，后面那句已写明改哪个键')"
    echo " $(t '    · Access denied for user      → 数据库账号/授权不对（带 --db-* 重跑可改写 .env）')"
    echo " $(t "    · Can't connect to MySQL      → 数据库没起（本机：systemctl status mariadb）")"
    echo "$(tf '    · Address already in use      → %s 被占用，用 --port 换一个' "${PORT_NOW}")"
    echo " $(t '    · ModuleNotFoundError / 找不到 app → 依赖没装好，去掉 --skip-deps 重跑')"
    echo "$(tf '    持续跟踪： journalctl -u %s -f' "$SERVICE")"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 完成
# ---------------------------------------------------------------------------
# 面板地址尽量写成「能直接点开」的样子：这一屏就是给用户抄的，留个 <本机IP>
# 让他自己替换，等于把最后一步又推回给他。取不到就退回占位符（不猜、不硬编）。
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ -z "$LAN_IP" ]; then
  LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
fi
[ -n "$LAN_IP" ] || LAN_IP="$(t '<本机IP>')"
ADMIN_USERNAME_NOW="$(env_get ADMIN_USERNAME)"
ADMIN_USERNAME_NOW="${ADMIN_USERNAME_NOW:-admin}"

echo
echo "============================================================"
echo " $(t '部署完成')"
echo "$(tf '   面板地址 : http://%s:%s' "$LAN_IP" "$PORT_NOW")"
echo "$(tf '   登录账号 : %s' "$ADMIN_USERNAME_NOW")"
echo "$(tf '   API 文档 : http://%s:%s/api/docs' "$LAN_IP" "$PORT_NOW")"
echo "$(tf '   数据库   : %s @ %s:%s（账号 %s）' \
  "${DB_NAME_NOW:-?}" "${DBH:-?}" "${DBP:-?}" "${DB_USER_NOW:-?}")"
echo "$(tf '   配置文件 : %s  ← 数据库口令在里面（自动生成，不回显）' "$ENV_FILE")"
echo "$(tf '   服务管理 : systemctl {status|restart|stop} %s' "$SERVICE")"
echo "$(tf '   日志     : journalctl -u %s -f   或   tail -f %s/logs/panel.log' "$SERVICE" "$ROOT")"
if [ "${FIRST_RUN:-0}" -eq 1 ] || [ "${ADMIN_PW_CHANGED:-0}" -eq 1 ]; then
  echo
  echo "   $(t '★ 初始管理员口令（只显示这一次）：')"
  echo "       $(env_get ADMIN_PASSWORD)"
  echo "     $(t '请立即登录后改掉：右上角用户名 →「个人中心」→ 修改密码。')"
  echo "     $(t '（管理员也可以去「设置 → 用户管理」给自己重置密码。）')"
  echo "     $(t '库里已有管理员时，本次只改了 backend/.env，现有登录口令不变。')"
fi
echo
echo " $(t '下一步：')"
echo "   $(t '1) 用上面的账号登录，先改掉初始口令；')"
echo "   $(t '2) 在「设置 → Proxmox 连接配置」填入 PVE 地址与 API Token；')"
echo "   $(t '3) 公网访问：按 README「用 Nginx 上 HTTPS」配好反代与证书，再在')"
echo "$(tf '      backend/.env 里设 FORCE_HTTPS=true 并 systemctl restart %s。' "$SERVICE")"
echo "============================================================"
