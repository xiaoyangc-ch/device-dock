import { contextBridge } from 'electron'
import mainObj from './main'
import nodeObj from 'share/preload/node'
import preloadObj from 'share/preload/preload'

/**
 * 按窗口裁剪 IPC 能力。
 *
 * 所有窗口共用一份 preload，默认拿到全部 ~120 个通道：终端、进程、视频、
 * 关于这些窗口也能删设备文件、装应用、扫硬盘。这里按 ?page= 区分，
 * 主窗口给全量，其余窗口去掉「会改变设备状态」的那一批（查询/订阅类保留）。
 *
 * 注意：投屏窗口需要 inputKey/inputText（键盘输入）和录制三件套，
 * 这些都不在过滤列表里。
 */
const DANGEROUS = new Set([
  // 文件写操作
  'deleteFile',
  'deleteDir',
  'createDir',
  'moveFile',
  'renameFile',
  'pushFile',
  'pullFile',
  'openFile',
  // 硬盘检测
  'diskPrepare',
  'diskRun',
  'diskScanAll',
  // 应用安装/卸载/启停
  'installPackage',
  'uninstallPackage',
  'clearPackage',
  'disablePackage',
  'enablePackage',
  'stopPackage',
  'startPackage',
  // 设备级动作
  'rebootDevice',
  'openAdbCli',
])

const page = new URLSearchParams(location.search).get('page') || ''
const isMainWin = !page || page === 'main'

// fromEntries 会把类型擦成 index signature，导致渲染层 main.xxx 全部失型：
// 这里断言回原类型（运行时被过滤掉的通道调用时会得到 undefined）
const api = (
  isMainWin
    ? mainObj
    : Object.fromEntries(
        Object.entries(mainObj).filter(([key]) => !DANGEROUS.has(key))
      )
) as typeof mainObj

contextBridge.exposeInMainWorld('preload', preloadObj)
contextBridge.exposeInMainWorld('main', api)
contextBridge.exposeInMainWorld('node', nodeObj)

declare global {
  const main: typeof api
  const preload: typeof preloadObj
  const node: typeof nodeObj
}
