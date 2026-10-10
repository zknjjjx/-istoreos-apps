#!/bin/sh
# 构建 OpenWrt 25.12+ / 新版 iStoreOS（apk 包管理器）用的 .apk
# 用法：sh build/build-apk.sh 1.0.0-r4 [arm64|amd64|arm|386]
# 需要 Linux（x86_64 或 aarch64）、curl、unshare。cloudflared 和 apk-tools-static 缺了会自动下载。
set -e
V=${1:?用法: build-apk.sh <版本> [架构]}; ARCH=${2:-arm64}
P=$(cd "$(dirname "$0")/.." && pwd); C=$P/.cache; mkdir -p $C
case "$(uname -m)" in x86_64) HA=x86_64;; aarch64) HA=aarch64;; *) echo "不支持的构建机 $(uname -m)"; exit 1;; esac

# 1. apk-tools-static（提供 mkpkg）
if [ ! -x $C/apk.static ]; then
	U=https://dl-cdn.alpinelinux.org/alpine/edge/main/$HA
	F=$(curl -fsSL $U/ | grep -o 'apk-tools-static-[0-9][^"]*\.apk' | head -n1)
	curl -fsSL $U/$F | tar -xz -C $C sbin/apk.static 2>/dev/null; mv $C/sbin/apk.static $C/; rmdir $C/sbin
fi

# 2. cloudflared（打包进插件，免得设备上下载失败）
B=$C/cloudflared-linux-$ARCH
[ -s $B ] || curl -fL -o $B https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH
chmod 755 $B

W=$(mktemp -d); mkdir -p $W/files; cp -a $P/root/. $W/files/
mkdir -p $W/files/usr/bin; cp $B $W/files/usr/bin/cloudflared
mkdir -p $W/files/lib/apk/packages
echo /etc/config/cftunnel > $W/files/lib/apk/packages/luci-app-cftunnel.conffiles
(cd $W/files && find . -type f | sed 's#^\.##' | sort) > $W/files/lib/apk/packages/luci-app-cftunnel.list
chmod 755 $W/files/usr/libexec/cftunnel $W/files/etc/init.d/cftunnel
O=luci-app-cftunnel-$V-$ARCH.apk
cd /tmp && unshare -r $C/apk.static mkpkg \
 --info "name:luci-app-cftunnel" --info "version:$V" \
 --info "description:Cloudflare Tunnel manager for LuCI (cloudflared bundled)" \
 --info "arch:noarch" --info "license:MIT" --info "origin:luci-app-cftunnel" --info "maintainer:zknjjjx" \
 --info "depends:libc luci-base" \
 --script "post-install:$P/control/postinst" --script "pre-deinstall:$P/control/prerm" --script "post-deinstall:$P/control/postrm" \
 --files $W/files --output /tmp/$O
mkdir -p $P/dist; mv /tmp/$O $P/dist/
rm -rf $W; ls -la $P/dist/$O
