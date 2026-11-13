/**
 * 控制通道：一行 socket 连接，负责把按键/触摸/滚动/文本/剪贴板打包后写出去。
 *
 * 连接还没就绪时按下的粘贴会排队，通道 attach 后自动补发——
 * 否则用户得按两次 Ctrl+V。
 */
import * as proto from './protocol'

type StreamWriter = (id: number, data: Uint8Array) => void

export class ControlChannel {
  private socketId = 0
  private queuedPaste = ''
  private echoGuard = { text: '', at: 0 }

  constructor(
    private readonly write: StreamWriter,
    private readonly onClipboard: (text: string) => void,
    private readonly onToast: (message: string) => void
  ) {}

  get ready() {
    return this.socketId > 0
  }

  /** 绑定 socket；有排队的粘贴就立刻补发。 */
  attach(socketId: number) {
    this.socketId = socketId

    if (this.queuedPaste) {
      const text = this.queuedPaste
      this.queuedPaste = ''
      this.sendClipboard(text, true)
    }
  }

  detach() {
    this.socketId = 0
  }

  get id() {
    return this.socketId
  }

  /** 设备回传的剪贴板内容：自己刚发出去的那条要忽略，否则会把 PC 剪贴板覆盖成旧值。 */
  receiveDeviceClipboard(text: string) {
    const echo =
      text === this.echoGuard.text && Date.now() - this.echoGuard.at < 3000
    if (echo) return

    this.onClipboard(text)
  }

  key(keyCode: number, metaState = 0, repeat = 0) {
    if (!this.socketId) return

    this.write(
      this.socketId,
      proto.encodeKeyCode(proto.KeyAction.Down, keyCode, metaState, repeat)
    )
    this.write(
      this.socketId,
      proto.encodeKeyCode(proto.KeyAction.Up, keyCode, metaState, repeat)
    )
  }

  /**
   * 修饰键 + 主键：分两步发。
   * 有些 App 只认真正的 Ctrl down/up，光看 metaState 会被忽略。
   */
  chord(modifier: number, keyCode: number, metaState = 0) {
    if (!this.socketId) return

    const id = this.socketId
    this.write(id, proto.encodeKeyCode(proto.KeyAction.Down, modifier))

    setTimeout(() => {
      this.write(id, proto.encodeKeyCode(proto.KeyAction.Down, keyCode, metaState))
      this.write(id, proto.encodeKeyCode(proto.KeyAction.Up, keyCode, metaState))
      setTimeout(
        () => this.write(id, proto.encodeKeyCode(proto.KeyAction.Up, modifier)),
        20
      )
    }, 20)
  }

  text(text: string) {
    if (!this.socketId) return
    this.write(this.socketId, proto.encodeText(text))
  }

  touch(
    action: number,
    x: number,
    y: number,
    width: number,
    height: number,
    pointerId = proto.MOUSE_POINTER
  ) {
    if (!this.socketId) return

    this.write(
      this.socketId,
      proto.encodeTouch(action, x, y, width, height, pointerId)
    )
  }

  scroll(
    x: number,
    y: number,
    width: number,
    height: number,
    scrollX: number,
    scrollY: number
  ) {
    if (!this.socketId) return

    this.write(
      this.socketId,
      proto.encodeScroll(x, y, width, height, scrollX, scrollY)
    )
  }

  command(type: number) {
    if (!this.socketId) return
    this.write(this.socketId, proto.encodeCommand(type))
  }

  screenPower(mode: number) {
    if (!this.socketId) return
    this.write(this.socketId, proto.encodeScreenPower(mode))
  }

  /** 粘贴：通道没就绪时排队，就绪后再发。 */
  paste(text: string, paste = true) {
    if (!text) return

    if (!this.socketId) {
      this.queuedPaste = text
      this.onToast('连接中，稍后自动粘贴')
      return
    }

    this.sendClipboard(text, paste)
  }

  private sendClipboard(text: string, paste: boolean) {
    this.echoGuard = { text, at: Date.now() }
    this.write(this.socketId, proto.encodeClipboard(text, paste))
  }
}
