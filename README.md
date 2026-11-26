# 设备坞

安卓设备管理客户端：多设备连接、投屏，以及文件 / 应用 / 进程 / 日志 / 终端等日常运维能力。

## 最新版本 4.1.4

- **安全**：修复诊断位置参数泄密、Windows 下载路径穿越和设备端符号链接删除绕过
- **文件**：上传/下载改为临时文件提交，覆盖失败不会破坏已有文件；设备内 APK 可直接安装
- **兼容**：ADB 初始化、僵尸锁、未授权设备和设备文件服务缓存修复，应用元数据改为按需图标
- **稳定性**：修复搜索、截图、投屏、录制和 APM 任务的并发竞态与资源泄漏
- **发布**：Release 增加质量门禁、Android dex 一致性检查、重复发布和 SHA-256 校验
- **macOS Apple Silicon**：提供自包含安装包

完整操作说明见 [使用文档](docs/使用文档.md)，历史排版版见 [4.0 PDF 手册](docs/设备坞-4.0-使用手册.pdf)。

4.0 起本仓库独立演进：新仓库历史、自有版本线，不再包含 APM 远程业务（账号登录、按 MAC 查设备、frpc 穿透）。连接方式只保留 USB 与局域网 ADB。

## 功能

- **设备管理**：USB / 网络 ADB、局域网扫描、连接状态与延迟
- **投屏**：WebCodecs 内嵌 + scrcpy 内核，多设备多窗口、信号源切换、录制、H.264/H.265 回退
- **文件管理**：浏览 / 上传 / 下载 / 重命名 / 删除，当前目录与全盘搜索（按设备能力自适应 `find` 形态）
- **应用管理**：安装 / 卸载 / 启停 / 清数据，图标与版本信息按 versionCode 缓存
- **进程、性能、日志、交互式 shell**（多标签终端）
- **诊断导出**：一键生成脱敏的设备、ADB、版本、日志和失败操作记录
- **硬盘检测**：DiskToolkit 集成

## 目录

```
src/main        Electron 主进程：adb 封装、投屏内核、窗口、菜单
src/preload     预加载脚本
src/renderer    React 界面：设备、投屏、文件、应用等页面
src/common      主/渲染共享的解析、类型、多语言
src/share       主/渲染共用的窗口骨架与通用页面（以内联源码形式维护）
server          设备端服务、文件服务与 R8/D8 构建
resources       adb、scrcpy.jar、dex、disktool 等随包资源
script          构建、打包、adb、smoke 脚本
build           图标与安装器素材
```

## 开发

需要 Node.js 22.12+；Android 设备端 dex 构建需要 JDK 17+。

```bash
npm install --legacy-peer-deps
npm run dev            # 主进程 / preload / 渲染三路 watch
npm run check          # typecheck + 单测 + lint
npm run typecheck
npm test               # 单元测试
npm run test:devices -- --port 9444 --deep  # 已启动 CDP 时的真机能力矩阵
npm run lint
npm run pack:dir       # 快速生成未压缩 .app，验证打包但不需要 DMG 工具
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

[MIT](LICENSE)。第三方组件（luna-*、scrcpy server、@yume-chan/scrcpy、licia、adb 等）
按各自许可使用，声明见 [NOTICE](NOTICE)。

> 硬盘检测功能依赖厂商提供的 `resources/disktool/shine_disk_cli_*`（未随仓库分发）。
> 自行放置到该路径后即可使用；该二进制的许可请向厂商确认。
