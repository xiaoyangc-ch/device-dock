/**
 * 投屏录制：把 video 每帧画到 canvas，MediaRecorder 出 webm 分片，
 * 分片按序写进主进程的临时文件，停止后再封装成完整 webm。
 *
 * 分片必须串行落盘并在 stop 前等写完：否则最后一包可能在会话删掉之后才到，
 * 文件会缺 Duration/Cues，播放器打不开。
 */
export interface RecorderHooks {
  onState: (recording: boolean) => void
  onToast: (message: string) => void
}

const FRAME_RATE = 30

function pickMimeType() {
  return MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm'
}

export class ScreenRecorder {
  private recorder: MediaRecorder | null = null
  private rafId = 0
  private starting = false
  private sessionId = ''

  constructor(
    private readonly deviceId: string,
    private readonly getVideo: () => HTMLVideoElement | null,
    private readonly hooks: RecorderHooks
  ) {}

  get active() {
    return !!this.recorder
  }

  async start() {
    if (this.recorder || this.starting) return

    const video = this.getVideo()
    if (!video) return

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 1280
    canvas.height = video.videoHeight || 720

    const context = canvas.getContext('2d')
    if (!context) return

    let stopped = false
    const paint = () => {
      if (stopped) return

      // 重连/换信号源后 video 元素会被替换：每帧重新取，别录死在旧画面上
      const current = this.getVideo()
      if (current?.videoWidth) {
        context.drawImage(current, 0, 0, canvas.width, canvas.height)
      }
      this.rafId = requestAnimationFrame(paint)
    }
    paint()

    const stream = canvas.captureStream(FRAME_RATE)
    const recorder = new MediaRecorder(stream, { mimeType: pickMimeType() })

    // 分片串行写：并行 IPC 会乱序，webm 头部时间戳就乱了
    let writeChain: Promise<unknown> = Promise.resolve()

    recorder.ondataavailable = (e) => {
      if (!e.data.size || !this.sessionId) return

      const id = this.sessionId
      writeChain = writeChain
        .then(() => e.data.arrayBuffer())
        .then((buffer) => main.recordingChunk(id, new Uint8Array(buffer)))
        .catch(() => undefined)
    }

    recorder.onstop = async () => {
      stopped = true
      if (this.recorder === recorder) this.recorder = null
      this.stopPaint()

      try {
        await writeChain
      } catch {
        // 写盘失败也继续收尾，至少能拿到已写部分
      }

      let saved = ''
      try {
        const result = await main.recordingStop(this.sessionId)
        saved = result.path
      } catch {
        // ignore
      }
      this.sessionId = ''

      this.hooks.onState(false)
      this.hooks.onToast(saved ? `录制已保存：${saved}` : '录制已停止')
    }

    this.starting = true
    try {
      const result = await main.recordingStart(this.deviceId)
      this.sessionId = result.id
      recorder.start(1000)
      this.recorder = recorder
      this.hooks.onState(true)
      this.hooks.onToast('开始录制')
    } catch {
      stopped = true
      this.stopPaint()
      // recordingStart 已建文件句柄：rec.start 抛错时必须收掉，否则临时文件一直挂着
      if (this.sessionId) {
        main.recordingStop(this.sessionId).catch(() => undefined)
        this.sessionId = ''
      }
      this.hooks.onState(false)
      this.hooks.onToast('录制启动失败')
    } finally {
      this.starting = false
    }
  }

  stop() {
    this.recorder?.stop()
    this.recorder = null
  }

  /** 窗口销毁时兜底：不带提示，避免在已卸载的界面里 setState。 */
  dispose() {
    this.stopPaint()
    try {
      this.recorder?.stop()
    } catch {
      // ignore
    }
    this.recorder = null
  }

  private stopPaint() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
  }
}
