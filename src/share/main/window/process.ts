/**
 * 应用进程面板窗口：列出 Electron 自身进程（主/渲染/GPU/工具进程）的 CPU 和内存，
 * 支持查看 devtools 和结束进程。设备上的进程管理在 src/main/lib/adb 里，与这里无关。
 */
import { BrowserWindow, app, webContents, WebContents } from 'electron'
import type { ProcessMetric } from 'electron'
import * as window from '../../main/lib/window'
import once from 'licia/once'
import { handleEvent } from '../lib/util'
import {
  IpcGetCpuAndMem,
  IpcGetProcessData,
  IpcKillProcess,
  IpcOpenDevtools,
  IProcess,
} from '../../common/types'
import map from 'licia/map'
import { t } from '../../common/i18n'
import { isDev } from '../../common/util'
import isEmpty from 'licia/isEmpty'
import singleton from 'licia/singleton'
import os from 'os'

let win: BrowserWindow | null = null

export function showWin() {
  if (win && !win.isDestroyed()) {
    win.focus()
    return
  }

  initIpc()

  win = window.create({
    name: 'process',
    width: 640,
    height: 480,
    minWidth: 640,
    minHeight: 480,
  })

  const created = win
  created.on('close', () => {
    // 先置空再 destroy：destroy 会同步再触发一次 close，第二次进来 win 已是 null
    if (win === created) win = null
    if (!created.isDestroyed()) created.destroy()
  })

  window.loadPage(created, { page: 'process' })
}

let debugWin: BrowserWindow | null = null

export async function debugMainProcess() {
  if (!isDev()) return
  if (debugWin) {
    debugWin.focus()
    return
  }

  const targets = await fetch('http://127.0.0.1:9229/json/list').then((res) =>
    res.json()
  )
  if (isEmpty(targets)) return

  debugWin = window.create({
    name: 'devtools',
    preload: false,
    customTitlebar: false,
    menu: false,
  })
  debugWin.loadURL(targets[0].devtoolsFrontendUrl)
  debugWin.on('close', () => {
    debugWin?.destroy()
    debugWin = null
  })
}

const cpuNum = os.cpus().length

// preload 隔离世界的 id：用它才能在渲染进程里拿到那块 world 的 process 对象
const PRELOAD_WORLD_ID = 999

/**
 * Electron 的 workingSetSize 含共享页，几个渲染进程加总常大于物理内存。
 * 主进程和渲染进程都能拿到更准的 private，拿不到再退回 workingSetSize。
 */
async function getMemoryFootprint(
  metric: ProcessMetric,
  wc?: WebContents
): Promise<number> {
  const fallback = metric.memory.workingSetSize

  if (metric.pid === process.pid) {
    try {
      return (await process.getProcessMemoryInfo()).private
    } catch {
      return fallback
    }
  }

  if (wc && !wc.isDestroyed()) {
    try {
      const info = await wc.executeJavaScriptInIsolatedWorld(
        PRELOAD_WORLD_ID,
        [{ code: 'process.getProcessMemoryInfo()' }]
      )
      return info.private
    } catch {
      return fallback
    }
  }

  return fallback
}

const getProcessData: IpcGetProcessData = singleton(async () => {
  const wcByPid = Object.fromEntries(
    map(webContents.getAllWebContents(), (wc) => [wc.getOSProcessId(), wc])
  )

  return Promise.all(
    map(app.getAppMetrics(), async (metric) => {
      const wc = wcByPid[metric.pid]
      const item: IProcess = {
        name: metric.name || metric.serviceName || '',
        pid: metric.pid,
        // Electron 报的是单核占比，乘核数才是活动监视器那种 100% 口径
        cpu: metric.cpu.percentCPUUsage * cpuNum,
        memory: await getMemoryFootprint(metric, wc),
        type: metric.type,
      }

      if (wc) {
        item.name = wc.getTitle() || item.name
        item.webContentsId = wc.id
      }
      if (metric.pid === process.pid) item.name = t('mainProcess')
      return item
    })
  )
})

export const getCpuAndMem: IpcGetCpuAndMem = async () => {
  const data = await getProcessData()
  let cpu = 0
  let memory = 0
  for (const item of data) {
    cpu += item.cpu
    memory += item.memory
  }
  return { cpu: cpu / cpuNum, memory }
}

const initIpc = once(() => {
  handleEvent('getProcessData', getProcessData)
  handleEvent(
    'killProcess',
    <IpcKillProcess>(async (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid pid')

      // 只允许结束 Electron 自己的进程：直接 process.kill 会误杀系统进程
      const data = await getProcessData()
      if (!data.some((item) => item.pid === pid)) {
        throw new Error('pid not found')
      }
      process.kill(pid, 'SIGTERM')
    })
  )
  handleEvent(
    'openDevtools',
    <IpcOpenDevtools>((webContentsId) => {
      webContents.fromId(webContentsId)?.openDevTools({ mode: 'detach' })
    })
  )
  handleEvent('debugMainProcess', debugMainProcess)
})
