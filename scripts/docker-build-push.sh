#!/usr/bin/env bash
# ============================================================================
#  ProxCenter — 本地构建 + 推送到公共仓库
#
#  这是 GitHub Actions（.github/workflows/docker.yml）之外的**手动后备路径**：
#  不想等 CI、或想把镜像推到自己私有 registry 时用它。
#
#  用法：
#    ./scripts/docker-build-push.sh                         # 版本取当前 git tag，无 tag 则 dev
#    TAG=0.2.0 ./scripts/docker-build-push.sh               # 指定版本
#    REGISTRY=docker.io IMAGE=yjscloud/proxcenter TAG=0.2.0 \
#        ./scripts/docker-build-push.sh                     # 推到 Docker Hub
#    PLATFORMS=linux/amd64 ./scripts/docker-build-push.sh   # 只构建单一架构（更快）
#    PUSH=0 ./scripts/docker-build-push.sh                  # 只构建不推送（本地验证）
#
#  关于多架构：
#    装了 docker buildx 插件 → 按 PLATFORMS 构建多架构 manifest（默认 amd64 + arm64）；
#    没装 buildx           → **自动回退**成只用经典 builder 构建本机架构并推送。
#    回退不会报错，但镜像只覆盖本机那一种架构；要 amd64 + arm64 请装 buildx：
#      https://docs.docker.com/go/buildx/   （或直接交给 GitHub Actions）
#
#  前置：
#    docker login ghcr.io      # 或 docker login（Docker Hub）
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REGISTRY="${REGISTRY:-ghcr.io}"
IMAGE="${IMAGE:-yjscloud/proxcenter}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-proxcenter-builder}"
PUSH="${PUSH:-1}"

# 版本：显式 TAG 优先；否则取当前 commit 上的 git tag（去掉 v 前缀）；都没有就 dev
if [ -z "${TAG:-}" ]; then
  TAG="$(git describe --tags --exact-match 2>/dev/null || true)"
  TAG="${TAG#v}"
  TAG="${TAG:-dev}"
fi

REF="${REGISTRY}/${IMAGE}"
VCS_REF="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

command -v docker >/dev/null 2>&1 || {
  echo "[x] 未找到 docker，请先安装：curl -fsSL https://get.docker.com | sh" >&2
  exit 1
}

# 要推的标签：形如 1.2.3 的版本额外打一个 latest
# （dev / 分支名不打，避免把开发版顶成 latest）
TAGS=("${REF}:${TAG}")
case "$TAG" in
  [0-9]*.[0-9]*.[0-9]*) TAGS+=("${REF}:latest") ;;
esac

# --tag 参数与待推送清单都从 TAGS 派生，两条路径共用，不会漏标签
TAG_ARGS=()
for t in "${TAGS[@]}"; do TAG_ARGS+=(--tag "$t"); done

echo "[i] 镜像    : ${REF}"
echo "[i] 标签    : ${TAGS[*]##*/}"
echo "[i] 推送    : $([ "$PUSH" = "1" ] && echo 是 || echo 否)"

if docker buildx version >/dev/null 2>&1; then
  # -------------------------------------------------------------- 多架构路径
  echo "[i] 平台    : ${PLATFORMS}（buildx）"
  echo

  # 多架构构建必须用 docker-container 驱动的构建器；docker 默认的 built-in 驱动不支持
  if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    echo "[i] 创建 buildx 构建器：$BUILDER"
    docker buildx create --name "$BUILDER" --use >/dev/null
  else
    docker buildx use "$BUILDER" >/dev/null
  fi

  # --push 与 --load 互斥（多架构产物是 manifest list，没法 load 进本地镜像库）：
  # 不推送时就不带目的地，仅验证「能不能构建成功」。
  if [ "$PUSH" = "1" ]; then DEST=(--push); else DEST=(); fi

  docker buildx build \
    --file Dockerfile \
    --platform "$PLATFORMS" \
    --build-arg "VERSION=${TAG}" \
    --build-arg "VCS_REF=${VCS_REF}" \
    "${TAG_ARGS[@]}" \
    "${DEST[@]}" \
    .
else
  # --------------------------------------------------- 无 buildx：单架构回退
  # 只装了 docker-ce（没装 buildx 插件）的环境里，经典 builder 依然能构建
  # 本机架构的镜像并推送 —— 比直接报错退出有用得多。
  NATIVE_ARCH="$(docker info --format '{{.Architecture}}' 2>/dev/null || echo unknown)"
  echo "[!] 未检测到 docker buildx，回退为单架构构建：linux/${NATIVE_ARCH}" >&2
  echo "    要 amd64 + arm64 多架构，请安装 buildx：https://docs.docker.com/go/buildx/" >&2
  echo

  docker build \
    --file Dockerfile \
    --build-arg "VERSION=${TAG}" \
    --build-arg "VCS_REF=${VCS_REF}" \
    "${TAG_ARGS[@]}" \
    .

  if [ "$PUSH" = "1" ]; then
    for t in "${TAGS[@]}"; do docker push "$t"; done
  fi
fi

echo
if [ "$PUSH" = "1" ]; then
  echo "[✓] 已推送：${REF}:${TAG}"
  echo "    用户部署："
  echo "      PROXCENTER_IMAGE=${REF}:${TAG} docker compose up -d"
else
  echo "[✓] 构建完成（未推送）。"
fi
