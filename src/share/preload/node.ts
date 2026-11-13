/**
 * 投屏数据通道（preload 侧）。
 *
 * 开启 sandbox 后 preload 不能用 Node API，socket 实际由主进程建立
 * （`main/lib/stream.ts`），本文件只通过 IPC 转发数据与事件。
 * 对外接口保持不变：connectStream / writeStream / closeStream。
 */
import { ipcRenderer } from 'electron'

type StreamHandlers = {
  onConnect: () => void
  onData: (data: Uint8Array) => void
  onClose: () => void
  onError: (message: string) => void
}

const handlers = new Map<number, StreamHandlers>()

ipcRenderer.on(
  'streamEvent',
  (_event, id: number, type: string, payload?: unknown) => {
    const h = handlers.get(id)
    if (!h) return
    if (type === 'connect') {
      h.onConnect()
    } else if (type === 'data') {
      h.onData(new Uint8Array(payload as ArrayBuffer))
    } else if (type === 'close') {
      handlers.delete(id)
      h.onClose()
    } else if (type === 'error') {
      handlers.delete(id)
      h.onError(String(payload))
    }
  }
)

export default {
  connectStream(port: number, h: StreamHandlers): number {
    // 同步拿 id：上层是按「调用即得 id」写的
    const id = ipcRenderer.sendSync('streamConnect', port) as number
    handlers.set(id, h)
    return id
  },

  writeStream(id: number, data: Uint8Array) {
    ipcRenderer.send('streamWrite', id, data)
  },

  closeStream(id: number) {
    handlers.delete(id)
    ipcRenderer.send('streamClose', id)
  },
}
