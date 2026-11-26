/**
 * adb 命令层：设备侧所有命令都从这里出。
 *
 * 约定：
 * - 文本命令走 shell()：多条命令用分隔符拼成一次 shell 往返，减少 adb 连接开销；
 * - 需要退出码的破坏性操作走 shellChecked()，否则 rm/pm 失败会被当成成功；
 * - 行流走 spawnAdbLines()，大文件流走 spawnAdbToFile()；
 * - 超时一律返回 timedOut 标记，调用方必须检查，不能把半截输出当完整结果。
 *
 * 这层只依赖 adbkit 的 Client（负责连接/forward 管理）和系统 adb 二进制，
 * 只依赖 adb 与 Node 标准库。
 */
import childProcess from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'fs-extra'
import { randomUUID } from 'node:crypto'
import Adb, { Client } from '@devicefarmer/adbkit'
import getPort from 'licia/getPort'
import log from 'share/common/log'
import { decodeAdbOutput } from 'common/adbParse'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import { getSettingsStore } from '../store'
import { IpcGetProcesses, IpcReverseTcp, IProcess } from 'common/types'
import { parseTop, TopColumn } from './processParse'

const logger = log('adbBase')
const settingsStore = getSettingsStore()

let client: Client | undefined

/** 多命令拼接用的分隔符；带随机后缀，避免和命令输出里的同名文本撞上。 */
const RUN_ID = Math.random().toString(36).slice(2, 8)
const SEPARATOR = `__devicedock_sep_${RUN_ID}__`
/** 退出码哨兵前缀，必须和 shellChecked() 的拼接保持一致。 */
const EXIT_MARKER = `__devicedock_exit_${RUN_ID}__`

// ---------------------------------------------------------------------------
// 设备级缓存：按 deviceId 存连接对象、forward 端口、图标缓存等
// ---------------------------------------------------------------------------

const deviceState: Record<string, Record<string, any>> = {}

export function getDeviceStore(deviceId: string, key: string) {
  return deviceState[deviceId]?.[key]
}

export function setDeviceStore(deviceId: string, key: string, value: any) {
  if (!deviceState[deviceId]) deviceState[deviceId] = {}
  deviceState[deviceId][key] = value
}

/**
 * 设备断开/拔插时回收：这里可能握着 socket、pending 请求、forward 端口。
 * 不清会越攒越多，重连后还会复用死 socket。
 */
export function deleteDeviceStore(deviceId: string) {
  const entry = deviceState[deviceId]
  const disposable = entry?.deviceClient
  if (disposable && typeof disposable.dispose === 'function') {
    try {
      disposable.dispose()
    } catch {
      // 断开阶段的清理失败不影响后续流程
    }
  }
  delete deviceState[deviceId]
  // 进程/pid 名缓存跟着设备走：重连后 PID 可能复用，旧映射会张冠李戴
  processCache.delete(deviceId)
  pidNameCache.delete(deviceId)
}

// ---------------------------------------------------------------------------
// adb 二进制定位
// ---------------------------------------------------------------------------

const ADB_PATH_TTL = 2000
let adbPathCache: { value: string; at: number } | null = null

export function getAdbPath(): string {
  // spawn 前都会调这里：缓存 2 秒，省掉每条命令一次 statSync；
  // 用户改设置后最多 2 秒生效，可接受
  if (adbPathCache && Date.now() - adbPathCache.at < ADB_PATH_TTL) {
    return adbPathCache.value
  }
  let bin = resolveResources(
    process.platform === 'win32' ? 'adb/adb.exe' : 'adb/adb',
  )
  const custom = settingsStore.get('adbPath')
  // 只接受文件名为 adb / adb.exe 的普通文件：设置写错时不能变成任意可执行文件
  if (
    custom === 'adb' ||
    (custom &&
      custom.trim() !== '' &&
      (path.basename(custom) === 'adb' ||
        path.basename(custom) === 'adb.exe') &&
      fs.existsSync(custom) &&
      fs.statSync(custom).isFile())
  ) {
    bin = custom
  }
  adbPathCache = { value: bin, at: Date.now() }
  return bin
}

