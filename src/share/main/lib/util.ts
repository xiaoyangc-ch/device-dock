/**
 * 主进程公共工具：资源路径、userData 路径、主题、IPC 注册。
 */
import path from 'path'
import types from 'licia/types'
import { app, ipcMain, nativeTheme } from 'electron'
import { isDev } from '../../common/util'
import log from '../../common/log'
import endWith from 'licia/endWith'
import pkg from '../../../../package.json'
import { exec as _exec } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'

const execAsync = promisify(_exec)

/** dev 下 __dirname 在 dist/share/main，生产在 app.asar 内：基路径不同 */
export function resolve(p: string) {
  return isDev()
    ? path.resolve(__dirname, '../../', p)
    : path.resolve(__dirname, '../', p)
}

export function resolveResources(p: string) {
  const ret = resolve(`resources/${p}`)
  // 打包后 resources 在 asar 外面（electron-builder 的 extraResources）
  if (!isDev() && ret.includes('app.asar')) {
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
export function handleEvent(channel: string, listener: types.AnyFn) {
  ipcMain.handle(channel, (event: any, ...args) => {
    logger.debug(channel, ...args)
    return listener(...args)
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
