#!/bin/sh
# 构建 OpenWrt 25.12+ / 新版 iStoreOS（apk 包管理器）用的 .apk（纯脚本，所有架构通用）
# 用法：sh build/build-apk.sh 1.0.0-r1
set -e
V=${1:?用法: build-apk.sh <版本>}
N=luci-app-opsagent
P=$(cd "$(dirname "$0")/.." && pwd); C=$P/.cache; mkdir -p $C
case "$(uname -m)" in x86_64) HA=x86_64;; aarch64) HA=aarch64;; *) echo "不支持的构建机 $(uname -m)"; exit 1;; esac

if [ ! -x $C/apk.static ]; then
	U=https://dl-cdn.alpinelinux.org/alpine/edge/main/$HA
	F=$(curl -fsSL $U/ | grep -o 'apk-tools-static-[0-9][^"]*\.apk' | head -n1)
	curl -fsSL $U/$F | tar -xz -C $C sbin/apk.static 2>/dev/null; mv $C/sbin/apk.static $C/; rmdir $C/sbin
fi

W=$(mktemp -d); mkdir -p $W/files; cp -a $P/root/. $W/files/
mkdir -p $W/files/lib/apk/packages
cp $P/control/conffiles $W/files/lib/apk/packages/$N.conffiles
(cd $W/files && find . -type f | sed 's#^\.##' | sort) > $W/files/lib/apk/packages/$N.list
chmod 755 $W/files/usr/libexec/opsagent $W/files/etc/init.d/opsagent $W/files/usr/share/opsagent/agent.py
chmod 600 $W/files/etc/config/opsagent
[ "$(id -u)" = 0 ] && chown -R 0:0 $W/files
O=$N-$V-all.apk
RUN=""; [ "$(id -u)" = 0 ] || RUN="unshare -r"
cd /tmp && $RUN $C/apk.static mkpkg \
 --info "name:$N" --info "version:$V" \
 --info "description:AI ops assistant for LuCI (Feishu bot + DeepSeek)" \
 --info "arch:noarch" --info "license:MIT" --info "origin:$N" --info "maintainer:zknjjjx" \
 --info "depends:luci-base python3 python3-websockets" \
 --script "post-install:$P/control/postinst" --script "pre-deinstall:$P/control/prerm" --script "post-deinstall:$P/control/postrm" \
 --files $W/files --output /tmp/$O
mkdir -p $P/dist; mv /tmp/$O $P/dist/
rm -rf $W; ls -la $P/dist/$O
