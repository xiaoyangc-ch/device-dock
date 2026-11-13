/**
 * 投屏数据通道：渲染层通过本地 TCP 连主进程里的 adb forward 端口。
 * 用序号管理 socket，关闭/出错都要回收，否则长时间投屏会泄漏句柄。
 */
import net from 'node:net'

const sockets = new Map<number, net.Socket>()
let socketSeq = 0

export default {
  connectStream(
    port: number,
    handlers: {
      onConnect: () => void
      onData: (data: Uint8Array) => void
      onClose: () => void
      onError: (message: string) => void
    }
  ): number {
    const id = ++socketSeq
    const socket = net.connect(port, '127.0.0.1')
    sockets.set(id, socket)

    socket.on('connect', () => handlers.onConnect())
    socket.on('data', (data: Buffer) => handlers.onData(new Uint8Array(data)))
    socket.on('close', () => {
      sockets.delete(id)
      handlers.onClose()
    })
    socket.on('error', (err: Error) => {
      sockets.delete(id)
      handlers.onError(err?.message ? err.message : String(err))
    })

    return id
  },

  writeStream(id: number, data: Uint8Array) {
    sockets.get(id)?.write(data)
  },

  closeStream(id: number) {
    const socket = sockets.get(id)
    sockets.delete(id)
    socket?.destroy()
  },
}
