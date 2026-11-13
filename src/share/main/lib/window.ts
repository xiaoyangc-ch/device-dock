/**
 * 窗口统一创建与管理。
 *
 * - 位置、最大化状态按窗口名存 data/window.json，重开时还原；
 * - 还原位置时按当前最小尺寸兜底：3.0 的侧栏更宽，旧版本存的 960×640
 *   直接沿用会把内容区压死；
 * - ready-to-show 在某些情况下不会触发（页签隐藏、加载失败），1 秒后强制显示。
 */
import {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  screen,
} from 'electron'
import types from 'licia/types'
import defaults from 'licia/defaults'
import path from 'path'
import { attachTitlebarToWindow } from 'custom-electron-titlebar/main'
import { colorBgContainer, colorBgContainerDark } from 'common/theme'
import { getTheme } from './util'
import isWindows from 'licia/isWindows'
import isMac from 'licia/isMac'
import debounce from 'licia/debounce'
import { isDev } from '../../common/util'
import isEmpty from 'licia/isEmpty'
import query from 'licia/query'
import log from '../../common/log'
import once from 'licia/once'
import { getWindowStore } from './store'
import isUndef from 'licia/isUndef'
import extend from 'licia/extend'

const logger = log('window')
const store = getWindowStore()

interface IWinOptions {
  name: string
  maximized?: boolean
  titlebar?: boolean
  customTitlebar?: boolean
  nativeTitlebarOverlay?: boolean
  minWidth?: number
  minHeight?: number
  width?: number
  height?: number
  preload?: boolean
  menu?: boolean
  x?: number
  y?: number
  skipTaskbar?: boolean
  onSavePos?: types.AnyFn
  resizable?: boolean
}

const wins: types.PlainObj<BrowserWindow> = {}
let focusedWin: BrowserWindow | null = null

const defaultOptions: Partial<IWinOptions> = {
  titlebar: true,
  customTitlebar: true,
  preload: true,
  maximized: false,
  minWidth: 1280,
  minHeight: 850,
  width: 1280,
  height: 850,
  menu: false,
  skipTaskbar: false,
  resizable: true,
}

function restoreBounds(opts: IWinOptions) {
  const data = store.get(opts.name) || {}

  if (data.bounds) {
    if (!opts.resizable) {
      delete data.bounds.width
      delete data.bounds.height
    }
    extend(opts, data.bounds)
    if (opts.minWidth && opts.width && opts.width < opts.minWidth) {
      opts.width = opts.minWidth
    }
    if (opts.minHeight && opts.height && opts.height < opts.minHeight) {
      opts.height = opts.minHeight
    }
  }

  if (data.maximized) {
    opts.maximized = data.maximized
  }
}

function defaultSavePos(opts: IWinOptions, win: BrowserWindow) {
  const data = store.get(opts.name) || {}
  const maximized = win.isMaximized()

  // Windows 最大化时的 bounds 是铺满屏幕的尺寸：存了会让下次「还原」也变成全屏
  if (!isWindows || !maximized) {
    data.bounds = win.getBounds()
  }
  if (isWindows) {
    data.maximized = maximized
  }
  store.set(opts.name, data)
}

function applyBounds(
  options: BrowserWindowConstructorOptions,
  opts: Required<IWinOptions>
) {
  if (isUndef(opts.x) || isUndef(opts.y)) {
    options.width = opts.width
    options.height = opts.height
    return
  }

  // 上次的位置可能在已拔掉的外接屏上：完全落在某块屏幕工作区内才沿用
  const area = screen.getDisplayMatching({
    x: opts.x,
    y: opts.y,
    width: opts.width,
    height: opts.height,
  }).workArea

  if (
    opts.x >= area.x &&
    opts.x + opts.width <= area.x + area.width &&
    opts.y >= area.y &&
    opts.y + opts.height <= area.y + area.height
  ) {
    options.x = opts.x
    options.y = opts.y
  }
  if (opts.width <= area.width && opts.height <= area.height) {
    options.width = opts.width
    options.height = opts.height
  }
}

