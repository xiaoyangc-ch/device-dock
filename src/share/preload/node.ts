import net from 'node:net'

const sockets = new Map<number, net.Socket>()
let socketSeq = 0

export default {
  connectStream: function (
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
      handlers.onError(err && err.message ? err.message : String(err))
    })
    return id
  },
  writeStream: function (id: number, data: Uint8Array) {
    const socket = sockets.get(id)
    if (socket) socket.write(data)
  },
  closeStream: function (id: number) {
    const socket = sockets.get(id)
    sockets.delete(id)
    if (socket) socket.destroy()
  },
}
