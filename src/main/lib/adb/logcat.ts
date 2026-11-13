import Emitter from 'licia/Emitter'
import types from 'licia/types'
import each from 'licia/each'
import { Client } from '@devicefarmer/adbkit'
import { getDeviceStore, getPidNames, setDeviceStore } from './base'
import uniqId from 'licia/uniqId'
import * as window from 'share/main/lib/window'
import { handleEvent } from 'share/main/lib/util'
import {
  IpcCloseLogcat,
  IpcOpenLogcat,
  IpcPauseLogcat,
  IpcResumeLogcat,
} from 'common/types'

let client: Client

const pidRefreshing: Record<string, boolean> = {}
function refreshPidNames(deviceId: string) {
  if (pidRefreshing[deviceId]) return
  pidRefreshing[deviceId] = true
  getPidNames(deviceId)
    .then((names) => {
      const cur = getDeviceStore(deviceId, 'pidNames') || {}
      setDeviceStore(deviceId, 'pidNames', { ...cur, ...names })
    })
    .catch(() => {
      // ignore
    })
    .finally(() => {
      setTimeout(() => (pidRefreshing[deviceId] = false), 5000)
    })
}

class Logcat extends Emitter {
  private reader: any
  private paused = false
  private closed = false
  deviceId: string
  constructor(reader: any, deviceId: string) {
    super()

    this.reader = reader
    this.deviceId = deviceId
  }
  async init(deviceId: string) {
    const { reader } = this

    // 注意：不能在这里 await 拉 pid 名称——每条新 pid 都会同步跑一次 ps，
    // 远程链路下几百毫秒，会把日志流卡住（表现为日志延迟）。
    reader.on('entry', (entry) => {
      if (this.paused) {
        return
      }
      if (entry.pid != 0) {
        const pidNames = getDeviceStore(deviceId, 'pidNames') || {}
        entry.package = pidNames[entry.pid] || `pid-${entry.pid}`
        if (!pidNames[entry.pid]) {
          refreshPidNames(deviceId)
        }
      }
      this.emit('entry', entry)
    })
    // adbkit-logcat 会把解析错误 re-emit 成 'error'：没有监听就是主进程未捕获异常
    reader.on('error', () => {
      this.close()
      this.emit('end')
    })
    reader.on('end', () => this.emit('end'))
  }
  close() {
    // reader.end() 会触发 'end'，我们的 end 处理里又会调 closeLogcat，
    // 没有这个幂等判断就可能自己调自己
    if (this.closed) return
    this.closed = true
    try {
      this.reader.end()
    } catch {
      // ignore
    }
  }
  pause() {
    this.paused = true
  }
  resume() {
    this.paused = false
  }
}

const logcats: types.PlainObj<Logcat> = {}
const pendingFlush: Record<string, { cancel: () => void }> = {}

const openLogcat: IpcOpenLogcat = async function (deviceId) {
  // 同一设备重复打开（重启日志页/刷新）先收掉旧流，否则旧 reader 一直在跑、
  // 旧 logcatId 再也不会被 close，日志会同时推两份
  each(logcats, (old, id) => {
    if (old.deviceId === deviceId) {
      closeLogcat(id).catch(() => {})
    }
  })
  const device = await client.getDevice(deviceId)
  const reader = await device.openLogcat({
    clear: true,
  })
  const logcat = new Logcat(reader, deviceId)
  await logcat.init(deviceId)
  const logcatId = uniqId('logcat')

  // 批量推送：100ms 或累计 300 条刷一次，减少每条的 IPC 开销
  const pending: any[] = []
  let flushTimer: any = null
  const flush = () => {
    if (!pending.length) return
    const arr = pending.splice(0, pending.length)
    window.sendTo('main', 'logcatEntries', logcatId, arr)
  }
  logcat.on('entry', (entry) => {
    pending.push(entry)
    if (pending.length >= 300) {
      flush()
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        flush()
      }, 100)
    }
  })
  logcats[logcatId] = logcat
  pendingFlush[logcatId] = {
    cancel: () => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      pending.length = 0
    },
  }

  // 设备端 logcat 断掉（拔线/adbd 重启）时自动收尾，避免 map 里留着死 reader
  logcat.on('end', () => {
    closeLogcat(logcatId).catch(() => {})
  })

  return logcatId
}

const pauseLogcat: IpcPauseLogcat = async function (logcatId) {
  logcats[logcatId]?.pause()
}

const resumeLogcat: IpcResumeLogcat = async function (logcatId) {
  logcats[logcatId]?.resume()
}

const closeLogcat: IpcCloseLogcat = async function (logcatId) {
  const logcat = logcats[logcatId]
  if (logcat) {
    logcat.close()
    delete logcats[logcatId]
  }
  // 清掉批量推送的挂起数据，避免关闭后仍向已销毁窗口发送
  const pending = pendingFlush[logcatId]
  if (pending) {
    pending.cancel()
    delete pendingFlush[logcatId]
  }
}

export function init(c: Client) {
  client = c

  handleEvent('openLogcat', openLogcat)
  handleEvent('closeLogcat', closeLogcat)
  handleEvent('pauseLogcat', pauseLogcat)
  handleEvent('resumeLogcat', resumeLogcat)
}
