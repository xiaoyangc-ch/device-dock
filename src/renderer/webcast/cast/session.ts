/**
 * 投屏会话：把「建端口 → 起 server → 等监听 → 拉视频流 → 拉控制流 → 解码」串成状态机。
 *
 * 状态：idle → connecting → live，任何一步失败进 failed（附原因）。
 * 重连由界面层决定（换 codec/信号源/手动重试），这里只负责单次会话的生命周期。
 */
import {
  AndroidKeyCode,
  ScrcpyOptions3_1,
  ScrcpyVideoCodecId,
} from '@yume-chan/scrcpy'
import {
  InsertableStreamVideoFrameRenderer,
  WebCodecsVideoDecoder,
} from '@yume-chan/scrcpy-decoder-webcodecs'
import { ControlChannel } from './control'
import { decodeIncoming } from './protocol'
import { makeScid } from './scid'
import { SocketStream, stripCompatByte } from './transport'

export type SessionState = 'idle' | 'connecting' | 'live' | 'failed'

export interface CastConfig {
  bitRate: number
  maxSize: number
  maxFps: number
  codec: 'h264' | 'h265'
  displayId?: number
}

export interface SessionHooks {
  onState: (state: SessionState, detail?: string) => void
  onToast: (message: string) => void
  onVideo: (element: HTMLVideoElement, width: number, height: number) => void
  onSize: (width: number, height: number) => void
  onClipboard: (text: string) => void
}

