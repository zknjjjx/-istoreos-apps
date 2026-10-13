# luci-app-opsagent · AI 运维助手

在**飞书**里用大白话管理 iStoreOS / OpenWrt 路由器：查负载、看日志、重启服务……
大脑用 **DeepSeek**（任何 OpenAI 兼容接口都行），飞书走**长连接**，路由器不需要公网 IP、不用开端口。

- 纯 Python 脚本，所有架构通用（`-all.apk`），常驻内存约 30 MB
- 依赖 `python3`、`python3-websockets`（安装时自动从软件源拉取，约 20 MB）
- 适用于 OpenWrt 25.12+ / 新版 iStoreOS（apk 包管理器）

## 安全规则
| 情况 | 处理 |
|---|---|
| 只读命令（uptime、logread、uci show、ping -c…） | 直接执行 |
| 会改动系统的命令（重启服务、改配置、装包…） | 先发到飞书，你回复「确认」才执行，10 分钟过期 |
| 刷机、清盘、格式化（mtd、firstboot、dd of=/dev/…） | 一律拒绝 |
| 读取 /etc/shadow、私钥、cftunnel/opsagent 配置等 | 一律拒绝 |
| 陌生人给机器人发消息 | 拒绝，只听第一个绑定的主人 |

所有命令输出在发给 AI 之前，会抹掉 uci 里的密码/令牌、`--token`、`sk-…`、JWT 等敏感字符串。

## 安装与配置
1. 飞书开放平台建「企业自建应用」，添加**机器人**，开通权限 `im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:message`，发布版本。
2. 从 [Releases](https://github.com/zknjjjx/istoreos-apps/releases) 下载 `luci-app-opsagent-*-all.apk`，iStore → 手动安装。
3. LuCI → 服务 → **AI 运维助手**：填 App ID、App Secret、DeepSeek API Key，勾选启用，保存并应用；点「测试连接」。
4. 飞书开放平台 → 事件与回调 → 订阅方式选**使用长连接接收事件**（路由器在线才能保存）→ 添加事件**接收消息 im.message.receive_v1** → 再发布一个版本。
5. 飞书里找到机器人发「你好」，第一个发消息的人被绑定为主人。

飞书快捷指令：`状态`、`新对话`、`帮助`。

## 开发
- 本地端到端模拟（假飞书 + 假大模型）：`pip install websockets && OPSAGENT_NOSYSLOG=1 python3 test/mock-agent.py`
- 打包：`sh build/build-apk.sh 1.0.0-r1` → `dist/`
- 发布：Actions → luci-app-opsagent → Run workflow，或推送 tag `opsagent-v<版本>`

## 更新日志
- **1.0.0-r12**（2026-10-13）新增钉钉渠道：基本设置里可选「飞书 / 钉钉」，钉钉使用 Stream 长连接（无需公网 IP）；切换渠道会自动清除原主人绑定；测试连接显示钉钉状态。
- **1.0.0-r11**（2026-10-13）处理超过 8 秒先回「正在处理」，之后每 3 分钟报进度；忙的时候来新消息会提示排队；NAS 关机时秒回离线，不再干等；路由器的定时任务固定装在路由器上，不依赖 NAS；GitHub 下载走 gh-proxy 加速。
- **1.0.0-r10**（2026-10-13）新增「路由器改动免确认」开关（高级页）：开启后改配置、装软件、重启服务直接执行；刷机/清盘/格式化仍拒绝，密钥文件仍不可读。
- **1.0.0-r9**（2026-10-13）联网搜索：新增 web_search（必应，免费免注册；可选 Tavily）和 web_fetch（打开网页读正文），问天气、新闻、价格等会先搜再答并附来源；新增「联网搜索」设置页。
- **1.0.0-r8**（2026-10-13）docker/容器相关问题只在 NAS 上执行，不再误跑到路由器上触发确认；插件重启后保留对话和待确认命令（存 /tmp）。
- **1.0.0-r7**（2026-10-12）接入 Cloudflare：新增「Cloudflare」设置页，默认复用 Cloudflare 隧道插件的令牌；AI 可查看/新建隧道主机名和 DNS 记录，修改和删除需确认。
- **1.0.0-r6**（2026-10-12）接入 GitHub：新增「GitHub」设置页（Fine-grained 令牌）；AI 可查 Actions/Release、触发构建、建仓库，在 NAS 上 git clone/push 自动带凭据（不落盘）；删除类操作需确认。
- **1.0.0-r5**（2026-10-12）新增 NAS 工具：通过 SSH 让 AI 在 NAS 上长时间开发测试（默认改动免确认，格式化/清盘/删整卷仍需确认）；新增「NAS」设置页；单次最多步数默认 30。
- **1.0.0-r4**（2026-10-12）只读判断按 shell 语法逐段检查：`;`、`&&`、`>/dev/null` 组合的查询不再要求确认；可选填 AdGuard Home 账号让 AI 查拦截统计；网络抖动自动重试。
- **1.0.0-r3**（2026-10-12）「状态」改成中文排版（运行时长、负载、内存、存储、温度）。
- **1.0.0-r2**（2026-10-12）修复私聊回复失败（飞书 230101）：改为按会话 chat_id 回复。
- **1.0.0-r1**（2026-10-12）首个版本：飞书长连接、DeepSeek 工具调用、只读/确认/拒绝三级命令、主人绑定、脱敏、LuCI 设置页和日志。
