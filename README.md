# istoreos-apps

为 iStoreOS / OpenWrt 开发的 LuCI 应用插件合集。

| 插件 | 说明 | 下载 |
|---|---|---|
| [luci-app-cftunnel](luci-app-cftunnel/) | Cloudflare 隧道：不用公网 IP、不开端口，把内网服务发布到自己的域名。API 令牌一键建隧道、绑定域名、自动 DNS，自带 cloudflared | [Releases](../../releases) |
| [luci-app-opsagent](luci-app-opsagent/) | AI 运维助手：在飞书里用大白话管理路由器，DeepSeek 驱动，长连接免公网 IP；只读命令直接跑，改动类命令需你确认 | [Releases](../../releases) |
| [luci-app-cfyxip](luci-app-cfyxip/) | Cloudflare优选IP：定时扫描 Cloudflare IP，HTTPS 真实验证 + 落地机房识别 + 测速 + 复验，只留真能用的；可选落地国家，结果推送 GitHub（xyip.txt） | [Releases](../../releases) |

## 安装

新版 iStoreOS（OpenWrt 25.12 起，使用 `apk` 包管理器）：

- iStore → 手动安装 → 上传 `.apk` 文件；或
- SSH 执行：`apk add --allow-untrusted /tmp/xxx.apk`

> 旧版 iStoreOS（opkg）请用 `.ipk`；`.apk` 和 `.ipk` 不能混用，装错会报 `package format error`。

## 目录结构

```
<插件名>/
  root/       安装到设备上的文件（按设备上的路径摆放）
  control/    安装 / 卸载脚本
  build/      打包脚本
  test/       测试
.github/      自动打包发布（Actions）
```
