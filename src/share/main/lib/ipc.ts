/**
 * 共享 IPC：设置/内存存储、系统对话框、剪贴板、外部打开、窗口控制。
 * 具体业务（adb、投屏）的 IPC 在各业务模块里注册。
 */
import { dialog, shell, app, ipcMain, BrowserWindow, clipboard } from 'electron'
import * as window from './window'
import contextMenu from './contextMenu'
import {
  assertTrustedSender,
  getOpenFileFromArgv,
  handleEvent,
  resolveResources,
} from './util'
import { getMemStore } from './store'
import log from '../../common/log'
import {
  IpcGetFileIcon,
  IpcGetOpenFile,
  IpcGetPath,
  IpcGetStore,
  IpcOpenExternal,
  IpcOpenPath,
  IpcOpenWindow,
  IpcResolveResources,
  IpcSendToWindow,
  IpcSetStore,
  IpcShowItemInFolder,
  IpcShowOpenDialog,
  IpcShowSaveDialog,
  IpcShowVideo,
} from '../../common/types'
import isMac from 'licia/isMac'
import endWith from 'licia/endWith'
import types from 'licia/types'
import * as terminal from '../window/terminal'
import * as video from '../window/video'
import * as processWindow from '../window/process'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { getSettingsStore } from '../../../main/lib/store'

const logger = log('ipc')

function openSafeExternal(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('只允许打开 http/https 链接')
    }
    return shell.openExternal(parsed.href)
  } catch (e) {
    logger.warn('reject external url', url, e)
  }
}

// 渲染层 → 其它窗口的事件白名单（主进程内部的 sendTo 不走这条 IPC）
const SEND_TO_WINDOW_ALLOW: Record<string, Set<string>> = {
  main: new Set(['refreshDevices']),
}
const settingsStore = getSettingsStore()
const memStore = getMemStore()

const openWindow: IpcOpenWindow = (url, name, options) => {
  const win = window.create({
    ...(options || {}),
    name: name || url,
    // 安全相关项必须最后写：调用方不能通过 options 把 preload/menu 打开，
    // 否则一个外部链接就能拿到完整的 Node 能力
    preload: false,
    customTitlebar: false,
    menu: false,
  })
  win.loadURL(url)
}

let macOpenFile = ''
if (isMac) {
  app.on('open-file', (_, filePath) => {
    macOpenFile = filePath
  })
}

const getOpenFile: IpcGetOpenFile = (ext) => {
  if (isMac && endWith(macOpenFile, ext)) return macOpenFile
  return getOpenFileFromArgv(process.argv, ext)
}

const FILE_ICON_FALLBACK =
  'data:image/svg+xml;base64,PHN2ZyB0PSIxNzM2NDI4Mzk1MTI4IiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIgogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgcC1pZD0iMTI4NiIgd2lkdGg9IjIwMCIgaGVpZ2h0PSIyMDAiPgogIDxwYXRoCiAgICBkPSJNMTYwIDMyYy0xMiAwLTI0LjggNC44LTMzLjYgMTQuNFMxMTIgNjggMTEyIDgwdjg2NGMwIDEyIDQuOCAyNC44IDE0LjQgMzMuNiA5LjYgOS42IDIxLjYgMTQuNCAzMy42IDE0LjRoNzA0YzEyIDAgMjQuOC00LjggMzMuNi0xNC40IDkuNi05LjYgMTQuNC0yMS42IDE0LjQtMzMuNlYzMDRMNjQwIDMySDE2MHoiCiAgICBmaWxsPSIjRTVFNUU1IiBwLWlkPSIxMjg3Ij48L3BhdGg+CiAgPHBhdGggZD0iTTkxMiAzMDRINjg4Yy0xMiAwLTI0LjgtNC44LTMzLjYtMTQuNC05LjYtOC44LTE0LjQtMjEuNi0xNC40LTMzLjZWMzJsMjcyIDI3MnoiCiAgICBmaWxsPSIjQ0NDQ0NDIiBwLWlkPSIxMjg4Ij48L3BhdGg+Cjwvc3ZnPg=='

const fileIcons: types.PlainObj<string> = {}

const getFileIcon: IpcGetFileIcon = async (ext) => {
  // ext 来自设备端文件名：不清理就是路径穿越，能在任意目录写出空文件
  const safeExt = String(ext || '')
    .replace(/[^a-zA-Z0-9.]/g, '')
    .slice(0, 16)

  const cached = fileIcons[safeExt]
  if (cached) return cached
  if (!safeExt) return FILE_ICON_FALLBACK

  // getFileIcon 只认真实文件：在临时目录造一个同名空文件再问系统
  const probe = path.resolve(os.tmpdir(), `devicedock-file${safeExt}`)
  let dataUrl = FILE_ICON_FALLBACK
  try {
    await fs.writeFile(probe, '')
    const image = await app.getFileIcon(probe, {
      size: isMac ? 'normal' : 'large',
    })
    dataUrl = image.toDataURL()
  } catch {
    // 系统没有该类型的图标就用兜底
  }

  fileIcons[safeExt] = dataUrl
  return dataUrl
}

