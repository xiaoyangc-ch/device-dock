import { app, BrowserWindow, session } from 'electron'
import { getMainStore, getSettingsStore } from '../lib/store'
import { getOpenFileFromArgv, handleEvent } from 'share/main/lib/util'
import * as window from 'share/main/lib/window'
import * as webCastWindow from './webCast'
import log from 'share/common/log'
import once from 'licia/once'
import { IpcGetStore, IpcSetStore } from 'share/common/types'
import isMac from 'licia/isMac'
import endWith from 'licia/endWith'

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

  init()
  initIpc()

  win = window.create({
    name: 'main',
    minWidth: 1024,
    minHeight: 700,
    width: 1280,
    height: 850,
    menu: true,
    // macOS 3.0：内容顶到窗口，红绿灯嵌入侧栏品牌区；用户显式选「原生标题栏」时退回系统标准框。
    customTitlebar: !isMac && !settings.get('useNativeTitlebar'),
    nativeTitlebarOverlay: isMac && !settings.get('useNativeTitlebar'),
  })

  const w = win
  w.on('close', () => {
    app.quit()
  })
  w.on('enter-full-screen', () => {
    window.sendTo('main', 'fullScreenChange', true)
  })
  w.on('leave-full-screen', () => {
    window.sendTo('main', 'fullScreenChange', false)
  })
  w.on('closed', () => {
    if (win === w) win = null
  })

  window.loadPage(w)
}

const init = once(() => {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: ['ws://*/*'],
    },
    (details, callback) => {
      delete details.requestHeaders['Origin']
      callback({ requestHeaders: details.requestHeaders })
    }
  )
})

const initIpc = once(() => {
  handleEvent('setMainStore', <IpcSetStore>(
    ((name, val) => store.set(name, val))
  ))
  handleEvent('getMainStore', <IpcGetStore>((name) => store.get(name)))
  store.on('change', (name, val) => {
    window.sendAll('changeMainStore', name, val)
  })
  handleEvent('showScreencast', () => {
    const device: any = store.get('device')
    if (device) {
      // 测试版：外嵌 scrcpy 窗口方案已移除，直接走 WebCodecs 内嵌
      webCastWindow.show(device.id, device.name)
    }
  })
  if (isMac) {
    app.on('open-file', (_, path) => {
      if (!endWith(path, '.apk')) {
        return
      }
      if (app.isReady()) {
        showWin()
        window.sendTo('main', 'installPackage', path)
      }
    })
  } else {
    app.on('second-instance', (_, argv) => {
      const apkPath = getOpenFileFromArgv(argv, '.apk')
      if (apkPath) {
        showWin()
        window.sendTo('main', 'installPackage', apkPath)
      }
    })
  }
})