function spawnAdbProcess(args: string[]) {
  // 直接给参数数组（shell:false）：不经过 cmd.exe，避免 %、&、|、^ 被解释
  return childProcess.spawn(getAdbPath(), args, {
    env: { ...process.env },
    windowsHide: true,
  })
}

function decode(chunks: Buffer[]): string {
  return decodeAdbOutput(chunks)
}

/** 先 SIGTERM，2 秒后还在就 SIGKILL，避免 adb 卡在 USB 读写时留下僵尸进程。 */
function terminate(cp: childProcess.ChildProcess) {
  try {
    cp.kill()
  } catch {
    // 进程可能已经退出
  }
  const hard = setTimeout(() => {
    try {
      cp.kill('SIGKILL')
    } catch {
      // ignore
    }
  }, 2000)
  hard.unref?.()
}

// ---------------------------------------------------------------------------
// shell：文本命令（带超时、退出码）
// ---------------------------------------------------------------------------

export async function shell(
  deviceId: string,
  cmd: string,
  timeoutMs?: number,
): Promise<string>
export async function shell(
  deviceId: string,
  cmd: string[],
  timeoutMs?: number,
): Promise<string[]>
export async function shell(
  deviceId: string,
  cmd: string | string[],
  timeoutMs = 15000,
): Promise<string | string[]> {
  logger.debug('shell', cmd)
  if (!client) throw new Error('adb client 未初始化')

  const commands = typeof cmd === 'string' ? [cmd] : cmd
  // 空数组会拼出 `adb shell`（交互式 shell），永远不结束
  if (commands.length === 0) return []

  const device = await client.getDevice(deviceId)
  const socket = await device.shell(commands.join(`\necho "${SEPARATOR}"\n`))
  // 超时 destroy(error) 后 readAll 会走 reject，但 socket 自身的 error 事件
  // 如果没有监听器会冒成 unhandled：这里兜一层，不影响 readAll 的监听
  socket.on('error', () => {})

  let timer: ReturnType<typeof setTimeout> | undefined
  let raw: string
  try {
    raw = (
      await Promise.race([
        Adb.util.readAll(socket),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            try {
              // 必须带 error 参数，readAll 才会走 reject 分支
              socket.destroy(new Error('adb shell timeout'))
            } catch {
              // ignore
            }
            reject(new Error('adb shell 超时'))
          }, timeoutMs)
        }),
      ])
    ).toString()
  } finally {
    if (timer) clearTimeout(timer)
  }

  if (typeof cmd === 'string') return raw.trim()
  return raw.split(SEPARATOR).map((part) => part.trim())
}

/**
 * 带退出码的 shell：adb 的 shell 协议不返回退出码，所以在命令末尾追加
 * `echo "__devicedock_exit:$?"`，解析最后一行。非 0 直接抛错。
 */
export async function shellChecked(
  deviceId: string,
  command: string,
  timeoutMs = 15000,
): Promise<string> {
  const output = await shell(
    deviceId,
    `${command}; echo "${EXIT_MARKER}:$?"`,
    timeoutMs,
  )
  const lines = output.split('\n')
  let code = 0
  const markerPattern = new RegExp(`^\\s*${EXIT_MARKER}:(\\d+)\\s*$`)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(markerPattern)
    if (m) {
      code = Number(m[1])
      lines.splice(i, 1)
      break
    }
  }
  const text = lines.join('\n').trim()
  if (code !== 0) {
    throw new Error(`命令执行失败（exit ${code}）：${text || command}`)
  }
  return text
}

// ---------------------------------------------------------------------------
// 端口转发
// ---------------------------------------------------------------------------

