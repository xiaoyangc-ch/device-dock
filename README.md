# 设备坞

安卓设备管理客户端：多设备连接、投屏，以及文件 / 应用 / 进程 / 日志 / 终端等日常运维能力。

4.0 起本仓库独立演进：新仓库历史、自有版本线，不再包含 APM 远程业务（账号登录、按 MAC 查设备、frpc 穿透）。连接方式只保留 USB 与局域网 ADB。

## 功能

- **设备管理**：USB / 网络 ADB、局域网扫描、连接状态与延迟
- **投屏**：WebCodecs 内嵌 + scrcpy 内核，多设备多窗口、信号源切换、录制、H.264/H.265 回退
- **文件管理**：浏览 / 上传 / 下载 / 重命名 / 删除，当前目录与全盘搜索（按设备能力自适应 `find` 形态）
- **应用管理**：安装 / 卸载 / 启停 / 清数据，图标与版本信息按 versionCode 缓存
- **进程、性能、日志、交互式 shell**（多标签终端）
- **硬盘检测**：DiskToolkit 集成

## 目录

```
src/main        Electron 主进程：adb 封装、投屏内核、窗口、菜单
src/preload     预加载脚本
src/renderer    React 界面：设备、投屏、文件、应用等页面
src/common      主/渲染共享的解析、类型、多语言
src/share       主/渲染共用的窗口骨架与通用页面（以内联源码形式维护）
server          scrcpy server 的 Java 源码
resources       adb、scrcpy.jar、dex、disktool 等随包资源
script          构建、打包、adb、smoke 脚本
build           图标与安装器素材
```

## 开发

```bash
npm install --legacy-peer-deps
npm run dev            # 主进程 / preload / 渲染三路 watch
npm run typecheck
npm test               # 单元测试
npm run lint
```

macOS 打包（ad-hoc 签名，无需证书）：

```bash
./script/build-mac.sh --skip-install
```

Windows 免安装 zip 与 NSIS 安装器的完整命令见 `script/` 与 `.github/workflows/build-win.yml`；NSIS 只能在 CI 上打。

## 版本与更新日志

- `package.json` 的版本每次发版递增
- `CHANGELOG.md` 顶部加中文条目，格式 `## x.y.z（YYYY-MM-DD）` + `- 条目`

## 许可

应用代码（`src/main`、`src/share`、`src/renderer`、`server` 的 Kotlin 服务端）为自有实现；
第三方组件（luna-*、scrcpy server、@yume-chan/scrcpy、licia 等）按各自的 MIT / Apache-2.0
许可使用，版权与许可声明见 [NOTICE](NOTICE)。

仓库当前仍保留 [LICENSE](LICENSE) 的 AGPL-3.0 文本：代码层已完成重写，但
`*.module.scss` 的布局结构仍与早期版本接近，在复核完样式表之前不宣称闭源分发。
`docs/4.0-自有化路线.md` 记录了重写范围与剩余待核对项。
