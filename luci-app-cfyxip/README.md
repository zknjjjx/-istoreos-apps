# luci-app-cfyxip（Cloudflare优选IP）

在 iStoreOS / OpenWrt 路由器上扫描 Cloudflare IP，挑出**在你家网络下真的能用**、延迟低、速度快的 IP，生成 `xyip.txt`，可定时运行并推送到 GitHub，搭 Cloudflare 节点（Workers / Pages / 隧道）时直接引用 raw 地址。

## 为什么选出来的 IP 能用

很多优选工具只测 TCP 延迟（甚至只 ping），选出来的 IP 常常：握手被重置、SNI 被干扰、证书不对、能连但跑不动。本插件每个 IP 都要过五关：

1. **TCP 延迟**：连 N 次必须全通（丢包 0%），平均延迟 ≤ 上限
2. **HTTPS 真实验证**：把验证域名强制解析到这个 IP，**正常校验证书**，请求 `/cdn-cgi/trace`，必须返回 200 和机房信息（建议把验证域名设成你节点自己的域名）
3. **落地识别**：落地国家/机房取自 trace 返回的真实 `colo`，不是查 IP 库猜的；按你选的国家/机房过滤
4. **下载测速**：实际下载，低于最低速度的淘汰（延迟低但跑不动的香港节点等会在这里被筛掉）
5. **复验**：隔一会儿再验证几次，每次都要通过且机房不变

最后按速度排序取前 N 个，写成 `IP:端口#备注`：

```
104.17.149.50:443#SJC 18.33MB/s 170ms
104.16.47.229:443#LAX 18.25MB/s 168ms
```

## 功能

- 落地国家多选 / 指定机房三字码；端口多选（443、2053、2083、2087、2096、8443）
- 抽样数量、线程数、延迟上限、TCP 次数、最低速度、测速量/时长、复验次数、结果数量、备注格式均可设
- 上次的好 IP 自动参与下一轮，结果更稳定；可追加自己的 IP / 网段
- 定时扫描（每天多个时间点）、扫描后自动推送 GitHub（内容不变不提交；令牌可复用「AI 运维助手」的）
- LuCI 页面：实时进度条、结果表（机房/国家/延迟/速度/复验）、日志、立即扫描/停止/推送/查看文件
- 核心是 Go 写的单文件程序 `/usr/bin/cfyxip`（约 5 MB，无依赖），命令行也能用：`cfyxip scan`、`cfyxip push`

## 安装

从 [Releases](../../../releases) 下载对应架构：斐讯 N1 等 ARM64 用 `-arm64.apk`，x86 软路由用 `-amd64.apk`。

iStore → 手动安装 → 上传；或 `apk add --allow-untrusted luci-app-cfyxip-*.apk`。装好后在「服务 → Cloudflare优选IP」。

## 文件

| 路径 | 说明 |
|---|---|
| `/etc/config/cfyxip` | 设置 |
| `/etc/cfyxip/xyip.txt` | 结果 |
| `/etc/cfyxip/result.json` | 结果明细 |
| `/tmp/cfyxip/scan.log` | 本次扫描日志 |

## 构建

```sh
sh build/build-apk.sh 1.0.0-r1 arm64   # 或 amd64 / arm / 386，产物在 dist/
node test/mock-test.js                 # LuCI 页面模拟测试
```

## 更新记录

- **1.0.0-r1**（2026-10-13）首个版本。