export async function forwardTcp(deviceId: string, remote: string) {
  if (!client) throw new Error('adb client 未初始化')
  const device = await client.getDevice(deviceId)
  const forwards = await device.listForwards()
  const existing = forwards.find(
    (item) => item.remote === remote && item.serial === deviceId,
  )
  if (existing) {
    const matched = existing.local.match(/^tcp:(\d+)$/)
    if (matched) return Number(matched[1])
  }

  const port = await getPort()
  await device.forward(`tcp:${port}`, remote)
  return port
}

export const reverseTcp: IpcReverseTcp = async function (deviceId, remote) {
  if (!client) throw new Error('adb client 未初始化')
  const device = await client.getDevice(deviceId)
  const reverses = await device.listReverses()
  const existing = reverses.find((item) => item.remote === remote)
  if (existing) {
    const matched = existing.local.match(/^tcp:(\d+)$/)
    if (matched) return Number(matched[1])
  }

  const port = await getPort()
  await device.reverse(remote, `tcp:${port}`)
  return port
}

// ---------------------------------------------------------------------------
// 进程列表
// ---------------------------------------------------------------------------

const TOP_COLUMNS: TopColumn[] = [
  { key: 'pid' },
  { key: '%cpu' },
  { key: 'time+' },
  { key: 'res' },
  { key: 'user' },
  { key: 'name' },
  { key: 'args', rest: true },
]

type TopMode = 'modern' | 'legacy-fast' | 'legacy'
const topModes = new Map<string, TopMode>()

export function clearProcessCaches(deviceId: string) {
  processCache.delete(deviceId)
  pidNameCache.delete(deviceId)
  topModes.delete(deviceId)
}

async function fetchProcesses(deviceId: string): Promise<IProcess[]> {
  const command =
    'top -b -n 1' + TOP_COLUMNS.map((c) => ` -o ${c.key}`).join('')
  const mode = topModes.get(deviceId)

  const run = async (cmd: string, nextMode: TopMode) => {
    try {
      const rows = parseTop(String(await shell(deviceId, cmd)), TOP_COLUMNS)
      if (rows.length) topModes.set(deviceId, nextMode)
      return rows
    } catch {
      return []
    }
  }

  let rows: IProcess[] = []
  if (mode !== 'legacy-fast' && mode !== 'legacy') {
    rows = await run(command, 'modern')
  }
  if (!rows.length && mode !== 'legacy') {
    // Android 6/toolbox 的 top 支持 -d 0，单次采样从约 3 秒降到约 0.2 秒。
    rows = await run('top -n 1 -d 0', 'legacy-fast')
  }
  if (!rows.length) {
    // 个别老固件不认 -d 0，再退回默认采样。
    rows = await run('top -n 1', 'legacy')
  }

  return rows.filter(
    (row) => (row as any).args !== command && (row as any).name !== 'top',
  )
}

const PROCESS_TTL = 1500
const processCache = new Map<
  string,
  { at: number; promise: Promise<IProcess[]> }
>()

export const getProcesses: IpcGetProcesses = (deviceId: string) => {
  // 1.5 秒内复用同一份快照：进程页 5 秒轮询 + 并发刷新不会重复跑 top，
  // 超过 TTL 一定要重新取，否则页面永远停在第一次的进程列表
  const hit = processCache.get(deviceId)
  if (hit && Date.now() - hit.at < PROCESS_TTL) return hit.promise

  const promise = fetchProcesses(deviceId)
  const entry = { at: Date.now(), promise }
  processCache.set(deviceId, entry)
  // 失败不留在缓存里，下次调用重新试
  promise.catch(() => {
    if (processCache.get(deviceId) === entry) processCache.delete(deviceId)
  })
  return promise
}

const PID_NAME_TTL = 5000
const pidNameCache = new Map<
  string,
  { at: number; promise: Promise<Record<string, string>> }
>()

export function getPidNames(deviceId: string) {
  const hit = pidNameCache.get(deviceId)
  if (hit && Date.now() - hit.at < PID_NAME_TTL) return hit.promise

  const promise = getProcesses(deviceId).then((list) => {
    const names: Record<string, string> = {}
    for (const item of list) names[item.pid] = item.name
    return names
  })
  const entry = { at: Date.now(), promise }
  pidNameCache.set(deviceId, entry)
  promise.catch(() => {
    if (pidNameCache.get(deviceId) === entry) pidNameCache.delete(deviceId)
  })
  return promise
}

