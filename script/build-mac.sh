#!/bin/bash
# 在 macOS 上把 设备坞 打成 dmg（ad-hoc 签名，无需开发者证书）
# 用法：./script/build-mac.sh                # 装依赖 + 编译 + 打包
#      ./script/build-mac.sh --skip-install  # 依赖已就绪，只重编译打包
set -euo pipefail

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(python3 -c "import json;print(json.load(open('$APP_DIR/package.json'))['version'])")
# 产物目录由宿主架构决定（x64 机器是 mac/）：写死 mac-arm64 会让
# Intel Mac / CI 上的 codesign 直接找不到路径
if [ "$(uname -m)" = "arm64" ]; then
  BUILD_ARCH="arm64"
  MAC_DIR="mac-arm64"
else
  BUILD_ARCH="x64"
  MAC_DIR="mac"
fi
OUT="$APP_DIR/release/$VERSION/$MAC_DIR/设备坞.app"
DMG="$APP_DIR/dist/设备坞-$VERSION-$BUILD_ARCH.dmg"

mkdir -p "$APP_DIR/dist"

if [ "${1:-}" != "--skip-install" ]; then
  echo "==> 安装依赖（--legacy-peer-deps；npm 12 会拦截 lock 里的镜像源 tarball，故用 install）"
  cd "$APP_DIR" && npm install --legacy-peer-deps --no-audit --no-fund
  # npm 12 默认拦截 electron 的 postinstall，需手动补下载运行时
  if [ -f "$APP_DIR/node_modules/electron/install.js" ]; then
    (cd "$APP_DIR/node_modules/electron" && node install.js) || true
  fi
fi

# 仓库里已带 mac 版 adb；真缺了就让 script/adb.mjs 从 Google 拉官方 platform-tools
if [ ! -f "$APP_DIR/resources/adb/adb" ]; then
  echo "==> 缺 resources/adb/adb，执行 npm run adb"
  (cd "$APP_DIR" && npm run adb)
fi

cd "$APP_DIR"
echo "==> 编译 main / preload / renderer"
./node_modules/.bin/zx script/build.mjs

echo "==> 组装 .app（跳过签名）"
cd "$APP_DIR/dist"
CSC_IDENTITY_AUTO_DISCOVERY=false ../node_modules/.bin/electron-builder --mac dir --$BUILD_ARCH \
  --config ../electron-builder.mac.yml \
  -c.directories.output="../release/$VERSION"

echo "==> ad-hoc 签名（Apple Silicon 必须，否则无法启动）"
codesign --force --deep --sign - "$OUT"
codesign --verify --deep --strict "$OUT"

echo "==> 生成 dmg"
STAGE=$(mktemp -d)
cp -R "$OUT" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "设备坞" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"

echo "==> 完成：$DMG"
shasum -a 256 "$DMG"
