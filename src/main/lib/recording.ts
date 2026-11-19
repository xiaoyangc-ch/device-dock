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

const sessions = new Map<
  string,
  {
    stream: fs.WriteStream
    file: string
    deviceId: string
    error: Error | null
  }
>()

function timestamp() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

const start: IpcRecordingStart = async (deviceId) => {
  // 同一设备重复 start（连点 / 面板重载）会留下没人 end 的流和半截 webm：
  // 新会话开始前先把旧的正常收尾
  for (const [oldId, old] of [...sessions]) {
    if (old.deviceId === deviceId) {
      await stop(oldId).catch(() => undefined)
      logger.warn('recording restart, closed previous session', old.file)
    }
  }

  const dir = getUserDataPath('recordings')
  fs.mkdirSync(dir, { recursive: true })

  const safeId = String(deviceId).replace(/[^\w.-]+/g, '_')
  const file = path.join(dir, `${safeId}-${timestamp()}.webm`)
  const stream = fs.createWriteStream(file)
  const session = {
    stream,
    file,
    deviceId,
    error: null as Error | null,
  }
  stream.on('error', (e) => {
    session.error = e
    logger.error('write failed', e)
  })

  const id = uniqId('rec')
  sessions.set(id, session)
  logger.info('recording start', file)
  return { id, path: file }
}

const chunk: IpcRecordingChunk = async (id, data) => {
  const session = sessions.get(id)
  if (!session) throw new Error('录制会话已结束')
  if (session.error) throw session.error
  if (session.stream.destroyed) throw new Error('录制文件已关闭')

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
  if (!session) return { path: '', ok: false, error: '录制会话不存在' }

  // 流已经 emit 过 error（autoDestroy）时 end 的回调不保证被调用，
  // 直接 await 会让 IPC 悬着、按钮卡在「停止中」
  if (!session.stream.destroyed) {
    let timer: ReturnType<typeof setTimeout> | null = null
    const completed = await Promise.race([
      new Promise<boolean>((resolve) =>
        session.stream.end(() => resolve(true))
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 3000)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (!completed && !session.error) {
      session.error = new Error('录制文件收尾超时')
    }
  }

  sessions.delete(id)
  logger.info('recording stop', session.file)
  return {
    path: session.file,
    ok: !session.error,
    error: session.error?.message,
  }
}

/** webm 的 Duration 在 trailer 里：退出前必须等所有流完成 end。 */
async function closeAll() {
  await Promise.all(
    [...sessions.keys()].map((id) => stop(id).catch(() => undefined))
  )
}

export function init() {
  handleEvent('recordingStart', start)
  handleEvent('recordingChunk', chunk)
  handleEvent('recordingStop', stop)

  let quitting = false
  let readyToQuit = false
  app.on('before-quit', (event) => {
    if (readyToQuit || !sessions.size) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    closeAll().finally(() => {
      readyToQuit = true
      app.quit()
    })
  })
}
