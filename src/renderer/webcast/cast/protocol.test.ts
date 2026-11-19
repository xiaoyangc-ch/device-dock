import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeIncoming,
  encodeClipboard,
  encodeCommand,
  encodeKeyCode,
  encodeScreenPower,
  encodeScroll,
  encodeText,
  encodeTouch,
  KeyAction,
  MOUSE_POINTER,
  Outgoing,
  TouchAction,
} from './protocol'

function view(buf: Uint8Array) {
  return new DataView(buf.buffer, buf.byteOffset)
}

test('按键：14 字节，action/keycode/repeat/metaState 各就各位', () => {
  const buf = encodeKeyCode(KeyAction.Down, 66, 0x1000, 2)

  assert.equal(buf.length, 14)
  assert.equal(buf[0], Outgoing.KeyCode)
  assert.equal(buf[1], KeyAction.Down)
  assert.equal(view(buf).getUint32(2), 66)
  assert.equal(view(buf).getUint32(6), 2)
  assert.equal(view(buf).getUint32(10), 0x1000)
})

test('文本：长度是 UTF-8 字节数而不是字符数', () => {
  const buf = encodeText('abc')
  assert.equal(buf.length, 5 + 3)
  assert.equal(buf[0], Outgoing.Text)
  assert.equal(view(buf).getUint32(1), 3)
  assert.equal(new TextDecoder().decode(buf.subarray(5)), 'abc')
})

test('触摸：鼠标指针用 -1，多指用正数 id', () => {
  const mouse = encodeTouch(TouchAction.Down, 10, 20, 1920, 1080)

  assert.equal(mouse.length, 32)
  assert.equal(mouse[0], Outgoing.Touch)
  assert.equal(view(mouse).getBigInt64(2), BigInt(MOUSE_POINTER))
  assert.equal(view(mouse).getInt32(10), 10)
  assert.equal(view(mouse).getInt32(14), 20)
  assert.equal(view(mouse).getUint16(18), 1920)
  assert.equal(view(mouse).getUint16(20), 1080)

  const finger = encodeTouch(TouchAction.PointerDown, 1, 2, 100, 200, 5)
  assert.equal(view(finger).getBigInt64(2), BigInt(5))
})

test('触摸压力：按下/移动给满压、抬起给 0（与 scrcpy 一致）', () => {
  assert.equal(
    view(encodeTouch(TouchAction.Down, 0, 0, 1, 1)).getUint16(22),
    65535
  )
  assert.equal(view(encodeTouch(TouchAction.Up, 0, 0, 1, 1)).getUint16(22), 0)
  assert.equal(
    view(encodeTouch(TouchAction.PointerUp, 0, 0, 1, 1)).getUint16(22),
    0
  )
  assert.equal(
    view(encodeTouch(TouchAction.Move, 0, 0, 1, 1)).getUint16(22),
    65535
  )
})

test('滚动：±1 截断，1 走 0x7fff 避免溢出', () => {
  const buf = encodeScroll(0, 0, 1080, 1920, 2, -2)

  assert.equal(buf.length, 21)
  assert.equal(view(buf).getInt16(13), 0x7fff)
  assert.equal(view(buf).getInt16(15), -32768)

  const half = encodeScroll(0, 0, 1080, 1920, 0.5, 0)
  assert.equal(view(half).getInt16(13), 16384)
})

test('剪贴板：序列号 + paste 标志 + 长度 + 正文', () => {
  const buf = encodeClipboard('粘贴', true)

  assert.equal(buf[0], Outgoing.SetClipboard)
  assert.equal(buf[9], 1)
  assert.equal(view(buf).getUint32(10), 6)
  assert.equal(new TextDecoder().decode(buf.subarray(14)), '粘贴')
  assert.equal(buf.length, 14 + 6)
})

test('电源/命令是单字节', () => {
  assert.deepEqual([...encodeScreenPower(2)], [Outgoing.ScreenPower, 2])
  assert.deepEqual([...encodeCommand(11)], [Outgoing.RotateDevice])
})

function clipboardFrame(text: string) {
  const bytes = new TextEncoder().encode(text)
  const buf = new Uint8Array(5 + bytes.length)
  const dv = new DataView(buf.buffer)
  buf[0] = 0
  dv.setUint32(1, bytes.length)
  buf.set(bytes, 5)
  return buf
}

test('剪贴板消息解析出文本，剩余字节原样返回', () => {
  const frame = new Uint8Array([...clipboardFrame('你好'), 0xff])
  const decoded = decodeIncoming(frame)

  assert.equal(decoded.kind, 'message')
  assert.deepEqual(decoded.kind === 'message' ? decoded.message : null, {
    type: 'clipboard',
    text: '你好',
  })
  assert.deepEqual([...decoded.rest], [0xff])
})

test('半包返回 incomplete（等下一片数据）', () => {
  const frame = clipboardFrame('hello')

  assert.equal(decodeIncoming(frame.slice(0, 3)).kind, 'incomplete')
  assert.equal(decodeIncoming(frame.slice(0, 6)).kind, 'incomplete')
})

test('ACK 是 9 字节：不足返回 incomplete，够了就切掉', () => {
  const ack = new Uint8Array(9)
  ack[0] = 1

  assert.equal(decodeIncoming(ack.slice(0, 8)).kind, 'incomplete')

  const decoded = decodeIncoming(new Uint8Array([...ack, 0x42]))
  assert.equal(decoded.kind, 'message')
  assert.deepEqual(decoded.kind === 'message' ? decoded.message : null, {
    type: 'ack',
  })
  assert.deepEqual([...decoded.rest], [0x42])
})

test('未知类型消费一个字节，后续合法消息仍可解析', () => {
  const ack = new Uint8Array(9)
  ack[0] = 1
  const decoded = decodeIncoming(new Uint8Array([99, ...ack]))
  assert.equal(decoded.kind, 'unknown')
  assert.deepEqual([...decoded.rest], [...ack])

  const next = decodeIncoming(decoded.rest)
  assert.equal(next.kind, 'message')
})

test('异常超长剪贴板只消费类型字节，不让读取循环永久等待', () => {
  const frame = new Uint8Array(5)
  frame[0] = 0
  new DataView(frame.buffer).setUint32(1, 2 * 1024 * 1024)
  const decoded = decodeIncoming(frame)
  assert.equal(decoded.kind, 'unknown')
  assert.equal(decoded.rest.length, 4)
})