// ---------------------------------------------------------------------------
// 原始进程调用：文本 / 流式 / 二进制
// ---------------------------------------------------------------------------

export type AdbResult = {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

export function spawnAdb(
  args: string[],
  timeoutMs = 60000,
): Promise<AdbResult> {
  return new Promise((resolve, reject) => {
    const cp = spawnAdbProcess(args)
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      terminate(cp)
      resolve({
        stdout: decode(out),
        stderr: (decode(err) + '\n[timeout]').trim(),
        code: -1,
        timedOut: true,
      })
    }, timeoutMs)

    cp.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    cp.stderr?.on('data', (chunk: Buffer) => err.push(chunk))

    cp.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    cp.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout: decode(out),
        stderr: decode(err),
        code,
        timedOut: false,
      })
    })
  })
}

const ADB_SERVER_LOCK = path.join(
  os.tmpdir(),
  `devicedock-adb-server-${process.getuid?.() ?? 'user'}.lock`,
)
const ADB_LOCK_WAIT_MS = 30000

type AdbLockInfo = {
  pid?: number
  nonce?: string
  startedAt?: number
}

function readAdbLock(): AdbLockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(ADB_SERVER_LOCK, 'utf8'))
  } catch {
    return null
  }
}

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === 'EPERM'
  }
}

function clearStaleAdbLock() {
  let stat: fs.Stats
  try {
    stat = fs.statSync(ADB_SERVER_LOCK)
  } catch {
    return
  }

  const info = readAdbLock()
  const age = Date.now() - stat.mtimeMs
  const definitelyStale =
    (info?.pid && !isProcessAlive(info.pid)) ||
    (!info?.pid && age > 5000) ||
    age > 10 * 60 * 1000
  if (!definitelyStale) return

  try {
    // 删除前再读一次，避免刚释放的锁被另一个进程重新建立后误删。
    const current = readAdbLock()
    if ((current?.nonce || '') === (info?.nonce || '')) {
      fs.unlinkSync(ADB_SERVER_LOCK)
    }
  } catch {
    // 另一个进程已经处理
  }
}

/**
 * 设备坞和 APM 共用 5037 端口。两个进程同时启动时，第二个 adb 会报
 * `Address already in use`，随后 tracker 永久断开。这里用文件锁串行化启动，
 * 并在返回非零时以 `adb devices` 探测已有服务，允许安全复用。
 */
