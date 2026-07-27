#!/usr/bin/env bash
set -Eeuo pipefail

readonly DOMAIN="www.zjgkcx.top"
readonly EXPECTED_IP="47.110.230.76"
readonly PUBLIC_AVAILABLE="/etc/nginx/sites-available/zjgkcx-public"
readonly PUBLIC_ENABLED="/etc/nginx/sites-enabled/zjgkcx-public"

email=""
icp_confirmed=false

while (($#)); do
  case "$1" in
    --email)
      email="${2:-}"
      shift 2
      ;;
    --confirm-icp)
      icp_confirmed=true
      shift
      ;;
    *)
      printf '未知参数：%s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  printf '请使用 root 运行此脚本。\n' >&2
  exit 1
fi
if [[ "${icp_confirmed}" != true ]]; then
  printf '备案通过后才可运行；请增加 --confirm-icp 明确确认。\n' >&2
  exit 1
fi
if [[ ! "${email}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  printf '请通过 --email 提供接收证书到期通知的有效邮箱。\n' >&2
  exit 1
fi
if [[ ! -f "${PUBLIC_AVAILABLE}" ]]; then
  printf '缺少 %s，请先运行 stage-nginx-ubuntu.sh。\n' "${PUBLIC_AVAILABLE}" >&2
  exit 1
fi
if ! systemctl is-active --quiet zjgkcx.service; then
  printf '应用服务未运行，停止发布。\n' >&2
  exit 1
fi

resolved_ips="$(getent ahostsv4 "${DOMAIN}" | awk '{ print $1 }' | sort -u)"
if ! grep -qx "${EXPECTED_IP}" <<<"${resolved_ips}"; then
  printf '%s 尚未解析到 %s，当前解析结果：\n%s\n' \
    "${DOMAIN}" "${EXPECTED_IP}" "${resolved_ips:-（无）}" >&2
  exit 1
fi

created_link=false
if [[ -e "${PUBLIC_ENABLED}" || -L "${PUBLIC_ENABLED}" ]]; then
  if [[ "$(readlink -f "${PUBLIC_ENABLED}")" != "${PUBLIC_AVAILABLE}" ]]; then
    printf '%s 已存在且目标不符合预期。\n' "${PUBLIC_ENABLED}" >&2
    exit 1
  fi
else
  ln -s "${PUBLIC_AVAILABLE}" "${PUBLIC_ENABLED}"
  created_link=true
fi

rollback() {
  if [[ "${created_link}" == true && -L "${PUBLIC_ENABLED}" ]]; then
    unlink "${PUBLIC_ENABLED}"
    nginx -t
    systemctl reload nginx.service
  fi
}
trap rollback ERR

nginx -t
systemctl enable nginx.service
systemctl reload nginx.service

certbot --nginx \
  --non-interactive \
  --agree-tos \
  --redirect \
  --email "${email}" \
  -d "${DOMAIN}"

nginx -t
systemctl reload nginx.service
trap - ERR

printf '发布完成：https://%s\n' "${DOMAIN}"
