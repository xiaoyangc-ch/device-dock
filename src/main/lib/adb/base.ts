/**
 * adb 命令层：设备侧所有命令都从这里出。
 *
 * 约定：
 * - 文本命令走 shell()：多条命令用分隔符拼成一次 shell 往返，减少 adb 连接开销；
 * - 需要退出码的破坏性操作走 shellChecked()，否则 rm/pm 失败会被当成成功；
 * - 流式输出走 spawnAdbLines()，二进制流走 spawnAdbBuffer()；
 * - 超时一律返回 timedOut 标记，调用方必须检查，不能把半截输出当完整结果。
 *
 * 这层只依赖 adbkit 的 Client（负责连接/forward 管理）和系统 adb 二进制，
 * 不依赖任何 AYA 的代码。
 */
import childProcess from 'node:child_process'
import path from 'node:path'
import fs from 'fs-extra'
import Adb, { Client } from '@devicefarmer/adbkit'
import getPort from 'licia/getPort'
import log from 'share/common/log'
import { decodeAdbOutput } from 'common/adbParse'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import { getSettingsStore } from '../store'
import { IpcGetProcesses, IpcReverseTcp, IProcess } from 'common/types'

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
    process.platform === 'win32' ? 'adb/adb.exe' : 'adb/adb'
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
  timeoutMs?: number
): Promise<string>
export async function shell(
  deviceId: string,
  cmd: string[],
  timeoutMs?: number
): Promise<string[]>
export async function shell(
  deviceId: string,
  cmd: string | string[],
  timeoutMs = 15000
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
  timeoutMs = 15000
): Promise<string> {
  const output = await shell(
    deviceId,
    `${command}; echo "${EXIT_MARKER}:$?"`,
    timeoutMs
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
    (item) => item.remote === remote && item.serial === deviceId
  )
  if (existing) return Number(existing.local.replace('tcp:', ''))

  const port = await getPort()
  await device.forward(`tcp:${port}`, remote)
  return port
}

export const reverseTcp: IpcReverseTcp = async function (deviceId, remote) {
  if (!client) throw new Error('adb client 未初始化')
  const device = await client.getDevice(deviceId)
  const reverses = await device.listReverses()
  const existing = reverses.find((item) => item.remote === remote)
  if (existing) return Number(existing.local.replace('tcp:', ''))

  const port = await getPort()
  await device.reverse(remote, `tcp:${port}`)
  return port
}

// ---------------------------------------------------------------------------
// 进程列表
// ---------------------------------------------------------------------------

type TopColumn = {
  key: string
  /** args 列吃掉行尾剩余内容（进程名里可能有空格） */
  rest?: boolean
}

const TOP_COLUMNS: TopColumn[] = [
  { key: 'pid' },
  { key: '%cpu' },
  { key: 'time+' },
  { key: 'res' },
  { key: 'user' },
  { key: 'name' },
  { key: 'args', rest: true },
]

function normalizeColumn(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower === 'cpu%') return '%cpu'
  if (lower === 'uid') return 'user'
  if (lower === 'rss') return 'res'
  return lower
}

/**
 * 从 top 输出里找表头 + 数据行。
 * 新版 toybox 支持 `top -o`，表头就是参数里的列；老版本只认默认列，
 * 需要按实际表头映射（CPU%/UID/RSS 等写法不一样）。
 */
function parseTop(output: string, columns: TopColumn[]): IProcess[] {
  const lines = output.split('\n')
  let start = -1
  let active = columns

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!/^PID\b/.test(line)) continue
    start = i + 1
    // 表头和请求的列不一致（老 top）：以设备实际输出为准
    const header = line.split(/\s+/).map(normalizeColumn)
    if (header.join(',') !== columns.map((c) => c.key).join(',')) {
      active = header.map((key, index) => ({
        key,
        rest: index === header.length - 1,
      }))
    }
    break
  }
  if (start < 0) return []

  const rows: IProcess[] = []
  for (const raw of lines.slice(start)) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    const row: any = {}
    active.forEach((column, index) => {
      row[column.key] = column.rest
        ? parts.slice(index).join(' ')
        : parts[index] || ''
    })
    rows.push(row as IProcess)
  }
  return rows
}

async function fetchProcesses(deviceId: string): Promise<IProcess[]> {
  const command =
    'top -b -n 1' + TOP_COLUMNS.map((c) => ` -o ${c.key}`).join('')
  const modern = await shell(deviceId, command)
  let rows = parseTop(String(modern), TOP_COLUMNS)
  if (!rows.length) {
    // 老 top 不支持 -b/-o：退回到默认列输出
    const legacy = await shell(deviceId, 'top -n 1')
    rows = parseTop(String(legacy), TOP_COLUMNS)
  }
  // 跳过 top 自己：它的 args 就是上面那条命令
  return rows.filter((row) => (row as any).args !== command)
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

export function spawnAdb(args: string[], timeoutMs = 60000): Promise<AdbResult> {
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

/**
 * 流式版：全盘 find 要跑几十秒，边读边把结果推给界面。
 * onSpawn 把「提前结束」的句柄交给调用方，用户继续输入时可以杀掉上一次遍历。
 */
export function spawnAdbLines(
  args: string[],
  timeoutMs: number,
  onLine: (line: string) => void,
  onSpawn?: (kill: () => void) => void
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const cp = spawnAdbProcess(args)
    let settled = false
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
      resolve({ code, timedOut })
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
    cp.stderr?.on('data', () => {})

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
      resolve({ code, timedOut: false })
    })
  })
}

/** 二进制安全：exec-out 拉文件时绝不能走文本解码，否则内容会被破坏。 */
export function spawnAdbBuffer(
  args: string[],
  timeoutMs = 60000
): Promise<{ buffer: Buffer; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const cp = spawnAdbProcess(args)
    const chunks: Buffer[] = []
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      terminate(cp)
      resolve({ buffer: Buffer.concat(chunks), code: -1, timedOut: true })
    }, timeoutMs)

    cp.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    // stderr 不参与结果：run-as 的报错会体现在退出码上
    cp.stderr?.on('data', () => {})

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
      resolve({ buffer: Buffer.concat(chunks), code, timedOut: false })
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
