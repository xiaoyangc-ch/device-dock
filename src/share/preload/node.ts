/**
 * 投屏数据通道（preload 侧）。
 *
 * sandbox 下 preload 不能直接用 Node socket；主进程建立连接后，
 * 用 MessagePort 把视频数据推过来（比每帧 ipcRenderer 事件少一层路由）。
 * 对外接口保持不变：connectStream / writeStream / closeStream。
 */
import { ipcRenderer } from 'electron'

type StreamHandlers = {
  onConnect: () => void
  onData: (data: Uint8Array) => void
  onClose: () => void
  onError: (message: string) => void
}

type StreamMessage = {
  type: 'connect' | 'data' | 'close' | 'error'
  payload?: unknown
}

interface Entry {
  handlers: StreamHandlers
  port: MessagePort
}

const entries = new Map<number, Entry>()
let seq = 0

export default {
  connectStream(port: number, handlers: StreamHandlers): number {
    const id = ++seq
    const channel = new MessageChannel()
    const entry: Entry = { handlers, port: channel.port1 }
    entries.set(id, entry)

    channel.port1.onmessage = (event: MessageEvent<StreamMessage>) => {
      const current = entries.get(id)
      if (!current) return
      const msg = event.data
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'data') {
        const payload = msg.payload
        if (payload instanceof ArrayBuffer) {
          current.handlers.onData(new Uint8Array(payload))
        }
      } else if (msg.type === 'connect') {
        current.handlers.onConnect()
      } else if (msg.type === 'close') {
        entries.delete(id)
        current.port.close()
        current.handlers.onClose()
      } else if (msg.type === 'error') {
        entries.delete(id)
        current.port.close()
        current.handlers.onError(String(msg.payload || '连接已断开'))
      }
    }
    channel.port1.start()

    try {
      ipcRenderer.postMessage('streamOpen', { id, port }, [channel.port2])
    } catch (e: any) {
      entries.delete(id)
      queueMicrotask(() => handlers.onError(e?.message || String(e)))
    }

    return id
  },

  writeStream(id: number, data: Uint8Array) {
    if (!entries.has(id)) return
    ipcRenderer.send('streamWrite', id, data)
  },

  closeStream(id: number) {
    const entry = entries.get(id)
    if (!entry) return
    entries.delete(id)
    try {
      entry.port.close()
    } catch {
      // 已关闭
    }
    ipcRenderer.send('streamClose', id)
  },
}
