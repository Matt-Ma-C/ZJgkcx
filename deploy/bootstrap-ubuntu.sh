#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_USER="zjgkcx"
readonly APP_GROUP="zjgkcx"
readonly APP_ROOT="/srv/zjgkcx"
readonly APP_DIR="${APP_ROOT}/current"
readonly REPO_URL="https://github.com/Matt-Ma-C/ZJgkcx.git"
readonly SERVICE_FILE="/etc/systemd/system/zjgkcx.service"

log() {
  printf '\n==> %s\n' "$*"
}

if [[ "${EUID}" -ne 0 ]]; then
  printf '请使用 root 运行此脚本。\n' >&2
  exit 1
fi

log "安装基础软件"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl file git xz-utils

if ! swapon --show=NAME --noheadings | grep -qx '/swapfile'; then
  log "创建 2 GiB 交换空间，避免低内存服务器构建失败"
  if [[ -e /swapfile ]]; then
    if ! file /swapfile | grep -q 'swap file'; then
      printf '/swapfile 已存在且不是交换文件，已停止以避免覆盖。\n' >&2
      exit 1
    fi
  else
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  chmod 600 /swapfile
  swapon /swapfile
  if ! grep -qE '^/swapfile[[:space:]]' /etc/fstab; then
    printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
  fi
fi

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
fi

if (( node_major < 22 )); then
  log "从 Node.js 官方发行源安装最新 Node.js 22"
  node_workdir="$(mktemp -d)"
  curl --fail --silent --show-error --location \
    https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt \
    --output "${node_workdir}/SHASUMS256.txt"
  node_archive="$(
    awk '$2 ~ /^node-v22\..*-linux-x64\.tar\.xz$/ { print $2; exit }' \
      "${node_workdir}/SHASUMS256.txt"
  )"
  if [[ -z "${node_archive}" ]]; then
    printf '无法从 Node.js 校验文件确定 Linux x64 安装包。\n' >&2
    exit 1
  fi
  curl --fail --silent --show-error --location \
    "https://nodejs.org/dist/latest-v22.x/${node_archive}" \
    --output "${node_workdir}/${node_archive}"
  (
    cd "${node_workdir}"
    grep " ${node_archive}\$" SHASUMS256.txt | sha256sum --check -
  )
  node_version_dir="/usr/local/lib/nodejs/${node_archive%.tar.xz}"
  if [[ ! -x "${node_version_dir}/bin/node" ]]; then
    install -d -m 0755 "${node_version_dir}"
    tar -xJf "${node_workdir}/${node_archive}" \
      --strip-components=1 \
      -C "${node_version_dir}"
  fi
  ln -sfn "${node_version_dir}/bin/node" /usr/local/bin/node
  ln -sfn "${node_version_dir}/bin/npm" /usr/local/bin/npm
  ln -sfn "${node_version_dir}/bin/npx" /usr/local/bin/npx
  ln -sfn "${node_version_dir}/bin/corepack" /usr/local/bin/corepack
fi

log "准备独立的应用账户和目录"
if ! getent group "${APP_GROUP}" >/dev/null; then
  groupadd --system "${APP_GROUP}"
fi
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd \
    --system \
    --gid "${APP_GROUP}" \
    --home-dir "${APP_ROOT}" \
    --create-home \
    --shell /usr/sbin/nologin \
    "${APP_USER}"
fi
install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0755 "${APP_ROOT}"

if [[ -d "${APP_DIR}/.git" ]]; then
  log "快进更新现有代码"
  if [[ -n "$(git -C "${APP_DIR}" status --porcelain)" ]]; then
    printf '部署目录存在未提交变更，已停止以避免覆盖。\n' >&2
    exit 1
  fi
  runuser -u "${APP_USER}" -- git -C "${APP_DIR}" pull --ff-only origin main
else
  log "克隆项目"
  if [[ -e "${APP_DIR}" ]]; then
    printf '%s 已存在但不是 Git 仓库，请人工检查。\n' "${APP_DIR}" >&2
    exit 1
  fi
  runuser -u "${APP_USER}" -- git clone --depth 1 --branch main "${REPO_URL}" "${APP_DIR}"
fi

log "安装锁定依赖并构建"
runuser -u "${APP_USER}" -- env \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  NODE_OPTIONS="--max-old-space-size=1536" \
  npm --prefix "${APP_DIR}" ci --no-audit --no-fund
runuser -u "${APP_USER}" -- env \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  NODE_OPTIONS="--max-old-space-size=1536" \
  npm --prefix "${APP_DIR}" run build

log "安装并启动 systemd 服务"
install -o root -g root -m 0644 \
  "${APP_DIR}/deploy/zjgkcx.service" \
  "${SERVICE_FILE}"
systemctl daemon-reload
systemctl enable zjgkcx.service
systemctl restart zjgkcx.service

log "等待本机服务就绪"
for attempt in {1..30}; do
  if curl --fail --silent --show-error \
    --max-time 5 \
    http://127.0.0.1:3000/ \
    >/dev/null; then
    printf '应用已在 http://127.0.0.1:3000 内部运行。\n'
    systemctl --no-pager --full status zjgkcx.service
    exit 0
  fi
  sleep 1
done

printf '应用未在预期时间内就绪，最近日志如下：\n' >&2
journalctl -u zjgkcx.service -n 100 --no-pager >&2
exit 1
