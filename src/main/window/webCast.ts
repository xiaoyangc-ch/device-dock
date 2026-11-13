import * as window from 'share/main/lib/window'
import { handleEvent } from 'share/main/lib/util'
import { BrowserWindow, screen } from 'electron'
import { IpcResizeWebCast, IpcShowWebCast, IpcWebCastOnTop } from 'common/types'
import { IpcGetStore, IpcSetStore } from 'share/common/types'
import { getScreencastStore } from '../lib/store'
import * as webCast from '../lib/webCast'

// 方案 B 测试窗口：视频由 WebCodecs 解到 canvas，完全在网页层里
const wins = new Map<string, BrowserWindow>()

export function show(deviceId: string, deviceName: string) {
  const exist = wins.get(deviceId)
  if (exist && !exist.isDestroyed()) {
    exist.show()
    exist.focus()
    return exist
  }

  const win = window.create({
    name: 'webcast-' + deviceId,
    width: 620,
    height: 860,
    minWidth: 560,
    minHeight: 420,
    customTitlebar: false,
  })
  wins.set(deviceId, win)

  // 窗口位置/大小由 share/main/lib/window 的 onSavePos 统一保存和恢复，
  // 这里不再另存一份，避免两套 bounds 互相覆盖

  win.on('closed', () => {
    if (wins.get(deviceId) === win) wins.delete(deviceId)
    // 关窗口时 React 的 cleanup 不保证执行（窗口先被销毁），
    // 必须由主进程收掉 adb shell / 设备端 server / forward，否则设备上会留一个编码器
    webCast.stopWebCast(deviceId).catch(() => {})
  })
  window.loadPage(win, {
    page: 'webcast',
    device: deviceId,
    name: deviceName,
  })

  return win
}

export const showWebCast: IpcShowWebCast = async function (deviceId, name) {
  show(deviceId, name)
}

// 按设备分辨率调整窗口，避免竖窗口里给横屏留大黑边（AYA 同样按画面比例定窗口）
const lastSize = new Map<string, string>()

export const resizeWebCast: IpcResizeWebCast = async function (
  deviceId,
  videoWidth,
  videoHeight
) {
  const win = wins.get(deviceId)
  if (!win || win.isDestroyed() || !videoWidth || !videoHeight) return
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  const toolbar = 32
  const totalH = Math.max(480, Math.min(900, Math.round(sh * 0.82)))
  const videoH = totalH - toolbar
  let width = Math.round((videoH * videoWidth) / videoHeight)
  let height = totalH
  if (width > sw * 0.9) {
    width = Math.round(sw * 0.9)
    height = Math.round((width * videoHeight) / videoWidth) + toolbar
  }
  // 每次重连都 setContentSize + center 会把用户摆好的窗口拽回屏幕中间，
  // 尺寸没变就别动，位置也只做「别跑出屏幕」的修正
  const key = `${width}x${height}`
  if (lastSize.get(deviceId) === key) return
  lastSize.set(deviceId, key)
  const bounds = win.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)
  win.setBounds({ x, y, width, height })
}

export const webCastOnTop: IpcWebCastOnTop = async function (deviceId, onTop) {
  const win = wins.get(deviceId)
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!onTop)
}

export function init() {
  handleEvent('resizeWebCast', resizeWebCast)
  handleEvent('webCastOnTop', webCastOnTop)
  handleEvent(
    'getScreencastStore',
    <IpcGetStore>((name) => getScreencastStore().get(name))
  )
  handleEvent(
    'setScreencastStore',
    <IpcSetStore>((name, val) => getScreencastStore().set(name, val))
  )
  handleEvent('showWebCast', showWebCast)
}

export function destroy(deviceId: string) {
  const win = wins.get(deviceId)
  if (win && !win.isDestroyed()) win.close()
  wins.delete(deviceId)
}
