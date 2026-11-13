import { spawn, ChildProcess } from 'node:child_process'
import { app } from 'electron'
import log from 'share/common/log'
import { handleEvent } from 'share/main/lib/util'
import * as window from 'share/main/lib/window'
import { IpcStartPreviewStream, IpcStopPreviewStream } from 'common/types'
import { getAdbPath } from './adb/base'

const logger = log('preview')

// 侧栏预览流：screenrecord 直接出 H264（Annex B），主进程只做转发，
// 渲染层用 WebCodecs 解码到 canvas。480p/30fps 的设备端编码和主机解码都比
// 每秒一张 1080p PNG 轻，画面连续。
const SIZE = '480x270'
const BIT_RATE = 600000
const TIME_LIMIT = 179
const MAX_FAILURES = 4

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

function flushChunk(s: PreviewSession) {
  if (session !== s || s.stopped || !s.pending.length) return
  const buf = Buffer.concat(s.pending)
  s.pending = []
  window.sendTo(
    'main',
    'previewChunk',
    s.deviceId,
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  )
}

function scheduleFlush(s: PreviewSession) {
  if (s.flush) return
  // 30ms 合并一次：screenrecord 的 H264 分片很小，逐片 IPC 太碎
  s.flush = setTimeout(() => {
    s.flush = null
    flushChunk(s)
  }, 30)
}

function onExit(s: PreviewSession | null) {
  if (!s || session !== s || s.stopped) return
  s.failures++
  if (s.failures >= MAX_FAILURES) {
    logger.warn('preview stream failed, fall back to png', s.deviceId)
    window.sendTo('main', 'previewError', s.deviceId)
    stop()
    return
  }
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (session === s && !s.stopped) spawnStream(s)
  }, 300)
}

function spawnStream(s: PreviewSession) {
  const proc = spawn(
    getAdbPath(),
    [
      '-s',
      s.deviceId,
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      `--size=${SIZE}`,
      `--bit-rate=${BIT_RATE}`,
      `--time-limit=${TIME_LIMIT}`,
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  s.proc = proc
  let stderr = ''

  proc.stdout?.on('data', (chunk: Buffer) => {
    if (session !== s || s.stopped) return
    // 能持续收到码流说明流是健康的，清掉重启计数
    s.failures = 0
    s.pending.push(chunk)
    scheduleFlush(s)
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 800) stderr += chunk.toString('utf8')
  })
  proc.on('error', (e) => {
    logger.warn('preview spawn error', s.deviceId, e.message)
    onExit(s)
  })
  proc.on('exit', (code) => {
    if (session !== s || s.stopped) return
    if (stderr) {
      logger.warn('preview exit', s.deviceId, code, stderr.slice(0, 300))
    }
    onExit(s)
  })
  logger.info('preview stream start', s.deviceId)
}

function stop() {
  const s = session
  session = null
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (!s) return
  s.stopped = true
  if (s.flush) {
    clearTimeout(s.flush)
    s.flush = null
  }
  s.pending = []
  if (s.proc) {
    try {
      s.proc.kill('SIGTERM')
    } catch {
      // 进程可能已经退出
    }
  }
}

const startPreviewStream: IpcStartPreviewStream = async function (deviceId) {
  if (session && session.deviceId === deviceId && !session.stopped) return
  stop()
  const s: PreviewSession = {
    deviceId,
    proc: null,
    stopped: false,
    failures: 0,
    pending: [],
    flush: null,
  }
  session = s
  spawnStream(s)
}

const stopPreviewStream: IpcStopPreviewStream = async function () {
  stop()
}

export function init() {
  handleEvent('startPreviewStream', startPreviewStream)
  handleEvent('stopPreviewStream', stopPreviewStream)
  // 退出时必须杀掉 adb exec-out，否则设备端 screenrecord 会残留继续编码
  app.on('before-quit', stop)
}
