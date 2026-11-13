/**
 * 投屏数据通道（主进程侧）。
 *
 * 原来由 preload 直接 `net.connect` —— 开启 sandbox 之后 preload 不能再用
 * Node API，所以连接搬到主进程，数据通过 IPC 转发给渲染层。
 * 视频流约 30fps × 几十 KB，IPC 复制一层的开销可以接受。
 */
import net from 'node:net'
import { ipcMain } from 'electron'
import log from 'share/common/log'

const logger = log('stream')

const sockets = new Map<number, net.Socket>()
let seq = 0

export function init() {
  // 同步返回 id：渲染层的 connectStream 是同步签名
  ipcMain.on('streamConnect', (event, port: number) => {
    const id = ++seq
    const sender = event.sender
    const socket = net.connect(port, '127.0.0.1')
    sockets.set(id, socket)

    const send = (type: string, payload?: unknown) => {
      if (!sender.isDestroyed()) sender.send('streamEvent', id, type, payload)
    }

    socket.on('connect', () => send('connect'))
    socket.on('data', (data: Buffer) => send('data', data))
    socket.on('close', () => {
      sockets.delete(id)
      send('close')
    })
    socket.on('error', (err: Error) => {
      sockets.delete(id)
      send('error', err?.message ? err.message : String(err))
    })

    event.returnValue = id
  })

  ipcMain.on('streamWrite', (_event, id: number, data: Uint8Array) => {
    sockets.get(id)?.write(Buffer.from(data))
  })

  ipcMain.on('streamClose', (_event, id: number) => {
    const socket = sockets.get(id)
    if (!socket) return
    sockets.delete(id)
    logger.debug('close stream', id)
    socket.destroy()
  })
}
