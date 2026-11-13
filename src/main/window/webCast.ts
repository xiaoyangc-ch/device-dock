/**
 * 投屏窗口：每个设备一个，视频由渲染层 WebCodecs 解到 canvas。
 * 窗口位置/大小由 share/main/lib/window 统一保存，这里不另存 bounds。
 */
import * as window from 'share/main/lib/window'
import { handleEvent } from 'share/main/lib/util'
import { BrowserWindow, screen } from 'electron'
import { IpcResizeWebCast, IpcShowWebCast, IpcWebCastOnTop } from 'common/types'
import { IpcGetStore, IpcSetStore } from 'share/common/types'
import { getScreencastStore } from '../lib/store'
import * as webCast from '../lib/webCast'

const wins = new Map<string, BrowserWindow>()

export function show(deviceId: string, deviceName: string) {
  const existing = wins.get(deviceId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return existing
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

  win.on('closed', () => {
    if (wins.get(deviceId) === win) wins.delete(deviceId)
    // React 的 cleanup 不保证执行（窗口先被销毁）：
    // 必须由主进程收掉 adb shell / 设备端 server / forward，否则设备上留一个编码器
    webCast.stopWebCast(deviceId).catch(() => {})
  })

  window.loadPage(win, {
    page: 'webcast',
    device: deviceId,
    name: deviceName,
  })
  return win
}

export const showWebCast: IpcShowWebCast = async (deviceId, name) => {
  show(deviceId, name)
}

/** 按视频比例定窗口：竖屏窗口里给横屏留大黑边很难看。 */
const lastSize = new Map<string, string>()

export const resizeWebCast: IpcResizeWebCast = async (
  deviceId,
  videoWidth,
  videoHeight
) => {
  const win = wins.get(deviceId)
  if (!win || win.isDestroyed() || !videoWidth || !videoHeight) return

  const { width: screenWidth, height: screenHeight } =
    screen.getPrimaryDisplay().workAreaSize
  const toolbar = 32
  const totalHeight = Math.max(480, Math.min(900, Math.round(screenHeight * 0.82)))
  const videoHeightPx = totalHeight - toolbar

  let width = Math.round((videoHeightPx * videoWidth) / videoHeight)
  let height = totalHeight
  if (width > screenWidth * 0.9) {
    width = Math.round(screenWidth * 0.9)
    height = Math.round((width * videoHeight) / videoWidth) + toolbar
  }

  // 每次重连都 setContentSize + center 会把用户摆好的窗口拽回中间：
  // 尺寸没变就不动，位置只做「别跑出屏幕」的修正
  const key = `${width}x${height}`
  if (lastSize.get(deviceId) === key) return
  lastSize.set(deviceId, key)

  const bounds = win.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)
  win.setBounds({ x, y, width, height })
}

export const webCastOnTop: IpcWebCastOnTop = async (deviceId, onTop) => {
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
    <IpcSetStore>((name, value) => getScreencastStore().set(name, value))
  )
  handleEvent('showWebCast', showWebCast)
}

export function destroy(deviceId: string) {
  const win = wins.get(deviceId)
  if (win && !win.isDestroyed()) win.close()
  wins.delete(deviceId)
}
