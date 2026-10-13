#!/bin/sh
# 构建 OpenWrt 25.12+ / 新版 iStoreOS（apk 包管理器）用的 luci-app-cfyxip
# 用法：sh build/build-apk.sh 1.0.0-r1 [arm64|amd64|arm|386]
# 需要：Go 1.21+（没有会自动下载到 .cache）、curl；非 root 时用 unshare -r 打包
set -e
V=${1:?用法: build-apk.sh <版本> [arm64|amd64|arm|386]}
A=${2:-arm64}
N=luci-app-cfyxip
P=$(cd "$(dirname "$0")/.." && pwd); C=$P/.cache; mkdir -p $C
case "$(uname -m)" in x86_64) HA=x86_64; GA=amd64;; aarch64) HA=aarch64; GA=arm64;; *) echo "不支持的构建机 $(uname -m)"; exit 1;; esac

GO=$(command -v go || true)
if [ -z "$GO" ]; then
	[ -x $C/go/bin/go ] || curl -fsSL https://go.dev/dl/go1.23.4.linux-$GA.tar.gz | tar -xz -C $C
	GO=$C/go/bin/go
fi
if [ ! -x $C/apk.static ]; then
	U=https://dl-cdn.alpinelinux.org/alpine/edge/main/$HA
	F=$(curl -fsSL $U/ | grep -o 'apk-tools-static-[0-9][^"]*\.apk' | head -n1)
	curl -fsSL $U/$F | tar -xz -C $C sbin/apk.static 2>/dev/null; mv $C/sbin/apk.static $C/; rmdir $C/sbin
fi

W=$(mktemp -d); mkdir -p $W/files; cp -a $P/root/. $W/files/
mkdir -p $W/files/usr/bin
GOARM=""; [ "$A" = arm ] && GOARM=7
(cd $P/src && HOME=${HOME:-/tmp} GOCACHE=${GOCACHE:-$C/gocache} GOPATH=${GOPATH:-$C/gopath} CGO_ENABLED=0 GOOS=linux GOARCH=$A GOARM=$GOARM \
	$GO build -trimpath -ldflags "-s -w -X main.Version=$V" -o $W/files/usr/bin/cfyxip .)
mkdir -p $W/files/lib/apk/packages
cp $P/control/conffiles $W/files/lib/apk/packages/$N.conffiles
(cd $W/files && find . -type f | sed 's#^\.##' | sort) > $W/files/lib/apk/packages/$N.list
chmod 755 $W/files/usr/bin/cfyxip $W/files/usr/libexec/cfyxip $W/files/etc/init.d/cfyxip
[ "$(id -u)" = 0 ] && chown -R 0:0 $W/files
O=$N-$V-$A.apk
RUN=""; [ "$(id -u)" = 0 ] || RUN="unshare -r"
cd /tmp && $RUN $C/apk.static mkpkg \
 --info "name:$N" --info "version:$V" \
 --info "description:Cloudflare preferred IP scanner with real HTTPS validation" \
 --info "arch:noarch" --info "license:MIT" --info "origin:$N" --info "maintainer:zknjjjx" \
 --info "depends:luci-base" \
 --script "post-install:$P/control/postinst" --script "pre-deinstall:$P/control/prerm" --script "post-deinstall:$P/control/postrm" \
 --files $W/files --output /tmp/$O
mkdir -p $P/dist; mv /tmp/$O $P/dist/
rm -rf $W; ls -la $P/dist/$O
