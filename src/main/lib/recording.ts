/**
 * 投屏录制：分片直接写盘。
 *
 * 之前整段 webm 堆在渲染进程内存里，10 分钟 1080p 就是几百 MB，
 * 长录制必然卡死；现在每个分片落到 userData/recordings/<device>-<时间>.webm。
 */
import fs from 'node:fs'
import path from 'node:path'
import uniqId from 'licia/uniqId'
import { app } from 'electron'
import { getUserDataPath, handleEvent } from 'share/main/lib/util'
import log from 'share/common/log'
import {
  IpcRecordingChunk,
  IpcRecordingStart,
  IpcRecordingStop,
} from 'common/types'

const logger = log('recording')

const sessions = new Map<string, { stream: fs.WriteStream; file: string }>()

function timestamp() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

const start: IpcRecordingStart = async (deviceId) => {
  const dir = getUserDataPath('recordings')
  fs.mkdirSync(dir, { recursive: true })

  const safeId = String(deviceId).replace(/[^\w.-]+/g, '_')
  const file = path.join(dir, `${safeId}-${timestamp()}.webm`)
  const stream = fs.createWriteStream(file)
  stream.on('error', (e) => logger.error('write failed', e))

  const id = uniqId('rec')
  sessions.set(id, { stream, file })
  logger.info('recording start', file)
  return { id, path: file }
}

const chunk: IpcRecordingChunk = async (id, data) => {
  const session = sessions.get(id)
  if (!session) return

  const buf = Buffer.from(data)
  if (session.stream.write(buf)) return

  // 磁盘写得慢就等 drain，别把视频堆回内存；
  // 磁盘满/无权限时 drain 永远不会来，必须同时监听 error
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      session.stream.off('drain', onDrain)
      session.stream.off('error', onError)
    }
    session.stream.once('drain', onDrain)
    session.stream.once('error', onError)
  })
}

const stop: IpcRecordingStop = async (id) => {
  const session = sessions.get(id)
  if (!session) return { path: '' }

  sessions.delete(id)
  await new Promise<void>((resolve) => session.stream.end(() => resolve()))
  logger.info('recording stop', session.file)
  return { path: session.file }
}

/** webm 的 Duration 在 trailer 里：退出前必须正常 end 所有还在写的流。 */
function closeAll() {
  for (const [, session] of sessions) {
    try {
      session.stream.end()
    } catch {
      // ignore
    }
  }
  sessions.clear()
}

export function init() {
  handleEvent('recordingStart', start)
  handleEvent('recordingChunk', chunk)
  handleEvent('recordingStop', stop)
  app.on('will-quit', closeAll)
}