export async function ensureAdbServer() {
  const deadline = Date.now() + ADB_LOCK_WAIT_MS
  let lockFd: number | null = null
  const lockInfo: AdbLockInfo = {
    pid: process.pid,
    nonce: randomUUID(),
    startedAt: Date.now(),
  }

  while (Date.now() < deadline) {
    try {
      lockFd = fs.openSync(ADB_SERVER_LOCK, 'wx')
      try {
        fs.writeFileSync(lockFd, JSON.stringify(lockInfo))
      } catch (error) {
        fs.closeSync(lockFd)
        lockFd = null
        fs.unlinkSync(ADB_SERVER_LOCK)
        throw error
      }
      break
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e
      clearStaleAdbLock()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  if (lockFd === null) throw new Error('等待 ADB 服务启动锁超时')

  try {
    const started = await spawnAdb(['start-server'], 15000)
    if (!started.timedOut && started.code === 0) return

    // 端口已被另一个客户端占用时 start-server 可能失败，但现有服务仍可用。
    const probe = await spawnAdb(['devices'], 5000)
    if (!probe.timedOut && probe.code === 0) return

    throw new Error(
      `ADB 服务启动失败：${started.stderr || probe.stderr || '未知错误'}`,
    )
  } finally {
    try {
      fs.closeSync(lockFd)
    } catch {
      // ignore
    }
    try {
      if (readAdbLock()?.nonce === lockInfo.nonce) {
        fs.unlinkSync(ADB_SERVER_LOCK)
      }
    } catch {
      // ignore
    }
  }
}

/**
 * 流式版：全盘 find 要跑几十秒，边读边把结果推给界面。
 * onSpawn 把「提前结束」的句柄交给调用方，用户继续输入时可以杀掉上一次遍历。
 */
export function spawnAdbLines(
  args: string[],
  timeoutMs: number,
  onLine: (line: string) => void,
  onSpawn?: (kill: () => void) => void,
): Promise<{ code: number | null; timedOut: boolean; stderr: string }> {
  return new Promise((resolve, reject) => {
    const cp = spawnAdbProcess(args)
    let settled = false
    let stderr: Buffer = Buffer.alloc(0)
    // 按字节缓冲到换行再解码：逐 chunk 解码会把 UTF-8 汉字切成两半
    let pending: Buffer = Buffer.alloc(0)

    const finish = (code: number | null, timedOut: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        cp.kill()
      } catch {
        // ignore
      }
      resolve({ code, timedOut, stderr: decode([stderr]) })
    }

    const timer = setTimeout(() => finish(-1, true), timeoutMs)
    if (onSpawn) onSpawn(() => finish(null, false))

    cp.stdout?.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      let idx = pending.indexOf(0x0a)
      while (idx >= 0) {
        const line = decode([pending.subarray(0, idx)]).replace(/\r$/, '')
        pending = pending.subarray(idx + 1)
        if (line.trim()) onLine(line)
        idx = pending.indexOf(0x0a)
      }
      // 没有换行的超长行：兜底输出，避免把内存吃满
      if (pending.length > 1024 * 1024) {
        const line = decode([pending])
        pending = Buffer.alloc(0)
        if (line.trim()) onLine(line)
      }
    })
    cp.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= 64 * 1024) return
      stderr = Buffer.concat([
        stderr,
        chunk.subarray(0, 64 * 1024 - stderr.length),
      ])
    })

    cp.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    cp.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (pending.length) {
        const line = decode([pending]).replace(/\r$/, '')
        if (line.trim()) onLine(line)
      }
      resolve({ code, timedOut: false, stderr: decode([stderr]) })
    })
  })
}

/** exec-out 大文件直接流到磁盘，避免把整个文件先堆进主进程内存。 */
export function spawnAdbToFile(
  args: string[],
  file: string,
  timeoutMs = 120000,
): Promise<{
  code: number | null
  timedOut: boolean
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const cp = spawnAdbProcess(args)
    const writable = fs.createWriteStream(file, { flags: 'w' })
    const stderrChunks: Buffer[] = []
    let stderrBytes = 0
    let code: number | null = null
    let closed = false
    let finished = false
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        writable.destroy()
        terminate(cp)
        reject(error)
        return
      }
      resolve({
        code,
        timedOut: false,
        stderr: decode(stderrChunks),
      })
    }

    const maybeFinish = () => {
      if (closed && finished) finish()
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      writable.destroy()
      terminate(cp)
      resolve({
        code: -1,
        timedOut: true,
        stderr: decode(stderrChunks),
      })
    }, timeoutMs)

    cp.stdout?.pipe(writable)
    cp.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 64 * 1024) return
      const part = chunk.subarray(0, 64 * 1024 - stderrBytes)
      stderrChunks.push(part)
      stderrBytes += part.length
    })

    writable.on('finish', () => {
      finished = true
      maybeFinish()
    })
    writable.on('error', (error) => finish(error))

    cp.on('error', (error) => finish(error))
    cp.on('close', (exitCode) => {
      code = exitCode
      closed = true
      maybeFinish()
    })
  })
}

export async function isRooted(deviceId: string): Promise<boolean> {
  const id = await shell(deviceId, 'id')
  return String(id).includes('uid=0')
}

export async function init(c: Client) {
  client = c
  handleEvent('reverseTcp', reverseTcp)
  handleEvent('getProcesses', getProcesses)
}
