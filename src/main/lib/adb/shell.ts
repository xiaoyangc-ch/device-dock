/**
 * 交互式终端：直接走 adb transport 的 shell v2 协议（多标签、可 resize）。
 *
 * 不用 adbkit 的 shell()：它按行返回，拿不到 stderr、也没有窗口尺寸。
 * v2 协议包格式：1 字节 id + 4 字节小端长度 + payload；
 * 老设备不支持 v2 时退回 v1（纯字节流，没有 resize）。
 */
import Emitter from 'licia/Emitter'
import uniqId from 'licia/uniqId'
import { StringDecoder } from 'string_decoder'
import { Client } from '@devicefarmer/adbkit'
import * as window from 'share/main/lib/window'
import { handleEvent } from 'share/main/lib/util'
import {
  IpcCreateShell,
  IpcKillShell,
  IpcResizeShell,
  IpcWriteShell,
} from 'common/types'

let client: Client

// shell v2 的包类型
const STDIN = 0
const STDOUT = 1
const STDERR = 2
const EXIT = 3
const WINDOW_SIZE_CHANGE = 5

// adbd 不会发 4MB 的包：超过说明包头已经错位，丢掉避免 readUInt32LE 越界
const MAX_PACKET = 4 * 1024 * 1024
const ADB_OKAY = 'OKAY'

/** adb 传输层：4 位十六进制长度 + payload。 */
function encodeAdbPayload(data: Buffer): Buffer {
  const header = data.length.toString(16).padStart(4, '0').toUpperCase()
  return Buffer.concat([Buffer.from(header), data])
}

/** shell v2：1 字节类型 + 4 字节小端长度 + payload。 */
function encodeShellPacket(id: number, payload: Buffer): Buffer {
  const buf = Buffer.alloc(5 + payload.length)
  buf.writeUInt8(id, 0)
  buf.writeUInt32LE(payload.length, 1)
  payload.copy(buf, 5)
  return buf
}

class AdbPty extends Emitter {
  private connection: any
  private useV2 = true
  // 一次 socket.read() 可能只拿到半个包，也可能拿到好几个：
  // 残留字节必须留在缓冲区，否则下一轮 readUInt32LE 会越界把主进程搞崩
  private residual: Buffer = Buffer.alloc(0)
  private decoder = new StringDecoder('utf8')
  private closed = false

  constructor(connection: any) {
    super()
    this.connection = connection
  }

  isClosed() {
    return this.closed
  }

  async init(useV2 = true) {
    const { connection } = this
    this.useV2 = useV2

    connection.write(
      encodeAdbPayload(Buffer.from(useV2 ? 'shell,v2:' : 'shell:'))
    )
    const result = await connection.parser.readAscii(4)
    if (result !== ADB_OKAY) throw new Error('Failed to create shell')

    const { socket } = connection
    socket.on('readable', () => {
      let chunk: Buffer | null
      while ((chunk = socket.read()) !== null) {
        if (!chunk.length) continue
        if (useV2) {
          this.readFrames(chunk)
        } else {
          this.emit('data', this.decoder.write(chunk))
        }
      }
    })

    // 设备端 shell 退出/隧道断开：收尾并通知渲染层，否则标签页停在「已连接」
    socket.on('error', () => this.destroy())
    socket.on('close', () => this.destroy())
  }

  /** 从字节流里拆 v2 包；STDOUT/STDERR 都转发（报错在 stderr）。 */
  private readFrames(chunk: Buffer) {
    let buf = this.residual.length
      ? Buffer.concat([this.residual, chunk])
      : chunk

    while (buf.length >= 5) {
      const id = buf.readUInt8(0)
      const size = buf.readUInt32LE(1)
      if (size > MAX_PACKET) {
        // 包头已错位：清空，等下一次连接重建
        buf = Buffer.alloc(0)
        break
      }
      if (buf.length < 5 + size) break

      const payload = buf.subarray(5, 5 + size)
      buf = buf.subarray(5 + size)

      if (id === STDOUT || id === STDERR) {
        // 增量解码：一个汉字被 TCP 切两半时不能分别解码，否则出 U+FFFD
        this.emit('data', this.decoder.write(payload))
      } else if (id === EXIT) {
        // 设备端命令退出：先交给上层，socket 关闭后 destroy 会再来一次（幂等）
        this.destroy()
      }
    }
    this.residual = buf
  }

  resize(cols: number, rows: number) {
    if (this.closed || !this.useV2) return
    this.connection.socket.write(
      encodeShellPacket(
        WINDOW_SIZE_CHANGE,
        Buffer.from(`${rows}x${cols},0x0\0`)
      )
    )
  }

  write(data: string) {
    if (this.closed) return
    if (this.useV2) {
      this.connection.socket.write(
        encodeShellPacket(STDIN, Buffer.from(data))
      )
    } else {
      this.connection.socket.write(Buffer.from(data))
    }
  }

  private destroy() {
    if (this.closed) return
    this.closed = true

    const rest = this.decoder.end()
    if (rest) this.emit('data', rest)

    try {
      this.connection.socket?.removeAllListeners('readable')
      this.connection.end()
    } catch {
      // 已经断了
    }
    this.emit('close')
  }

  kill() {
    this.destroy()
  }
}

const ptys = new Map<string, AdbPty>()

const createShell: IpcCreateShell = async (deviceId) => {
  const device = await client.getDevice(deviceId)

  let transport = await device.transport()
  let pty = new AdbPty(transport)
  try {
    await pty.init(true)
  } catch {
    // 老 adbd 不认 shell,v2：换一条 transport 重试 v1
    pty.kill()
    transport = await device.transport()
    pty = new AdbPty(transport)
    await pty.init(false)
  }

  // init 期间设备断开时 socket 已关，但 init 可能刚好 resolve：
  // 这种 pty 存进去就是永远写不进去的死会话
  if (pty.isClosed()) {
    pty.kill()
    throw new Error('设备连接在创建终端时断开')
  }

  const sessionId = uniqId('shell')
  pty.on('data', (data) => {
    window.sendTo('main', 'shellData', sessionId, data)
  })
  pty.on('close', () => {
    ptys.delete(sessionId)
    window.sendTo('main', 'shellClosed', sessionId)
  })
  ptys.set(sessionId, pty)

  return sessionId
}

const writeShell: IpcWriteShell = async (sessionId, data) => {
  ptys.get(sessionId)?.write(data)
}

const resizeShell: IpcResizeShell = async (sessionId, cols, rows) => {
  ptys.get(sessionId)?.resize(cols, rows)
}

const killShell: IpcKillShell = async (sessionId) => {
  const pty = ptys.get(sessionId)
  if (!pty) return
  ptys.delete(sessionId)
  pty.kill()
}

export function init(c: Client) {
  client = c

  handleEvent('createShell', createShell)
  handleEvent('writeShell', writeShell)
  handleEvent('resizeShell', resizeShell)
  handleEvent('killShell', killShell)
}
