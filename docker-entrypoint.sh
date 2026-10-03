#!/bin/sh
# ============================================================================
#  ProxCenter 容器入口脚本
#
#  只做一件事：**没提供 SECRET_KEY 时，随机生成一把并保存到数据卷**。
#
#  为什么不像数据库口令那样直接写在 docker-compose.yml 里：
#    SECRET_KEY 是登录 JWT 的签名密钥，同时也是库里密文（PVE Token、SMTP 口令）
#    的加密根。它一旦写进公开仓库，等于把这把钥匙公示给所有人 —— 任何拿到仓库的
#    人都能用同一个密钥伪造任意用户的登录态、解开别人库里的密文。
#    所以这里改成「首次启动随机生成 + 落盘复用」：对用户仍然是零配置，
#    但每个部署各有各的密钥。
#
#  落盘位置在数据卷 /app/backend/data 内，与面板数据同生共死：
#    * 容器重启 / 升级 / `docker compose down` 都不会丢；
#    * `docker compose down -v` 会连同数据库一起删掉，属于整体重置，不会出现
#      「密钥没了但密文还在」的半残状态。
#    备份数据卷时把这个文件一起备份。
# ============================================================================
set -eu

DATA_DIR="${DATA_DIR:-/app/backend/data}"
SECRET_FILE="${SECRET_FILE:-$DATA_DIR/.secret_key}"

if [ -z "${SECRET_KEY:-}" ]; then
  if [ -f "$SECRET_FILE" ]; then
    # 复用已有密钥：换掉它会让库里已存的密文全部解不开，绝不能每次启动都重生成
    SECRET_KEY="$(cat "$SECRET_FILE")"
  else
    mkdir -p "$DATA_DIR"
    # umask 先收紧再写：文件以 600 落盘，同容器内其它进程读不到
    umask 077
    SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"
    printf '%s' "$SECRET_KEY" > "$SECRET_FILE"
    echo "[i] 未提供 SECRET_KEY，已生成随机密钥并保存到 $SECRET_FILE"
    echo "    它与数据卷绑定：请随数据卷一起备份，不要在已有数据后删除或更换。"
  fi
  export SECRET_KEY
fi

# 交给 CMD（python run.py）。用 exec 让 python 成为 PID 1，
# 容器的 stop/信号才能直接送达，避免优雅退出被 shell 拦住。
exec "$@"
