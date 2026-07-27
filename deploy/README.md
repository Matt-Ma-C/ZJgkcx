# Ubuntu 24.04 部署

项目采用 `Nginx → 127.0.0.1:3000 → Vinext/Node.js → systemd` 的结构。

## 首次部署

以 `root` 登录一台全新的 Ubuntu 24.04 服务器后执行：

```bash
git clone --depth 1 https://github.com/Matt-Ma-C/ZJgkcx.git /tmp/zjgkcx-bootstrap
bash /tmp/zjgkcx-bootstrap/deploy/bootstrap-ubuntu.sh
```

脚本会：

- 创建 2 GiB 交换空间；
- 安装并校验最新 Node.js 22；
- 创建无登录权限的 `zjgkcx` 服务账户；
- 将代码部署到 `/srv/zjgkcx/current`；
- 执行 `npm ci` 和生产构建；
- 安装、启动并守护 `zjgkcx.service`；
- 仅在 `127.0.0.1:3000` 提供内部服务。

## 运维命令

```bash
systemctl status zjgkcx
journalctl -u zjgkcx -f
curl -I http://127.0.0.1:3000/
```

再次运行 `bootstrap-ubuntu.sh` 会在部署目录干净时执行快进更新，然后重新构建并重启服务。

## 备案通过后开放网站

应用部署完成后，可以提前安装 Nginx 和 Certbot：

```bash
bash /srv/zjgkcx/current/deploy/stage-nginx-ubuntu.sh
```

该脚本只启用 `127.0.0.1:8080`，并把公网配置暂存在
`/etc/nginx/sites-available/zjgkcx-public`，不会监听公网 80/443。

确认 ICP 备案已通过、`www.zjgkcx.top` 的 A 记录已指向服务器公网 IP，
且阿里云安全组已放行 TCP 80/443 后，执行：

```bash
bash /srv/zjgkcx/current/deploy/publish-after-icp.sh \
  --confirm-icp \
  --email "你的证书通知邮箱"
```

发布脚本会再次校验域名解析和应用状态，启用公网 Nginx 配置，并通过
Certbot 签发证书、强制跳转 HTTPS。任一步骤失败时会撤回本次新增的公网
站点链接。

备案审核期间不要手动启用公网 Nginx 站点，也不要将 Node.js 的 3000
端口开放到公网。原有 SSH 隧道访问方式不受影响。