const VIDEO_ATTEMPTS = 3
const CONTROL_ATTEMPTS = 5
const RETRY_DELAY = 300
const FIRST_FRAME_TIMEOUT = 8000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class CastSession {
  readonly control: ControlChannel

  private video: SocketStream | null = null
  private ctl: SocketStream | null = null
  private decoder: WebCodecsVideoDecoder | null = null
  private videoElement: HTMLVideoElement | null = null
  private state: SessionState = 'idle'
  private disposed = false
  private firstFrameTimer: ReturnType<typeof setTimeout> | null = null
  private deviceSize = { width: 1280, height: 720 }

  constructor(
    private readonly deviceId: string,
    private readonly hooks: SessionHooks
  ) {
    this.control = new ControlChannel(
      (id, data) => node.writeStream(id, data),
      (text) => hooks.onClipboard(text),
      (message) => hooks.onToast(message)
    )
  }

  get currentState() {
    return this.state
  }

  get size() {
    return this.deviceSize
  }

  get videoEl() {
    return this.videoElement
  }

  private setState(state: SessionState, detail?: string) {
    if (this.disposed && state !== 'idle') return

    this.state = state
    this.hooks.onState(state, detail)
  }

  /** 单次会话：失败直接 throw，由调用方决定是否重试。 */
  async start(config: CastConfig) {
    this.setState('connecting')

    // 先停上一路：server/forward 的清理要是晚于新会话启动，会把新会话踢掉
    await this.stopTransport()

    const options = new ScrcpyOptions3_1({
      audio: false,
      control: true,
      maxSize: config.maxSize,
      videoBitRate: config.bitRate,
      maxFps: config.maxFps,
      videoCodec: config.codec,
      displayId: config.displayId || 0,
      // 打开自动同步：设备端复制后剪贴板能回传到 PC
      clipboardAutosync: true,
      stayAwake: true,
      tunnelForward: true,
    })
    const scid = makeScid(this.deviceId)
    options.value.scid = scid

    const reverse = await main.reverseWebCast(
      this.deviceId,
      `localabstract:scrcpy_${scid.padStart(8, '0')}`
    )
    if (!reverse.ok) throw new Error(reverse.error || 'adb forward 失败')
    if (this.disposed) return

    const started = await main.startWebCast(this.deviceId, options.serialize())
    if (!started.ok) throw new Error(started.error || '启动投屏服务失败')

    // 轮询 abstract socket：比盲等 1 秒再连更稳（老设备起得慢）
    const ready = await main.waitWebCast(this.deviceId, scid)
    if (!ready.ok) throw new Error('设备端服务启动超时')

    this.video = await this.openVideo(reverse.port)
    if (this.disposed) return

    this.ctl = await this.openControl(reverse.port)
    if (this.ctl) {
      this.control.attach(this.ctl.id)
      this.readControlMessages(this.ctl.stream)
    }

    await this.attachVideo(options, this.video.stream)
  }

  private async openVideo(port: number) {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < VIDEO_ATTEMPTS; attempt++) {
      try {
        return await SocketStream.open(port, { waitFirstByte: true })
      } catch (e: any) {
        lastError = e instanceof Error ? e : new Error(String(e))
        await sleep(RETRY_DELAY)
      }
    }

    throw lastError || new Error('连接视频流失败')
  }

  private async openControl(port: number) {
    for (let attempt = 0; attempt < CONTROL_ATTEMPTS; attempt++) {
      try {
        return await SocketStream.open(port)
      } catch {
        await sleep(RETRY_DELAY)
      }
    }
    // 控制通道拿不到不影响看画面：返回 null，界面只读
    return null
  }

  private async attachVideo(
    options: ScrcpyOptions3_1,
    raw: any
  ) {
    const { stream, metadata } = await options.parseVideoStreamMetadata(
      stripCompatByte(raw) as any
    )

    if (
      metadata.codec !== ScrcpyVideoCodecId.H264 &&
      metadata.codec !== ScrcpyVideoCodecId.H265
    ) {
      throw new Error(`不支持的编码：${metadata.codec}`)
    }

    this.deviceSize = {
      width: metadata.width || 1280,
      height: metadata.height || 720,
    }
    this.hooks.onSize(this.deviceSize.width, this.deviceSize.height)

    if (metadata.width && metadata.height) {
      main.resizeWebCast(this.deviceId, metadata.width, metadata.height)
    }

    const renderer = new InsertableStreamVideoFrameRenderer()
    const decoder = new WebCodecsVideoDecoder({
      codec: metadata.codec,
      renderer,
    })
    this.decoder = decoder

    const element = renderer.element as HTMLVideoElement
    this.videoElement = element
    this.hooks.onVideo(element, this.deviceSize.width, this.deviceSize.height)

    // 首帧真正解出来才撤 loading：pipeTo 开始就撤的话用户看到的是黑屏，
    // 副屏没信号时更是永远黑屏且没有提示
    const markLive = () => {
      if (this.disposed) return

      if (this.firstFrameTimer) {
        clearTimeout(this.firstFrameTimer)
        this.firstFrameTimer = null
      }
      this.setState('live')
    }

    const withFrameCallback = element as any
    if (typeof withFrameCallback.requestVideoFrameCallback === 'function') {
      withFrameCallback.requestVideoFrameCallback(markLive)
    } else {
      element.addEventListener('loadeddata', markLive, { once: true })
    }

    this.firstFrameTimer = setTimeout(() => {
      if (this.disposed) return

      this.setState('live')
      this.hooks.onToast('该信号源暂无画面输出')
    }, FIRST_FRAME_TIMEOUT)

    stream
      .pipeThrough(options.createMediaStreamTransformer())
      .pipeTo(decoder.writable)
      .then(() => {
        if (!this.disposed) this.fail('视频流已结束')
      })
      .catch((e: Error) => {
        if (!this.disposed) this.fail(e?.message || '解码中断')
      })
  }

  private fail(detail: string) {
    if (this.disposed) return

    if (this.firstFrameTimer) {
      clearTimeout(this.firstFrameTimer)
      this.firstFrameTimer = null
    }
    this.setState('failed', detail)
  }

  /** 控制信道的回传消息：剪贴板同步 + ACK。 */
  private async readControlMessages(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    let buffer: Uint8Array = new Uint8Array(0)

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || this.disposed) return

        if (value?.length) {
          const merged = new Uint8Array(buffer.length + value.length)
          merged.set(buffer, 0)
          merged.set(value, buffer.length)
          buffer = merged
        }

        for (;;) {
          const decoded = decodeIncoming(buffer)
          if (!decoded) break

          buffer = decoded.rest
          if (decoded.message.type === 'clipboard') {
            this.control.receiveDeviceClipboard(decoded.message.text)
          }
        }
      }
    } catch {
      // 连接断开由视频流那侧统一处理
    }
  }

  /** 停止 socket/解码器，保留控制通道对象（重连时复用）。 */
  async stopTransport() {
    this.control.detach()

    if (this.firstFrameTimer) {
      clearTimeout(this.firstFrameTimer)
      this.firstFrameTimer = null
    }

    try {
      this.decoder?.dispose()
    } catch {
      // ignore
    }
    this.decoder = null
    this.videoElement = null

    try {
      this.video?.close()
      this.ctl?.close()
    } catch {
      // ignore
    }
    this.video = null
    this.ctl = null

    try {
      await main.stopWebCast(this.deviceId)
    } catch {
      // 设备可能已经离线
    }
  }

  /**
   * 只清本地资源（socket/解码器/定时器），不碰设备端 server。
   * 重连时由新会话的 start() 负责停旧 server——否则旧会话的异步清理可能
   * 在新会话启动之后才执行，把刚起来的那一路踢掉。
   */
  disposeLocal() {
    this.disposed = true
    this.control.detach()

    if (this.firstFrameTimer) {
      clearTimeout(this.firstFrameTimer)
      this.firstFrameTimer = null
    }

    try {
      this.decoder?.dispose()
    } catch {
      // ignore
    }
    this.decoder = null
    this.videoElement = null

    try {
      this.video?.close()
      this.ctl?.close()
    } catch {
      // ignore
    }
    this.video = null
    this.ctl = null
  }

  async stop() {
    this.disposeLocal()
    try {
      await main.stopWebCast(this.deviceId)
    } catch {
      // 设备可能已经离线
    }
    this.setState('idle')
  }
}

export { AndroidKeyCode }