export function init() {
  logger.info('init')

  handleEvent(
    'setSettingsStore',
    <IpcSetStore>((name, value) => settingsStore.set(name, value))
  )
  handleEvent(
    'getSettingsStore',
    <IpcGetStore>((name) => settingsStore.get(name))
  )
  settingsStore.on('change', (name, value) => {
    window.sendAll('changeSettingsStore', name, value)
  })

  handleEvent(
    'showOpenDialog',
    <IpcShowOpenDialog>((options) => dialog.showOpenDialog(options))
  )
  handleEvent(
    'showSaveDialog',
    <IpcShowSaveDialog>((options) => dialog.showSaveDialog(options))
  )
  handleEvent(
    'openExternal',
    <IpcOpenExternal>((url) => {
      openSafeExternal(url)
    })
  )
  handleEvent('toggleDevTools', () => {
    const win = window.getFocusedWin()
    if (win) win.webContents.toggleDevTools()
  })
  handleEvent(
    'sendToWindow',
    <IpcSendToWindow>((name, channel, ...args) => {
      // 泛化通道等于让任意渲染层驱动任意窗口的任意逻辑：
      // 目前只有设备连接页需要让主窗口刷新列表，就只放行这一条。
      // 主进程自己用的 sendTo 不经过这里，不受影响。
      if (!(name in SEND_TO_WINDOW_ALLOW)) {
        throw new Error(`不允许向窗口 ${name} 发事件`)
      }
      if (!SEND_TO_WINDOW_ALLOW[name].has(channel)) {
        throw new Error(`窗口 ${name} 不允许事件 ${channel}`)
      }
      window.sendTo(name, channel, ...args)
    })
  )

  handleEvent(
    'setMemStore',
    <IpcSetStore>((name, value) => memStore.set(name, value))
  )
  handleEvent('getMemStore', <IpcGetStore>((name) => memStore.get(name)))
  memStore.on('change', (name, value) => {
    window.sendAll('changeMemStore', name, value)
  })

  ipcMain.handle('showContextMenu', (event, x, y, template) => {
    assertTrustedSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      win.focus()
      contextMenu(x, y, template, event.sender)
    }
  })
  ipcMain.handle('closeWin', (event) => {
    assertTrustedSender(event)
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.handle('hideWin', (event) => {
    assertTrustedSender(event)
    BrowserWindow.fromWebContents(event.sender)?.hide()
  })
  ipcMain.handle('toggleWinMaximize', (event) => {
    assertTrustedSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })
  ipcMain.handle('isCustomTitlebar', (event) => {
    assertTrustedSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? (win as any).customTitlebar : true
  })
  ipcMain.handle('isTitlebarOverlay', (event) => {
    assertTrustedSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? !!(win as any).nativeTitlebarOverlay : false
  })

  handleEvent('relaunch', () => {
    app.relaunch()
    // quit 走正常退出流程：录制落盘、adb 端口回收都在 before-quit 里
    app.quit()
  })

  // 投屏 Ctrl+V 要求「按下就出内容」：renderer 的 navigator.clipboard
  // 在失焦/未授权时可能慢或返回空，走主进程同步剪贴板
  handleEvent('readClipboard', () => clipboard.readText())
  handleEvent('writeClipboard', (text: string) => clipboard.writeText(text))

  handleEvent(
    'openPath',
    <IpcOpenPath>((p: string) => {
      shell.openPath(p)
    })
  )
  handleEvent(
    'showItemInFolder',
    <IpcShowItemInFolder>((p: string) => {
      shell.showItemInFolder(p)
    })
  )
  handleEvent('openWindow', openWindow)

  handleEvent('getOpenFile', getOpenFile)
  handleEvent('showTerminal', () => terminal.showWin())
  handleEvent('showVideo', <IpcShowVideo>((url) => video.showWin(url)))
  handleEvent('showProcess', () => processWindow.showWin())
  handleEvent(
    'resolveResources',
    <IpcResolveResources>((p: string) => resolveResources(p))
  )
  handleEvent('getCpuAndMem', processWindow.getCpuAndMem)
  handleEvent('getFileIcon', getFileIcon)
  handleEvent('getPath', <IpcGetPath>((name) => app.getPath(name)))
}
