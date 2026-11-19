/**
 * scrcpy 控制信道的二进制打包。
 *
 * 字节布局来自 scrcpy 的公开协议文档，设备端 server 按它解析；
 * 这里自己实现编码，不引用任何上游代码。
 */

/** 主机 → 设备 的控制消息类型 */
export const Outgoing = {
  KeyCode: 0,
  Text: 1,
  Touch: 2,
  Scroll: 3,
  BackOrScreenOn: 4,
  ExpandNotification: 5,
  ExpandSettings: 6,
  CollapsePanels: 7,
  GetClipboard: 8,
  SetClipboard: 9,
  ScreenPower: 10,
  RotateDevice: 11,
} as const

/** 设备 → 主机 的消息类型 */
export const Incoming = {
  Clipboard: 0,
  AckClipboard: 1,
} as const

export const TouchAction = {
  Down: 0,
  Up: 1,
  Move: 2,
  PointerDown: 5,
  PointerUp: 6,
} as const

export const KeyAction = {
  Down: 0,
  Up: 1,
} as const

/** 主机指针用 -1 表示鼠标/主手指，其余从 1 开始分配。 */
export const MOUSE_POINTER = -1

/** INJECT_KEYCODE：type + action + keycode + repeat + metaState */
export function encodeKeyCode(
  action: number,
  keyCode: number,
  metaState = 0,
  repeat = 0
) {
  const buf = new Uint8Array(14)
  const view = new DataView(buf.buffer)
  buf[0] = Outgoing.KeyCode
  buf[1] = action
  view.setUint32(2, keyCode)
  view.setUint32(6, repeat)
  view.setUint32(10, metaState)
  return buf
}

/** INJECT_TEXT：type + 长度 + UTF-8（scrcpy 只接受 ASCII，非 ASCII 走剪贴板） */
export function encodeText(text: string) {
  const bytes = new TextEncoder().encode(text)
  const buf = new Uint8Array(5 + bytes.length)
  const view = new DataView(buf.buffer)
  buf[0] = Outgoing.Text
  view.setUint32(1, bytes.length)
  buf.set(bytes, 5)
  return buf
}

/** INJECT_TOUCH：type + action + pointerId + x + y + w + h + pressure + actionButton + buttons */
export function encodeTouch(
  action: number,
  x: number,
  y: number,
  width: number,
  height: number,
  pointerId = MOUSE_POINTER
) {
  const buf = new Uint8Array(32)
  const view = new DataView(buf.buffer)
  buf[0] = Outgoing.Touch
  buf[1] = action
  view.setBigInt64(2, BigInt(pointerId))
  view.setInt32(10, x)
  view.setInt32(14, y)
  view.setUint16(18, width)
  view.setUint16(20, height)
  // scrcpy 的语义：抬起给 0，按下/移动给满压（up ? 0.0f : 1.0f）。
  // 写反会让读 getPressure() 的绘图/手写/游戏类应用丢笔或认为没有真实按压
  view.setUint16(
    22,
    action === TouchAction.Up || action === TouchAction.PointerUp ? 0 : 65535
  )
  view.setUint32(24, 0)
  view.setUint32(28, 0)
  return buf
}

/** INJECT_SCROLL：16 位定点的滚动量，范围 [-1, 1] */
export function encodeScroll(
  x: number,
  y: number,
  width: number,
  height: number,
  scrollX: number,
  scrollY: number
) {
  const toFixed = (value: number) => {
    const clamped = Math.max(-1, Math.min(1, value))
    return clamped === 1 ? 0x7fff : Math.round(clamped * 0x8000)
  }

  const buf = new Uint8Array(21)
  const view = new DataView(buf.buffer)
  buf[0] = Outgoing.Scroll
  view.setUint32(1, x)
  view.setUint32(5, y)
  view.setUint16(9, width)
  view.setUint16(11, height)
  view.setInt16(13, toFixed(scrollX))
  view.setInt16(15, toFixed(scrollY))
  view.setUint32(17, 0)
  return buf
}

/** SET_CLIPBOARD：type + 序列号 + paste 标志 + 长度 + UTF-8 */
export function encodeClipboard(text: string, paste: boolean) {
  const bytes = new TextEncoder().encode(text)
  const buf = new Uint8Array(14 + bytes.length)
  const view = new DataView(buf.buffer)
  buf[0] = Outgoing.SetClipboard
  view.setBigUint64(1, BigInt(Date.now()))
  buf[9] = paste ? 1 : 0
  view.setUint32(10, bytes.length)
  buf.set(bytes, 14)
  return buf
}

/** SET_SCREEN_POWER_MODE：normal(0) / off(2) */
export function encodeScreenPower(mode: number) {
  return new Uint8Array([Outgoing.ScreenPower, mode])
}

/** 无参数消息（rotate / 通知面板 / 收起面板等） */
export function encodeCommand(type: number) {
  return new Uint8Array([type])
}

/**
 * 从控制信道里切出一条完整消息。
 * 半包必须等待后续数据；未知类型则消费一个字节重新同步。
 */
export type DecodedIncoming =
  | {
      kind: 'message'
      message: { type: 'clipboard'; text: string } | { type: 'ack' }
      rest: Uint8Array
    }
  | { kind: 'incomplete' }
  | { kind: 'unknown'; rest: Uint8Array }

export function decodeIncoming(buffer: Uint8Array): DecodedIncoming {
  if (buffer.length < 1) return { kind: 'incomplete' }

  const type = buffer[0]

  if (type === Incoming.Clipboard) {
    if (buffer.length < 5) return { kind: 'incomplete' }

    const view = new DataView(buffer.buffer, buffer.byteOffset)
    const length = view.getUint32(1)
    if (length > 1024 * 1024) {
      return { kind: 'unknown', rest: buffer.slice(1) }
    }
    if (buffer.length < 5 + length) return { kind: 'incomplete' }

    const text = new TextDecoder().decode(buffer.subarray(5, 5 + length))
    return {
      kind: 'message',
      message: { type: 'clipboard', text },
      rest: buffer.slice(5 + length),
    }
  }

  if (type === Incoming.AckClipboard) {
    if (buffer.length < 9) return { kind: 'incomplete' }

    return {
      kind: 'message',
      message: { type: 'ack' },
      rest: buffer.slice(9),
    }
  }

  // 未知类型只消费类型字节，后续可能还有可以识别的新消息。
  return { kind: 'unknown', rest: buffer.slice(1) }
}
