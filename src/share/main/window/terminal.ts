/**
 * 日志窗口：接管 stdout/stderr 给渲染层看。
 * 常驻几天的应用日志会无限增长，只保留最近 5000 条。
 */
import { BrowserWindow, ipcMain } from 'electron'
import * as window from '../../main/lib/window'
import once from 'licia/once'
import { IpcGetLogs } from '../../common/types'
import { assertTrustedSender } from '../lib/util'

const MAX_LOGS = 5000
const MAX_LOG_CHARS = 2_000_000
const MAX_ENTRY_CHARS = 64 * 1024

let win: BrowserWindow | null = null
const logs: string[] = []
let logChars = 0

export function showWin() {
  if (win && !win.isDestroyed()) {
    win.focus()
    return
  }

  initIpc()

  win = window.create({
    name: 'terminal',
    width: 960,
    height: 640,
    minWidth: 960,
    minHeight: 640,
    menu: false,
  })

  const created = win
  created.on('close', () => {
    if (win === created) win = null
    if (!created.isDestroyed()) created.destroy()
  })

  window.loadPage(created, { page: 'terminal' })
}

export function init() {
  const originalStdout = process.stdout.write
  const originalStderr = process.stderr.write

  process.stdout.write = function (...args: any[]) {
    addLog(args[0])
    return originalStdout.apply(process.stdout, args as any)
  }

  process.stderr.write = function (...args: any[]) {
    addLog(args[0])
    return originalStderr.apply(process.stderr, args as any)
  }

  process.on('uncaughtException', (err) => console.error(err))
  process.on('unhandledRejection', (err) => console.error(err))
}

function addLog(data: unknown) {
  const text = Buffer.isBuffer(data)
    ? data.toString('utf8')
    : String(data ?? '')
  const entry = text.slice(-MAX_ENTRY_CHARS)
  logs.push(entry)
  logChars += entry.length
  while (logs.length > MAX_LOGS || logChars > MAX_LOG_CHARS) {
    const removed = logs.shift()
    logChars -= removed?.length || 0
  }
  // 窗口没开时 sendTo 会静默丢弃，日志仍留在缓冲里
  window.sendTo('terminal', 'addLog', entry)
}

const initIpc = once(() => {
  ipcMain.handle('getLogs', <IpcGetLogs>((event: any) => {
    assertTrustedSender(event)
    return logs
  }))
  ipcMain.handle('clearLogs', (event) => {
    assertTrustedSender(event)
    logs.length = 0
    logChars = 0
  })
})
