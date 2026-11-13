/**
 * 主窗口：1280×850，最小 1024×700。
 * macOS 用 hiddenInset 把红绿灯嵌进侧栏品牌区；用户显式选「原生标题栏」时退回系统框。
 */
import { app, BrowserWindow, session } from 'electron'
import { getMainStore, getSettingsStore } from '../lib/store'
import { getOpenFileFromArgv, handleEvent } from 'share/main/lib/util'
import * as window from 'share/main/lib/window'
import * as webCastWindow from './webCast'
import log from 'share/common/log'
import once from 'licia/once'
import isMac from 'licia/isMac'
import endWith from 'licia/endWith'
import { IpcGetStore, IpcSetStore } from 'share/common/types'

const logger = log('mainWin')

const store = getMainStore()
const settings = getSettingsStore()

let win: BrowserWindow | null = null

export function showWin() {
  logger.info('show')

  // 窗口已销毁但引用还在时会抛 Object has been destroyed（second-instance 触发）
  if (win && !win.isDestroyed()) {
    win.focus()
    return
  }

  initSession()
  initIpc()

  win = window.create({
    name: 'main',
    minWidth: 1024,
    minHeight: 700,
    width: 1280,
    height: 850,
    menu: true,
    customTitlebar: !isMac && !settings.get('useNativeTitlebar'),
    nativeTitlebarOverlay: isMac && !settings.get('useNativeTitlebar'),
  })

  const created = win
  created.on('close', () => {
    // 主窗口关闭 = 退出应用（走正常 quit 流程，让 adb/投屏清理跑完）
    app.quit()
  })
  created.on('enter-full-screen', () => {
    window.sendTo('main', 'fullScreenChange', true)
  })
  created.on('leave-full-screen', () => {
    window.sendTo('main', 'fullScreenChange', false)
  })
  created.on('closed', () => {
    if (win === created) win = null
  })

  window.loadPage(created)
}

/** ws 连接去掉 Origin：本地 websocket 服务不校验来源，带上反而被拒。 */
const initSession = once(() => {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['ws://*/*'] },
    (details, callback) => {
      delete details.requestHeaders['Origin']
      callback({ requestHeaders: details.requestHeaders })
    }
  )
})

const initIpc = once(() => {
  handleEvent(
    'setMainStore',
    <IpcSetStore>((name, value) => store.set(name, value))
  )
  handleEvent('getMainStore', <IpcGetStore>((name) => store.get(name)))
  store.on('change', (name, value) => {
    window.sendAll('changeMainStore', name, value)
  })

  handleEvent('showScreencast', () => {
    const device: any = store.get('device')
    if (!device) return
    // 外嵌 scrcpy 窗口方案已移除，统一走 WebCodecs 内嵌
    webCastWindow.show(device.id, device.name)
  })

  // 双击 APK / 拖到 Dock / 命令行传参：直接进安装流程
  if (isMac) {
    app.on('open-file', (_, filePath) => {
      if (!endWith(filePath, '.apk')) return
      if (!app.isReady()) return
      showWin()
      window.sendTo('main', 'installPackage', filePath)
    })
  } else {
    app.on('second-instance', (_, argv) => {
      const apkPath = getOpenFileFromArgv(argv, '.apk')
      if (!apkPath) return
      showWin()
      window.sendTo('main', 'installPackage', apkPath)
    })
  }
})
