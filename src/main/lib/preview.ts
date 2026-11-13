/**
 * 侧栏实时预览：设备端 screenrecord 直接出 H264（Annex B），主进程只转发，
 * 渲染层用 WebCodecs 解码到 canvas。
 *
 * 480p/30fps 的设备端编码 + 主机解码比每秒一张 1080p PNG 轻，画面连续。
 * 同一时刻只保留一路预览（侧栏只看当前设备）。
 */
import { spawn, ChildProcess } from 'node:child_process'
import { app } from 'electron'
import log from 'share/common/log'
import { handleEvent } from 'share/main/lib/util'
import * as window from 'share/main/lib/window'
import { IpcStartPreviewStream, IpcStopPreviewStream } from 'common/types'
import { getAdbPath } from './adb/base'

const logger = log('preview')

const SIZE = '480x270'
const BIT_RATE = 600000
// screenrecord 单次最长 180 秒，留 1 秒余量主动重启
const TIME_LIMIT = 179
const MAX_FAILURES = 4
const FLUSH_INTERVAL = 30
const RESTART_DELAY = 300

interface PreviewSession {
  deviceId: string
  proc: ChildProcess | null
  stopped: boolean
  failures: number
  pending: Buffer[]
  flush: ReturnType<typeof setTimeout> | null
}

let session: PreviewSession | null = null
let restartTimer: ReturnType<typeof setTimeout> | null = null

function flushChunk(target: PreviewSession) {
  if (session !== target || target.stopped || !target.pending.length) return
  const buf = Buffer.concat(target.pending)
  target.pending = []
  window.sendTo(
    'main',
    'previewChunk',
    target.deviceId,
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  )
}

function scheduleFlush(target: PreviewSession) {
  if (target.flush) return
  // 30ms 合并一次：screenrecord 的 H264 分片很小，逐片 IPC 太碎
  target.flush = setTimeout(() => {
    target.flush = null
    flushChunk(target)
  }, FLUSH_INTERVAL)
}

function handleExit(target: PreviewSession | null) {
  if (!target || session !== target || target.stopped) return

  target.failures++
  if (target.failures >= MAX_FAILURES) {
    logger.warn('preview stream failed, fall back to png', target.deviceId)
    window.sendTo('main', 'previewError', target.deviceId)
    stop()
    return
  }

  restartTimer = setTimeout(() => {
    restartTimer = null
    if (session === target && !target.stopped) spawnStream(target)
  }, RESTART_DELAY)
}

function spawnStream(target: PreviewSession) {
  const proc = spawn(
    getAdbPath(),
    [
      '-s',
      target.deviceId,
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      `--size=${SIZE}`,
      `--bit-rate=${BIT_RATE}`,
      `--time-limit=${TIME_LIMIT}`,
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )
  target.proc = proc
  let stderr = ''

  proc.stdout?.on('data', (chunk: Buffer) => {
    if (session !== target || target.stopped) return
    // 持续收到码流说明流是健康的，清零重启计数
    target.failures = 0
    target.pending.push(chunk)
    scheduleFlush(target)
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 800) stderr += chunk.toString('utf8')
  })
  proc.on('error', (e) => {
    logger.warn('preview spawn error', target.deviceId, e.message)
    handleExit(target)
  })
  proc.on('exit', (code) => {
    if (session !== target || target.stopped) return
    if (stderr) {
      logger.warn('preview exit', target.deviceId, code, stderr.slice(0, 300))
    }
    handleExit(target)
  })
  logger.info('preview stream start', target.deviceId)
}

function stop() {
  const current = session
  session = null

  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (!current) return

  current.stopped = true
  if (current.flush) {
    clearTimeout(current.flush)
    current.flush = null
  }
  current.pending = []
  if (current.proc) {
    try {
      current.proc.kill('SIGTERM')
    } catch {
      // 进程可能已经退出
    }
  }
}

const startPreviewStream: IpcStartPreviewStream = async (deviceId) => {
  // 同一设备已经在推：不重复启动
  if (session && session.deviceId === deviceId && !session.stopped) return

  stop()
  const target: PreviewSession = {
    deviceId,
    proc: null,
    stopped: false,
    failures: 0,
    pending: [],
    flush: null,
  }
  session = target
  spawnStream(target)
}

const stopPreviewStream: IpcStopPreviewStream = async () => {
  stop()
}

export function init() {
  handleEvent('startPreviewStream', startPreviewStream)
  handleEvent('stopPreviewStream', stopPreviewStream)
  // 退出时必须杀掉 adb exec-out，否则设备端 screenrecord 会残留继续编码
  app.on('before-quit', stop)
}
