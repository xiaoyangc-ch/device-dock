/**
 * 本地 TCP → ReadableStream 适配。
 *
 * 投屏有两条独立连接（视频 + 控制），都要能「连上就返回」或「等到首包再返回」，
 * 并且失败时抛错而不是返回 null——调用方用 try/catch 组织重试更直观。
 */
export class SocketStream {
  readonly stream: ReadableStream<Uint8Array>
  private socketId = 0
  private closed = false

  private constructor(stream: ReadableStream<Uint8Array>) {
    this.stream = stream
  }

  get id() {
    return this.socketId
  }

  close() {
    if (this.closed) return
    this.closed = true

    if (this.socketId) {
      node.closeStream(this.socketId)
      this.socketId = 0
    }
  }

  /**
   * @param waitFirstByte 首包到达才 resolve。视频流必须先拿到包头再交给解码器，
   *                      否则 parseVideoStreamMetadata 会读到空流。
   */
  static open(
    port: number,
    { waitFirstByte = false, timeoutMs = 12000 } = {}
  ): Promise<SocketStream> {
    return new Promise((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null

      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c
        },
        cancel() {
          if (result.socketId) node.closeStream(result.socketId)
        },
      })

      const result = new SocketStream(stream)

      const finish = (error?: Error) => {
        if (settled) return
        settled = true

        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (error) {
          result.close()
          reject(error)
          return
        }
        resolve(result)
      }

      timer = setTimeout(() => {
        finish(new Error('连接超时'))
      }, timeoutMs)

      result.socketId = node.connectStream(port, {
        onConnect: () => {
          if (!waitFirstByte) finish()
        },
        onData: (data: Uint8Array) => {
          if (!settled) {
            // ReadableStream 的 start() 只保存了 controller，并没有 enqueue 任何东西：
            // 首包必须在这里入队再放行，否则它会被永久丢弃——而 scrcpy 视频流的
            // 首包正好是 dummy byte + 设备名 + codec + 宽高，丢了元数据就解析错位
            try {
              controller?.enqueue(data)
            } catch {
              // 流已取消：忽略
            }
            finish()
            return
          }
          try {
            controller?.enqueue(data)
          } catch {
            // 流已取消：忽略
          }
        },
        onClose: () => {
          try {
            controller?.close()
          } catch {
            // ignore
          }
          if (!settled) finish(new Error('连接被关闭'))
        },
        onError: (message: string) => {
          if (!settled) {
            finish(new Error(message))
            return
          }
          try {
            controller?.error(new Error(message))
          } catch {
            // ignore
          }
        },
      })
    })
  }
}

/**
 * scrcpy 3.1 的视频流在协议头之前会多一个 0 字节（compat 兼容位），
 * 不剥掉的话元数据解析会整体错位。
 */
export function stripCompatByte(
  input: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const reader = input.getReader()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const first = await reader.read()
      if (first.done) {
        controller.close()
        return
      }

      let head = first.value
      if (head?.length && head[0] === 0) head = head.slice(1)
      if (head?.length) controller.enqueue(head)
    },
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      controller.enqueue(value)
    },
    cancel(reason) {
      reader.cancel(reason)
    },
  })
}
