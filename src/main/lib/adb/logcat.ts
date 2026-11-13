/**
 * 日志流：按设备开 logcat reader，批量推给渲染层。
 *
 * 两个关键点：
 * - 每条日志都用 pid→进程名映射补 package 字段，但映射刷新不能阻塞日志流；
 * - 推送按 100ms / 300 条批量发送，避免每条日志一次 IPC。
 */
import Emitter from 'licia/Emitter'
import uniqId from 'licia/uniqId'
import { Client } from '@devicefarmer/adbkit'
import { getDeviceStore, getPidNames, setDeviceStore } from './base'
import * as window from 'share/main/lib/window'
import { handleEvent } from 'share/main/lib/util'
import {
  IpcCloseLogcat,
  IpcOpenLogcat,
  IpcPauseLogcat,
  IpcResumeLogcat,
} from 'common/types'

let client: Client

// ---------------------------------------------------------------------------
// pid → 进程名
// ---------------------------------------------------------------------------

const pidRefreshing = new Set<string>()

function refreshPidNames(deviceId: string) {
  if (pidRefreshing.has(deviceId)) return
  pidRefreshing.add(deviceId)
  getPidNames(deviceId)
    .then((names) => {
      const current = getDeviceStore(deviceId, 'pidNames') || {}
      setDeviceStore(deviceId, 'pidNames', { ...current, ...names })
    })
    .catch(() => {
      // 设备忙/离线：下一个新 pid 会再触发
    })
    .finally(() => {
      // 5 秒内不重复拉：日志量大时 ps 会把流拖慢
      setTimeout(() => pidRefreshing.delete(deviceId), 5000)
    })
}

// ---------------------------------------------------------------------------
// 日志流
// ---------------------------------------------------------------------------

class LogcatStream extends Emitter {
  private reader: any
  private paused = false
  private closed = false
  readonly deviceId: string

  constructor(reader: any, deviceId: string) {
    super()
    this.reader = reader
    this.deviceId = deviceId
  }

  init() {
    const { reader } = this

    reader.on('entry', (entry: any) => {
      if (this.paused) return

      if (entry.pid != 0) {
        const pidNames = getDeviceStore(this.deviceId, 'pidNames') || {}
        entry.package = pidNames[entry.pid] || `pid-${entry.pid}`
        // 没命中就异步刷新映射，绝不在这里 await：远程链路下 ps 要几百毫秒
        if (!pidNames[entry.pid]) refreshPidNames(this.deviceId)
      }
      this.emit('entry', entry)
    })

    // adbkit-logcat 会把解析错误 re-emit 成 error：没有监听就是主进程未捕获异常
    reader.on('error', () => {
      this.close()
      this.emit('end')
    })
    reader.on('end', () => this.emit('end'))
  }

  close() {
    // reader.end() 会触发 end 事件，end 处理里又会调 close：必须幂等
    if (this.closed) return
    this.closed = true
    try {
      this.reader.end()
    } catch {
      // 已经断开
    }
  }

  pause() {
    this.paused = true
  }

  resume() {
    this.paused = false
  }
}

interface LogcatEntry {
  stream: LogcatStream
  pending: any[]
  timer: ReturnType<typeof setTimeout> | null
}

const streams = new Map<string, LogcatEntry>()

/** 批量推送：100ms 或累计 300 条刷一次。 */
function scheduleFlush(id: string) {
  const entry = streams.get(id)
  if (!entry) return
  if (entry.pending.length >= 300) {
    flush(id)
    return
  }
  if (entry.timer) return
  entry.timer = setTimeout(() => {
    entry.timer = null
    flush(id)
  }, 100)
}

function flush(id: string) {
  const entry = streams.get(id)
  if (!entry || !entry.pending.length) return
  const batch = entry.pending.splice(0, entry.pending.length)
  window.sendTo('main', 'logcatEntries', id, batch)
}

const openLogcat: IpcOpenLogcat = async (deviceId) => {
  // 同一设备重复打开（重启日志页/刷新）先收掉旧流：
  // 旧 reader 不关会同时推两份，旧 id 也再没人 close
  for (const [oldId, old] of [...streams]) {
    if (old.stream.deviceId === deviceId) {
      closeLogcat(oldId).catch(() => {})
    }
  }

  const device = await client.getDevice(deviceId)
  const reader = await device.openLogcat({ clear: true })
  const stream = new LogcatStream(reader, deviceId)
  stream.init()

  const logcatId = uniqId('logcat')
  const entry: LogcatEntry = { stream, pending: [], timer: null }
  streams.set(logcatId, entry)

  stream.on('entry', (item: any) => {
    entry.pending.push(item)
    scheduleFlush(logcatId)
  })
  // 设备端 logcat 断掉（拔线/adbd 重启）时自动收尾，避免 map 里留死 reader
  stream.on('end', () => {
    closeLogcat(logcatId).catch(() => {})
  })

  return logcatId
}

const pauseLogcat: IpcPauseLogcat = async (logcatId) => {
  streams.get(logcatId)?.stream.pause()
}

const resumeLogcat: IpcResumeLogcat = async (logcatId) => {
  streams.get(logcatId)?.stream.resume()
}

const closeLogcat: IpcCloseLogcat = async (logcatId) => {
  const entry = streams.get(logcatId)
  if (entry) {
    entry.stream.close()
    if (entry.timer) clearTimeout(entry.timer)
    entry.pending.length = 0
    streams.delete(logcatId)
  }
}

export function init(c: Client) {
  client = c

  handleEvent('openLogcat', openLogcat)
  handleEvent('closeLogcat', closeLogcat)
  handleEvent('pauseLogcat', pauseLogcat)
  handleEvent('resumeLogcat', resumeLogcat)
}