export function create(opts: IWinOptions) {
  defaults(opts, defaultOptions)

  if (isUndef(opts.onSavePos)) {
    opts.onSavePos = () => defaultSavePos(opts, win)
    restoreBounds(opts)
  }

  const winOptions = opts as Required<IWinOptions>

  const options: BrowserWindowConstructorOptions = {
    minWidth: winOptions.minWidth,
    minHeight: winOptions.minHeight,
    show: false,
    skipTaskbar: winOptions.skipTaskbar,
    resizable: winOptions.resizable,
  }
  if (!options.resizable) {
    options.maximizable = false
    options.minimizable = false
  }
  applyBounds(options, winOptions)

  // getTheme() 返回 'dark' | 'light' 字符串：不能当布尔用，
  // 否则浅色主题也会拿到深色底色
  options.backgroundColor =
    getTheme() === 'light' ? colorBgContainer : colorBgContainerDark

  if (winOptions.preload) {
    options.webPreferences = {
      preload: path.join(__dirname, '../preload/index.js'),
      webSecurity: false,
      sandbox: false,
    }
  }

  if (winOptions.titlebar) {
    if (winOptions.nativeTitlebarOverlay && isMac) {
      // macOS：内容延伸到顶部，红绿灯由系统绘制，侧栏品牌区自己留位置
      options.titleBarStyle = 'hiddenInset'
      options.trafficLightPosition = { x: 18, y: 18 }
    } else if (winOptions.customTitlebar) {
      options.titleBarStyle = 'hidden'
      options.titleBarOverlay = true
    }
  } else {
    options.frame = false
  }

  logger.debug('create', opts.name, options)
  const win = new BrowserWindow(options)

  const useOverlay = !!(winOptions.titlebar && winOptions.nativeTitlebarOverlay && isMac)
  ;(win as any).nativeTitlebarOverlay = useOverlay
  ;(win as any).customTitlebar =
    winOptions.titlebar && winOptions.customTitlebar && !useOverlay

  if (!winOptions.menu) {
    win.setMenu(null)
  }

  // 拖动/缩放每秒触发几十次：1 秒节流落盘
  const onSavePos = debounce(() => {
    if (!win.isDestroyed() && !win.isFullScreen()) {
      winOptions.onSavePos()
    }
  }, 1000)

  const readyAndShow = once(() => {
    logger.info(opts.name, 'ready and show')
    if (win.isDestroyed()) return

    if (winOptions.maximized && isWindows) win.maximize()
    win.show()
    win.on('resize', onSavePos)
    win.on('moved', onSavePos)
  })

  win.once('ready-to-show', () => {
    logger.info(opts.name, 'on ready-to-show')
    readyAndShow()
  })
  // 兜底：没收到 ready-to-show 也要显示，否则像启动失败
  const showTimer = setTimeout(() => readyAndShow(), 1000)
  win.on('closed', () => clearTimeout(showTimer))

  win.on('show', () => win.webContents.send('showWin'))
  win.on('focus', () => {
    focusedWin = win
    win.webContents.send('focusWin')
  })
  win.on('closed', () => {
    // 同名单窗口可能已经重建：只删自己，别把新窗口的登记抹掉
    if (wins[opts.name] === win) delete wins[opts.name]
    if (focusedWin === win) focusedWin = null
  })
  wins[opts.name] = win

  if (winOptions.titlebar && winOptions.customTitlebar && !useOverlay) {
    attachTitlebarToWindow(win)
    win.setMinimumSize(winOptions.minWidth, winOptions.minHeight)
  }

  return win
}

export function setDefaultOptions(opts: Partial<IWinOptions>) {
  extend(defaultOptions, opts)
}

export function sendAll(channel: string, ...args: any[]) {
  for (const name of Object.keys(wins)) {
    const win = wins[name]
    // 任何一个窗口正在销毁都不能中断整轮广播（否则其它窗口收不到 theme）
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

export function sendFocused(channel: string, ...args: any[]) {
  if (focusedWin && !focusedWin.isDestroyed()) {
    focusedWin.webContents.send(channel, ...args)
  }
}

export function sendTo(name: string, channel: string, ...args: any[]) {
  const win = getWin(name)
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

export function loadPage(win: BrowserWindow, q: types.PlainObj<string> = {}) {
  if (isDev()) {
    let url = 'http://localhost:8080/'
    if (!isEmpty(q)) url += `?${query.stringify(q)}`
    win.loadURL(url)
  } else {
    win.loadFile(path.resolve(__dirname, '../renderer/index.html'), {
      query: q,
    })
  }
}

export function getWin(name: string) {
  return wins[name]
}

export function getFocusedWin() {
  return focusedWin
}
