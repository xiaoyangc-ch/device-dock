# APM 远程 3.0 · UI 方向（三版）

> 目标：3.0 从结构上摆脱 AYA 的影子，而不是换一套配色。
> 当前 2.4.8 的问题不是蓝色不对，是壳层仍然是 AYA 的：顶部 31px 页签 + 页面内再一条 31px 工具栏 + 深色表头 + 竖向网格线。只要这个骨架在，怎么换色都像 AYA。

## 文件

| 文件 | 内容 |
| --- | --- |
| `option-a-workbench.html` / `.png` | 方案一 · 工作台（单栏导航，推荐） |
| `option-b-command.html` / `.png` | 方案二 · 指挥台（设备列 + 工具列，多设备） |
| `option-c-stage.html` / `.png` | 方案三 · 设备台（实时画面常驻） |
| `option-b-dark.png` | 方案二深色模式验证图 |
| `base.css` / `icons.js` | 三版共用的设计变量与 Lucide 图标 |

- 画布 1520×1020，窗口 1440×900；截图 2x。
- 浏览器打开 HTML 后，在地址后加 `#dark` 可切深色模式。
- 图标全部为 Lucide 线性图标，16px / 1.7 stroke；没有新引入图标库。

## 三版在解决什么

### 方案一 · 工作台（推荐）

左侧一条 232px 的分组导航，设备卡常驻顶部；页面统一为「页头（标题 + 操作）→ 上下文条（路径/搜索）→ 内容 → 状态栏」。

- 解决：顶部页签消失，页面第一次有了标题和主操作；设备状态不再藏在左上角下拉里。
- 代价：单栏 232px；在最小窗口 1024×640 下，文件表格仍有约 492px 可用，是三版里最稳的。
- 适合：3.0 默认布局；先把壳层和文件页做扎实，其余页面按同一骨架迁移。

### 方案二 · 指挥台

最左是设备列表（在线/离线分组、IP、延迟），第二列是工具导航，右侧才是工作区。

- 解决：多设备同时在线时，不再靠一个下拉框找设备；设备状态、延迟、在线数一眼可见。
- 代价：两列导航共 416px；1440 下内容仍宽 1024，但 1024 最小窗口下表格只剩约 316px，必须加折叠规则（<1280 设备列收成 56px 或下拉）。
- 适合：7 台设备同时在线是常态的运维场景；也是三版里"最不像 AYA"的一版。

### 方案三 · 设备台

在方案一的基础上，把设备变成主角：左侧常驻实时画面、设备信息、快捷操作，再往下才是工具导航。

- 解决：把"远程"做成产品识别度；操作前能确认自己面对的是哪台设备，降低误删/误操作。
- 代价：常驻 screencast 有性能开销；316px 侧栏在最小窗口下会压缩内容区（约 412px 表格宽）。
- 适合：演示、值守、远程协助；建议作为 3.1 的可选布局，或做成可折叠面板。

## 共同的设计底座

三版不是三套皮肤，共用同一套变量和控件规则：

- 字体：系统 UI（PingFang SC / Microsoft YaHei），正文 13px，表格 12px，标签 10.5px，页标题 16.5px。
- 主色：保留 APM 蓝 `#1677ff`；只用于选中态、主按钮、焦点，不再给整个工具栏上色。
- 中性色：侧栏 `#f4f6f8`，内容 `#ffffff`，边框 `#e5e8ee`，正文 `#1b1f27`，次要 `#5e6774`。
- 圆角：控件 6px，卡片/设备卡 9–10px。
- 控件高度：按钮/输入 30px，表格行 31px，表头 30px，状态栏 27px。
- 表格：去掉竖线，只留 1px 横向分隔；表头降为 10.5px 次级色；名称列占剩余宽度，大小右对齐并使用等宽数字。
- 机器数据（IP、序列号、权限、大小、时间）统一等宽字体；中文正文用无衬线，形成"工具感"。
- 图标：每个导航项一个 Lucide 图标，不做装饰性图标；主操作优先文字按钮。
- 深色模式：同一套 token 覆盖（`--bg #1c1e22`、`--chrome #17191d`、`--border #2c3036`），不写死白底/黑字。

## 和 AYA 的具体差别

| AYA 2.4.8 | 3.0 |
| --- | --- |
| 顶部 31px 页签横排 | 左侧分组导航 |
| 页面内再一条 LunaToolbar | 页头（标题 + 主操作）+ 一条上下文条 |
| 设备是左上角下拉框 | 设备卡/设备列/实时画面常驻 |
| 表格带竖线、深色表头 | 无竖线、浅表头、名称列优先 |
| 右侧预览区无标题、无操作 | 「详细信息」检查器：属性 + 下载/安装/重命名 |
| 状态散落在工具栏 | 底部状态栏：条目数、选中数、存储、连接 |

