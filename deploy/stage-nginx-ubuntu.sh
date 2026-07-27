#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/srv/zjgkcx/current"
readonly INTERNAL_AVAILABLE="/etc/nginx/sites-available/zjgkcx-internal"
readonly INTERNAL_ENABLED="/etc/nginx/sites-enabled/zjgkcx-internal"
readonly PUBLIC_AVAILABLE="/etc/nginx/sites-available/zjgkcx-public"
readonly PUBLIC_ENABLED="/etc/nginx/sites-enabled/zjgkcx-public"

if [[ "${EUID}" -ne 0 ]]; then
  printf '请使用 root 运行此脚本。\n' >&2
  exit 1
fi

if [[ ! -f "${APP_DIR}/deploy/nginx-zjgkcx-internal.conf" ]]; then
  printf '未找到部署配置，请先完成应用部署。\n' >&2
  exit 1
fi

if [[ -e "${PUBLIC_ENABLED}" || -L "${PUBLIC_ENABLED}" ]]; then
  printf '公网站点已经启用，脚本停止以避免改变现有发布状态。\n' >&2
  exit 1
fi

nginx_was_missing=false
if ! command -v nginx >/dev/null 2>&1; then
  nginx_was_missing=true
  systemctl mask nginx.service
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y certbot nginx python3-certbot-nginx

if [[ "${nginx_was_missing}" == true ]]; then
  systemctl unmask nginx.service
fi

install -o root -g root -m 0644 \
  "${APP_DIR}/deploy/nginx-zjgkcx-internal.conf" \
  "${INTERNAL_AVAILABLE}"
install -o root -g root -m 0644 \
  "${APP_DIR}/deploy/nginx-zjgkcx.conf" \
  "${PUBLIC_AVAILABLE}"

if [[ -L /etc/nginx/sites-enabled/default ]]; then
  unlink /etc/nginx/sites-enabled/default
elif [[ -e /etc/nginx/sites-enabled/default ]]; then
  printf '/etc/nginx/sites-enabled/default 不是符号链接，请人工检查。\n' >&2
  exit 1
fi

if [[ -e "${INTERNAL_ENABLED}" || -L "${INTERNAL_ENABLED}" ]]; then
  if [[ "$(readlink -f "${INTERNAL_ENABLED}")" != "${INTERNAL_AVAILABLE}" ]]; then
    printf '%s 已存在且目标不符合预期。\n' "${INTERNAL_ENABLED}" >&2
    exit 1
  fi
else
  ln -s "${INTERNAL_AVAILABLE}" "${INTERNAL_ENABLED}"
fi

nginx -t
systemctl enable nginx.service
systemctl restart nginx.service

curl --fail --silent --show-error \
  --max-time 10 \
  http://127.0.0.1:8080/ \
  >/dev/null

if ss -ltn | awk 'NR > 1 { print $4 }' | grep -Eq '(^|:)80$|(^|:)443$'; then
  printf '检测到 80 或 443 端口正在监听，已停止 Nginx 以避免备案前公网暴露。\n' >&2
  systemctl stop nginx.service
  exit 1
fi

printf 'Nginx 已配置完成，仅监听 http://127.0.0.1:8080。\n'
printf '公网配置已暂存为 %s，尚未启用。\n' "${PUBLIC_AVAILABLE}"
