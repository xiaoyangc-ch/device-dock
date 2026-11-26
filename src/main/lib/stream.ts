/**
 * 投屏数据通道（主进程侧）。
 *
 * sandbox 开启后 preload 不能用 Node API，socket 由主进程建立；
 * 视频数据走 MessagePort，并按 8ms / 64KB 批量合并，避免每帧一次 IPC。
 *
 * 端口只接受 1–65535，且只连本机 127.0.0.1（adb forward 端口）。
 */
import net from 'node:net'
import { ipcMain } from 'electron'
import type { MessagePortMain, WebContents } from 'electron'
import log from 'share/common/log'
import { isAppUrl } from 'share/main/lib/util'

const logger = log('stream')

const BATCH_MS = 8
const BATCH_BYTES = 64 * 1024
const HIGH_WATER = 2 * 1024 * 1024
const MAX_WRITE = 8 * 1024 * 1024

interface StreamSession {
  key: string
  sender: WebContents
  socket: net.Socket
  port: MessagePortMain
  pending: Buffer[]
  pendingBytes: number
  flushTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
  onSenderDestroyed: () => void
}

const sessions = new Map<string, StreamSession>()

function keyOf(senderId: number, id: number) {
  return `${senderId}:${id}`
}

function send(session: StreamSession, type: string, payload?: unknown) {
  if (session.closed) return
  try {
    session.port.postMessage({ type, payload })
  } catch {
    // port 已关闭：socket 也没必要继续读了
    dispose(session)
  }
}

function flush(session: StreamSession) {
  if (session.closed || !session.pending.length) return

  if (session.flushTimer) {
    clearTimeout(session.flushTimer)
    session.flushTimer = null
  }

  const buf =
    session.pending.length === 1
      ? session.pending[0]
      : Buffer.concat(session.pending, session.pendingBytes)
  session.pending = []
  session.pendingBytes = 0

  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  try {
    // Electron 的 MessagePortMain 只允许 MessagePort 进 transfer list，
    // ArrayBuffer 仍会结构化克隆；批量合并后每 8ms 只克隆一次，已比逐帧 IPC 省。
    session.port.postMessage({ type: 'data', payload: data })
  } catch {
    dispose(session)
    return
  }

  if (session.socket.isPaused()) session.socket.resume()
}

function scheduleFlush(session: StreamSession) {
  if (session.flushTimer) return
  session.flushTimer = setTimeout(() => {
    session.flushTimer = null
    flush(session)
  }, BATCH_MS)
}

function dispose(session: StreamSession) {
  if (session.closed) return
  session.closed = true

  if (session.flushTimer) {
    clearTimeout(session.flushTimer)
    session.flushTimer = null
  }
  session.pending = []
  session.pendingBytes = 0
  sessions.delete(session.key)
  session.sender.removeListener('destroyed', session.onSenderDestroyed)

  try {
    session.socket.destroy()
  } catch {
    // 已断开
  }
  // 让 close/error 消息先到达渲染层，再关闭 port
  setTimeout(() => {
    try {
      session.port.close()
    } catch {
      // 已关闭
    }
  }, 1000)
}

function closeWith(
  session: StreamSession,
  type: 'close' | 'error',
  message?: string,
) {
  if (session.closed) return
  if (type === 'close') {
    flush(session)
    send(session, 'close')
  } else {
    send(session, 'error', message || '连接已断开')
  }
  dispose(session)
}

export function init() {
  ipcMain.on('streamOpen', (event, payload: unknown) => {
    if (!isAppUrl(event.senderFrame?.url || '')) {
      event.ports?.[0]?.close()
      return
    }
    const port = event.ports && event.ports[0]
    const id =
      payload && typeof payload === 'object'
        ? Number((payload as { id?: unknown }).id)
        : NaN
    const portNumber =
      payload && typeof payload === 'object'
        ? Number((payload as { port?: unknown }).port)
        : NaN

    if (
      !port ||
      !Number.isInteger(id) ||
      id <= 0 ||
      !Number.isInteger(portNumber) ||
      portNumber < 1 ||
      portNumber > 65535
    ) {
      port?.close()
      return
    }

    const sender = event.sender
    const key = keyOf(sender.id, id)
    const old = sessions.get(key)
    if (old) dispose(old)

    const socket = net.connect(portNumber, '127.0.0.1')
    socket.setNoDelay(true)
    const session: StreamSession = {
      key,
      sender,
      socket,
      port,
      pending: [],
      pendingBytes: 0,
      flushTimer: null,
      closed: false,
      onSenderDestroyed: () => dispose(session),
    }
    sessions.set(key, session)

    socket.once('connect', () => send(session, 'connect'))
    socket.on('data', (chunk: Buffer) => {
      if (session.closed) return
      session.pending.push(chunk)
      session.pendingBytes += chunk.length

      if (session.pendingBytes >= HIGH_WATER) {
        socket.pause()
        flush(session)
      } else if (session.pendingBytes >= BATCH_BYTES) {
        flush(session)
      } else {
        scheduleFlush(session)
      }
    })
    socket.on('close', () => closeWith(session, 'close'))
    socket.on('error', (err: Error) =>
      closeWith(session, 'error', err?.message || String(err)),
    )

    sender.once('destroyed', session.onSenderDestroyed)
    logger.debug('open stream', key, portNumber)
  })

  ipcMain.on('streamWrite', (event, id: number, data: Uint8Array) => {
    if (!isAppUrl(event.senderFrame?.url || '')) return
    if (!Number.isInteger(id) || id <= 0) return
    const session = sessions.get(keyOf(event.sender.id, id))
    if (!session || session.closed) return
    if (!data || data.byteLength > MAX_WRITE) return
    try {
      session.socket.write(Buffer.from(data))
    } catch {
      closeWith(session, 'error', '写入失败')
    }
  })

  ipcMain.on('streamClose', (event, id: number) => {
    if (!isAppUrl(event.senderFrame?.url || '')) return
    if (!Number.isInteger(id) || id <= 0) return
    const session = sessions.get(keyOf(event.sender.id, id))
    if (session) dispose(session)
  })
}
