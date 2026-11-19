/**
 * 主进程公共工具：资源路径、userData 路径、主题、IPC 注册。
 */
import path from 'path'
import { app, ipcMain, nativeTheme, type IpcMainInvokeEvent } from 'electron'
import log from '../../common/log'
import endWith from 'licia/endWith'
import pkg from '../../../../package.json'
import { exec as _exec } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { pathToFileURL } from 'node:url'
import { isTrustedAppUrl } from 'common/appUrl'

const execAsync = promisify(_exec)

/** dev 下 __dirname 在 dist/share/main，生产在 app.asar 内：基路径不同 */
export function resolve(p: string) {
  // 必须用 app.isPackaged，不能用 isDev()：dev 跑的是 production 构建，
  // isDev() 恒为 false，会把 dev 的资源路径解析到 dist/resources（那里没有
  // resources），首次给设备推 dex 时推上去的是 0 字节文件。
  return app.isPackaged
    ? path.resolve(__dirname, '../', p)
    : path.resolve(__dirname, '../../', p)
}

export function resolveResources(p: string) {
  const ret = resolve(`resources/${p}`)
  // 打包后 resources 在 asar 外面（electron-builder 的 extraResources）
  if (app.isPackaged && ret.includes('app.asar')) {
    return path.resolve(process.resourcesPath, p)
  }
  return ret
}

// 开发版和正式版共用 productName 下的 userData：
// 打包后 Electron 会自动用 productName，未打包时默认是 "Electron"，
// 不统一的话调试时的配置/录制/索引和正式版各存一份，互不相通
if (!app.isPackaged) {
  app.setPath('userData', path.resolve(app.getPath('appData'), pkg.productName))
}

export function getUserDataPath(p: string) {
  return path.resolve(app.getPath('userData'), p)
}

export function getTheme() {
  if (nativeTheme.themeSource === 'system') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }
  return nativeTheme.themeSource
}

const logger = log('handleEvent')
/**
 * 只放行应用自己的页面调 IPC。
 *
 * 所有窗口都挂了同一个 preload（pushFile/deleteFile/diskRun 全在里面），
 * 导航兜底只能挡住外部网页，这里再挡一层非应用来源：
 * 打包/构建后页面都是 file://，dev server 与 devtools 在 localhost。
 */
/** 应用自己的页面：打包/构建后都是 file://，dev server 与 devtools 在 localhost。 */
export function isAppUrl(url: string): boolean {
  const rendererFile = pathToFileURL(
    path.resolve(__dirname, '../renderer/index.html'),
  ).href
  return isTrustedAppUrl(url, rendererFile)
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event?.senderFrame?.url || '')
}

export function assertTrustedSender(event: IpcMainInvokeEvent) {
  if (!isTrustedSender(event)) {
    logger.warn('reject ipc from untrusted sender')
    throw new Error('拒绝来自非应用页面的 IPC 调用')
  }
}

export function handleEvent<Args extends unknown[], Result>(
  channel: string,
  listener: (...args: Args) => Result,
) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event)
    logger.debug(channel, ...args)
    return listener(...(args as Args))
  })
}

export function getOpenFileFromArgv(argv: string[], ext: string) {
  for (const arg of argv) {
    if (endWith(arg, ext)) return arg
  }
  return ''
}

export async function exec(command: string) {
  return (await execAsync(command)).stdout
}

export function sha1(data: string) {
  return createHash('sha1').update(data).digest('hex')
}
