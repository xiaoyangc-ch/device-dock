import net from 'node:net'
import log from 'share/common/log'

const logger = log('portScan')

// ADB over WiFi 默认 5555；改过端口的多落在 55xx / 75xx，先扫这些让它一秒出结果，
// 扫不到再退到全端口——用户要的就是"端口不一定是默认的"这种场景。
const QUICK_RANGES: Array<[number, number]> = [
  [5550, 5600],
  [7500, 7600],
]
const DEFAULT_TIMEOUT = 200
const QUICK_CONCURRENCY = 192
const DEEP_CONCURRENCY = 1024
const ADB_PROBE_TIMEOUT = 1500

// adb 协议：24 字节小端头 + payload，magic 为 command 取反
const A_CNXN = 0x4e584e43
const A_AUTH = 0x48545541
const ADB_VERSION = 0x01000001
const ADB_MAX_DATA = 256 * 1024

export interface PortScanProgress {
  phase: 'quick' | 'deep' | 'adb'
  done: number
  total: number
}

export interface PortScanResult {
  ip: string
  adbPorts: number[]
  openPorts: number[]
  scanned: number
  cancelled: boolean
  durationMs: number
}

// 每次扫描一个 token：取消只作用于当前这一次，避免两次扫描互相把对方的中断吞掉
let activeScan: { cancelled: boolean } | null = null

export function cancelPortScan() {
  if (activeScan) activeScan.cancelled = true
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export function adbPacket(
  cmd: number,
  arg0: number,
  arg1: number,
  payload: Buffer
) {
  const header = Buffer.alloc(24)
  header.writeUInt32LE(cmd >>> 0, 0)
  header.writeUInt32LE(arg0 >>> 0, 4)
  header.writeUInt32LE(arg1 >>> 0, 8)
  header.writeUInt32LE(payload.length, 12)
  header.writeUInt32LE(crc32(payload), 16)
  header.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20)
  return Buffer.concat([header, payload])
}

export function probePort(
  host: string,
  port: number,
  timeout: number
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host, port })
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.once('close', () => done(false))
  })
}

// 光看端口开着还不够——5555 也可能被别的服务占着。
// 发一个 adb CNXN 握手包，只有回 CNXN（已授权）或 AUTH（待授权）才算 ADB。
export function probeAdbPort(
  host: string,
  port: number,
  timeout = ADB_PROBE_TIMEOUT
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let buffered = Buffer.alloc(0)
    const socket = net.connect({ host, port })
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => {
      socket.write(
        adbPacket(A_CNXN, ADB_VERSION, ADB_MAX_DATA, Buffer.from('host::\0'))
      )
    })
    socket.on('data', (chunk) => {
      if (settled) return
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length < 24) return
      const cmd = buffered.readUInt32LE(0)
      done(cmd === A_CNXN || cmd === A_AUTH)
    })
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.once('close', () => done(false))
  })
}

async function forEachLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  signal?: { cancelled: boolean }
) {
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        // 取消后不用把剩下的几万个端口空转一遍：worker 直接退出
        if (signal?.cancelled) return
        const i = next++
        if (i >= items.length) return
        await fn(items[i])
      }
    }
  )
  await Promise.all(workers)
}

function range(from: number, to: number): number[] {
  const ports: number[] = []
  for (let p = from; p <= to; p++) ports.push(p)
  return ports
}

// TCP 层探活，给定端口列表
export async function scanPortsOf(
  host: string,
  ports: number[],
  options: {
    timeout?: number
    concurrency?: number
    signal?: { cancelled: boolean }
    onProgress?: (done: number, total: number) => void
  } = {}
): Promise<{ openPorts: number[]; scanned: number }> {
  const timeout = options.timeout || DEFAULT_TIMEOUT
  const concurrency = options.concurrency || QUICK_CONCURRENCY
  const report = options.onProgress || (() => {})
  const openPorts: number[] = []
  let done = 0
  let lastReport = 0

  await forEachLimit(ports, concurrency, async (port) => {
    if (options.signal?.cancelled) return
    const ok = await probePort(host, port, timeout)
    if (ok) openPorts.push(port)
    done++
    const now = Date.now()
    if (now - lastReport > 150 || done === ports.length) {
      lastReport = now
      report(done, ports.length)
    }
  }, options.signal)

  return { openPorts: openPorts.sort((a, b) => a - b), scanned: done }
}

export async function scanHostPorts(
  host: string,
  options: {
    deep?: boolean
    timeout?: number
    onProgress?: (progress: PortScanProgress) => void
  } = {}
): Promise<PortScanResult> {
  const scanToken = { cancelled: false }
  activeScan = scanToken
  const isCancelled = () => scanToken.cancelled
  const started = Date.now()
  const timeout = options.timeout || DEFAULT_TIMEOUT
  const report = options.onProgress || (() => {})
  const openPorts = new Set<number>()
  let scanned = 0

  const scan = async (
    ports: number[],
    concurrency: number,
    phase: 'quick' | 'deep'
  ) => {
    const r = await scanPortsOf(host, ports, {
      timeout,
      concurrency,
      signal: scanToken,
      onProgress: (done, total) => report({ phase, done, total }),
    })
    r.openPorts.forEach((p) => openPorts.add(p))
    scanned += r.scanned
  }

  const adbOf = async (ports: number[]) => {
    // 开放端口可能有一堆（本机回环就有十几个），串行等超时太慢，几个并发探
    const adbPorts: number[] = []
    const total = ports.length
    let done = 0
    await forEachLimit(ports, 6, async (port) => {
      if (isCancelled()) return
      if (await probeAdbPort(host, port)) adbPorts.push(port)
      done++
      report({ phase: 'adb', done, total })
    }, scanToken)
    return adbPorts.sort((a, b) => a - b)
  }

  const quickPorts: number[] = []
  for (const [from, to] of QUICK_RANGES) quickPorts.push(...range(from, to))

  try {
    await scan(quickPorts, QUICK_CONCURRENCY, 'quick')
    let adbPorts = isCancelled()
      ? []
      : await adbOf([...openPorts].sort((a, b) => a - b))

    // 常用段没有 ADB：整段 1-65535 兜底（跳过已经扫过的）
    if (!isCancelled() && !adbPorts.length && options.deep !== false) {
      const quick = new Set(quickPorts)
      const rest: number[] = []
      for (let p = 1; p <= 65535; p++) if (!quick.has(p)) rest.push(p)
      await scan(rest, DEEP_CONCURRENCY, 'deep')
      adbPorts = isCancelled()
        ? []
        : await adbOf([...openPorts].sort((a, b) => a - b))
    }

    const result: PortScanResult = {
      ip: host,
      adbPorts,
      openPorts: [...openPorts].sort((a, b) => a - b),
      scanned,
      cancelled: isCancelled(),
      durationMs: Date.now() - started,
    }

    logger.info('port scan', {
      ip: host,
      scanned: result.scanned,
      open: result.openPorts,
      adb: result.adbPorts,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
    })

    return result
  } finally {
    if (activeScan === scanToken) activeScan = null
  }
}
