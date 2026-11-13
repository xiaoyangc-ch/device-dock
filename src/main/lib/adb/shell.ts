import types from 'licia/types'
import Emitter from 'licia/Emitter'
import uniqId from 'licia/uniqId'
import * as window from 'share/main/lib/window'
import { Client } from '@devicefarmer/adbkit'
import { handleEvent } from 'share/main/lib/util'
import { StringDecoder } from 'string_decoder'
import {
  IpcCreateShell,
  IpcKillShell,
  IpcResizeShell,
  IpcWriteShell,
} from 'common/types'

let client: Client

class ShellProtocol {
  static STDIN = 0
  static STDOUT = 1
  static STDERR = 2
  static EXIT = 3
  static CLOSE_STDIN = 4
  static WINDOW_SIZE_CHANGE = 5

  // 单个包最大 4MB：adbd 不会发这么大的包，超过说明包头已经错位
  static MAX_PACKET = 4 * 1024 * 1024

  static encodeData(id, data) {
    data = Buffer.from(data, 'utf8')
    const buf = Buffer.alloc(5 + data.length)
    buf.writeUInt8(id, 0)
    buf.writeUInt32LE(data.length, 1)
    data.copy(buf, 5)

    return buf
  }
}

class Protocol {
  static OKAY = 'OKAY'

  static encodeLength(length) {
    return length.toString(16).padStart(4, '0').toUpperCase()
  }

  static encodeData(data) {
    const len = Protocol.encodeLength(data.length)
    return Buffer.concat([Buffer.from(len), data])
  }
}

class AdbPty extends Emitter {
  private connection: any
  private useV2 = true
  // 一次 socket.read() 可能只拿到半个包，也可能一次拿到好几个包：
  // 残留字节必须留在缓冲区里，否则 readUInt32LE 会越界抛错（主进程直接崩）
  private residual: Buffer = Buffer.alloc(0)
  private decoder = new StringDecoder('utf8')
  private closed = false

  isClosed() {
    return this.closed
  }

  constructor(connection: any) {
    super()

    this.connection = connection
  }
  async init(useV2 = true) {
    const { connection } = this

    this.useV2 = useV2
    const protocol = useV2 ? 'shell,v2:' : 'shell:'
    connection.write(Protocol.encodeData(Buffer.from(protocol)))
    const result = await connection.parser.readAscii(4)
    if (result !== Protocol.OKAY) {
      throw new Error('Failed to create shell')
    }

    const { socket } = connection
    socket.on('readable', () => {
      let chunk: Buffer | null
      while ((chunk = socket.read()) !== null) {
        if (!chunk.length) continue
        if (useV2) {
          this.onProtocolData(chunk)
        } else {
          this.emit('data', this.decoder.write(chunk))
        }
      }
    })
    // 设备端 shell 退出/隧道断开时要收尾并通知渲染层，否则标签页会一直停在“已连接”
    socket.on('error', () => this.destroy())
    socket.on('close', () => this.destroy())
  }
  private onProtocolData(chunk: Buffer) {
    let buf = this.residual.length
      ? Buffer.concat([this.residual, chunk])
      : chunk

    while (buf.length >= 5) {
      const id = buf.readUInt8(0)
      const size = buf.readUInt32LE(1)
      if (size > ShellProtocol.MAX_PACKET) {
        buf = Buffer.alloc(0)
        break
      }
      if (buf.length < 5 + size) break
      const data = buf.subarray(5, 5 + size)
      buf = buf.subarray(5 + size)
      // STDERR 也要显示：命令不存在/权限不足的报错都在 stderr，
      // 原来只收 stdout，终端里看起来像「命令没有任何反应」
      if (id === ShellProtocol.STDOUT || id === ShellProtocol.STDERR) {
        // 增量解码：一个中文字符被 TCP 切成两个包时不能各自解码，否则出 U+FFFD
        this.emit('data', this.decoder.write(data))
      }
    }
    this.residual = buf
  }
  resize(cols: number, rows: number) {
    if (this.closed || !this.useV2) return
    this.connection.socket.write(
      ShellProtocol.encodeData(
        ShellProtocol.WINDOW_SIZE_CHANGE,
        Buffer.from(`${rows}x${cols},0x0\0`)
      )
    )
  }
  write(data: string) {
    if (this.closed) return
    if (this.useV2) {
      this.connection.socket.write(
        ShellProtocol.encodeData(ShellProtocol.STDIN, Buffer.from(data))
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
      // ignore
    }
    this.emit('close')
  }
  kill() {
    this.destroy()
  }
}

const ptys: types.PlainObj<AdbPty> = {}

const createShell: IpcCreateShell = async function (deviceId) {
  const device = await client.getDevice(deviceId)

  const transport = await device.transport()
  let adbPty = new AdbPty(transport)
  try {
    await adbPty.init()
  } catch {
    adbPty.kill()
    const transport = await device.transport()
    adbPty = new AdbPty(transport)
    await adbPty.init(false)
  }
  // init 期间设备断开时 socket 已经关了，但 init 可能刚好 resolve：
  // 这种 pty 存进 ptys 就是一个永远写不进去的死会话
  if (adbPty.isClosed()) {
    adbPty.kill()
    throw new Error('设备连接在创建终端时断开')
  }
  const sessionId = uniqId('shell')
  adbPty.on('data', (data) => {
    window.sendTo('main', 'shellData', sessionId, data)
  })
  adbPty.on('close', () => {
    delete ptys[sessionId]
    window.sendTo('main', 'shellClosed', sessionId)
  })
  ptys[sessionId] = adbPty

  return sessionId
}

const writeShell: IpcWriteShell = async function (sessionId, data) {
  const pty = ptys[sessionId]
  if (pty) pty.write(data)
}

const resizeShell: IpcResizeShell = async function (sessionId, cols, rows) {
  const pty = ptys[sessionId]
  if (pty) pty.resize(cols, rows)
}

const killShell: IpcKillShell = async function (sessionId) {
  const pty = ptys[sessionId]
  if (!pty) return
  delete ptys[sessionId]
  pty.kill()
}

export function init(c: Client) {
  client = c

  handleEvent('createShell', createShell)
  handleEvent('writeShell', writeShell)
  handleEvent('resizeShell', resizeShell)
  handleEvent('killShell', killShell)
}
