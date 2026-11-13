import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { adbPacket, probeAdbPort, scanPortsOf } from './portScan'

const A_CNXN = 0x4e584e43

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port)
    })
  })
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

// 假 adb 设备：收到 CNXN 就回一个 CNXN 头
async function fakeAdbDevice() {
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.once('data', () => {
      const header = Buffer.alloc(24)
      header.writeUInt32LE(A_CNXN, 0)
      header.writeUInt32LE(0x01000000, 4)
      header.writeUInt32LE(256 * 1024, 8)
      header.writeUInt32LE(0, 12)
      header.writeUInt32LE(0, 16)
      header.writeUInt32LE((A_CNXN ^ 0xffffffff) >>> 0, 20)
      socket.write(header)
    })
  })
  const port = await listen(server)
  return { server, port }
}

test('adb CNXN 包：长度、命令字、magic 与 payload 一致', () => {
  const payload = Buffer.from('host::\0')
  const packet = adbPacket(A_CNXN, 0x01000000, 256 * 1024, payload)

  assert.equal(packet.length, 24 + payload.length)
  assert.equal(packet.readUInt32LE(0), A_CNXN)
  assert.equal(packet.readUInt32LE(4), 0x01000000)
  assert.equal(packet.readUInt32LE(12), payload.length)
  assert.equal(packet.readUInt32LE(20), (A_CNXN ^ 0xffffffff) >>> 0)
})

test('回 CNXN 的端口判定为 ADB', async () => {
  const { server, port } = await fakeAdbDevice()
  try {
    assert.equal(await probeAdbPort('127.0.0.1', port, 1000), true)
  } finally {
    await closeServer(server)
  }
})

test('只连不应的端口不误判为 ADB', async () => {
  // 普通服务：接受连接但不说 adb 协议
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.on('data', () => {})
  })
  const port = await listen(server)
  try {
    assert.equal(await probeAdbPort('127.0.0.1', port, 300), false)
  } finally {
    await closeServer(server)
  }
})

test('关闭的端口不误判为 ADB', async () => {
  const server = net.createServer()
  const port = await listen(server)
  await closeServer(server)
  assert.equal(await probeAdbPort('127.0.0.1', port, 300), false)
})

test('端口扫描能区分开放与关闭端口', async () => {
  const open = net.createServer((socket) => socket.on('error', () => {}))
  const openPort = await listen(open)

  const closed = net.createServer()
  const closedPort = await listen(closed)
  await closeServer(closed)

  try {
    const { openPorts, scanned } = await scanPortsOf(
      '127.0.0.1',
      [openPort, closedPort],
      { timeout: 300 }
    )
    assert.ok(openPorts.includes(openPort))
    assert.ok(!openPorts.includes(closedPort))
    assert.equal(scanned, 2)
  } finally {
    await closeServer(open)
  }
})