## 落地建议

1. 先做 `AppShell`：`Sidebar` + `PageHeader` + `ContextBar` + `StatusBar`；`store.panel` 不变，页面切换逻辑不动。
2. 用 `Nav` 替换 `LunaTab`；去掉各页的 `LunaToolbar`，把主操作收进 `PageHeader`。
3. 设备下拉改成「设备卡 + 弹层」：弹层里放设备列表、IP/端口连接、扫描局域网；`ConnectPage` 仍保留为完整页面。
4. 文件页先保留 `luna-data-grid`，用 CSS 覆盖成新表格；列顺序改为 名称 / 大小 / 类型 / 修改时间 / 权限，右侧检查器复用现有 `FilePreview` 和选中状态。
5. 窗口已经是 `custom-electron-titlebar`，全高侧栏可行；mac 预留左上 54px 给红绿灯，Windows 右侧保留系统按钮，页头加 `-webkit-app-region: drag`。
6. 深色模式只改 token，不在组件里写死颜色；截图验证用 `main.setSettingsStore('theme','dark')`。

## 结论与选择

- 用户选定 **方案三 · 设备台**，实现按方案三落地：左侧设备台 + 分组导航 + 全量页面迁移。
- 方案一/二保留为备选：如果后续发现常驻投屏开销或侧栏宽度影响小窗口，可以回退到单栏工作台（方案一）；多设备场景再考虑方案二的独立设备列。
- macOS 主窗口已改为 `titleBarStyle: 'hiddenInset'`：内容顶到窗口顶部，系统红绿灯落在 316px 侧栏的品牌区，品牌文字留 84px；页头、文件页头、侧栏品牌区是拖拽区。Windows/Linux 继续使用 `custom-electron-titlebar`。

## 实现进度（按方案三落地）

- 已完成：左侧设备台（实时缩略图、设备切换弹层、分组导航、设置）、全局页头、文件页（面包屑/搜索/表格/详情检查器/传输抽屉/状态栏）、概览页（指标条 + 设备信息表）、设备连接页和应用页；应用页默认列表视图。
- 第二次迁移完成：进程、性能、硬盘检测、终端、截屏、日志、APM 远程，以及概览/连接/应用三个旧页面的工具栏；主窗口内所有页面都已改用 `PageToolbar` / `--ui-*`，不再有 AYA 的 31px 页签和页面内 LunaToolbar。
- 默认页改为「文件」，主窗口默认 1280×850（旧配置小于最小尺寸会兜底到 1024×700）。
- 浅色/深色都已用真实设备验证；表格统一去竖线、浅表头、选中态使用 `--ui-accent-soft`。
- 终端 xterm 从 WebGL/Canvas 切回默认 DOM 渲染：部分机器 GPU 沙箱受限时 WebGL 会静默黑屏，Canvas 在高分屏下字号又被放大；DOM 渲染最稳，字体与页面统一。
- macOS 标题栏已完成：`hiddenInset` 原生 overlay，红绿灯在侧栏品牌区；`body.native-titlebar-overlay` 控制 84px 留白和拖拽区。选择“原生标题栏”设置时退回系统标准框。

## 验收截图

| 页面 | 深色 | 浅色 |
| --- | --- | --- |
| 标题栏（macOS 原生红绿灯） | [titlebar-native-dark](screens/titlebar-native-dark.png) | [titlebar-native-light](screens/titlebar-native-light.png) |
| 文件 | [file-dark](screens/file-dark.png) | [file-light](screens/file-light.png) |
| 设备连接 | [connect-dark](screens/connect-dark.png) | [connect-light](screens/connect-light.png) |
| 概览 | [overview-dark](screens/overview-dark.png) | — |
| 应用 | [application-dark](screens/application-dark.png) | [application-light](screens/application-light.png) |
| 进程 | [process-dark](screens/process-dark.png) | — |
| 性能 | [performance-dark](screens/performance-dark.png) | — |
| 硬盘检测 | [disk-dark](screens/disk-dark.png) | — |
| 终端 | [terminal-dark](screens/terminal-dark.png) | [terminal-light](screens/terminal-light.png) |
| 截屏 | [screenshot-dark](screens/screenshot-dark.png) | — |
| 日志 | [logcat-dark](screens/logcat-dark.png) | [logcat-light](screens/logcat-light.png) |
| APM 远程 | [apm-dark](screens/apm-dark.png) | — |

