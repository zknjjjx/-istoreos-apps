# luci-app-cftunnel — Cloudflare 隧道

在 iStoreOS 的 LuCI 里管理 Cloudflare Tunnel。菜单位置：**服务 → Cloudflare 隧道**。

## 功能

- **首页**：服务状态、每条隧道的 PID 和运行时长、重启 / 全部断开、快速上手清单
- **账户配置**：填 API 令牌，「测试令牌」会检查权限够不够
- **系统设置**：开机自动连接、连接协议（HTTP/2 / QUIC / 自动）、IP 版本、下载代理
- **隧道列表**：新建 / 连接 / 断开 / 删除隧道；「公网地址」把 `子域名.域名` 指向内网服务，自动添加 CNAME
- **用令牌添加**：不想给 API 令牌，也可以粘贴 Zero Trust 网页里 `eyJ` 开头的隧道令牌
- **运行日志**：cloudflared 日志 + 常见报错说明
- 自带 cloudflared，不依赖设备联网下载；首页可一键更新

## API 令牌权限

Cloudflare 控制台 → 我的个人资料 → API 令牌 → 创建自定义令牌：

| 类型 | 权限 | 级别 |
|---|---|---|
| 账户 | Cloudflare Tunnel | 编辑 |
| 账户 | 账户设置 | 读取 |
| 区域 | DNS | 编辑 |
| 区域 | 区域 | 读取 |

## 打包

```sh
sh build/build-apk.sh 1.0.0-r4 arm64     # 输出到 dist/
```

架构可选 `arm64`（斐讯 N1 等）、`amd64`、`arm`、`386`。cloudflared 和 apk-tools-static 会自动下载到 `.cache/`。

## 测试

```sh
node test/mock-test.js root/www/luci-static/resources/view/cftunnel.js   # 模拟渲染所有页面
```

已在斐讯 N1（iStoreOS，arm64，apk 包管理）上安装验证。

## 文件

| 路径 | 作用 |
|---|---|
| `root/usr/libexec/cftunnel` | 后端：状态、Cloudflare API 代理、配置、下载更新 |
| `root/etc/init.d/cftunnel` | procd 服务，每条启用的隧道一个 cloudflared 进程 |
| `root/etc/config/cftunnel` | UCI 配置 |
| `root/www/luci-static/resources/view/cftunnel.js` | LuCI 页面 |

## 更新记录

- 1.0.0-r4：界面改为标签页，每个设置项都有提示；新增测试令牌、IP 版本、开机自动连接、运行时长、日志说明
- 1.0.0-r3：自带 cloudflared；下载可停止，卡住自动放弃
- 1.0.0-r2：改为 apk 格式，适配新版 iStoreOS
