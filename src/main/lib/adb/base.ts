import singleton from 'licia/singleton'
import each from 'licia/each'
import trim from 'licia/trim'
import startWith from 'licia/startWith'
import map from 'licia/map'
import lowerCase from 'licia/lowerCase'
import Adb, { Client } from '@devicefarmer/adbkit'
import getPort from 'licia/getPort'
import toNum from 'licia/toNum'
import types from 'licia/types'
import isStr from 'licia/isStr'
import log from 'share/common/log'
import { decodeAdbOutput } from 'common/adbParse'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import isWindows from 'licia/isWindows'
import isStrBlank from 'licia/isStrBlank'
import fs from 'fs-extra'
import { getSettingsStore } from '../store'
import childProcess from 'node:child_process'
import path from 'node:path'
import contain from 'licia/contain'
import { IpcGetProcesses, IpcReverseTcp, IProcess } from 'common/types'

const logger = log('adbBase')

const settingsStore = getSettingsStore()

let client: Client

export const getPidNames = singleton(async (deviceId: string) => {
  const processes = await getProcesses(deviceId)
  const pidNames = {}
  each(processes, (process) => {
    pidNames[process.pid] = process.name
  })
  return pidNames
})

export const getProcesses = singleton(<IpcGetProcesses>(async (
  deviceId: string
) => {
  let columns = ['pid', '%cpu', 'time+', 'res', 'user', 'name', 'args']
  let command = 'top -b -n 1'
  each(columns, (column) => {
    command += ` -o ${column}`
  })

  const result: string = await shell(deviceId, command)
  let lines = result.split('\n')
  let start = -1
  for (let i = 0, len = lines.length; i < len; i++) {
    if (startWith(trim(lines[i]), 'PID')) {
      start = i + 1
      break
    }
  }

  // older version of top command
  if (start < 0) {
    const result: string = await shell(deviceId, 'top -n 1')
    lines = result.split('\n')
    for (let i = 0, len = lines.length; i < len; i++) {
      const line = trim(lines[i])
      if (startWith(line, 'PID')) {
        columns = line.split(/\s+/)
        columns = map(columns, (column) => {
          column = lowerCase(column)
          if (column === 'cpu%') {
            column = '%cpu'
          } else if (column === 'uid') {
            column = 'user'
          } else if (column === 'rss') {
            column = 'res'
          }
          return column
        })
        start = i + 1
        break
      }
    }
  }

  lines = lines.slice(start)
  const processes: IProcess[] = []
  each(lines, (line) => {
    line = trim(line)
    if (!line) {
      return
    }
    const parts = line.split(/\s+/)
    const process: any = {}
    each(columns, (column, index) => {
      if (column === 'args') {
        process[column] = parts.slice(index).join(' ')
      } else {
        process[column] = parts[index] || ''
      }
    })
    if (process.args === command) {
      return
    }
    processes.push(process)
  })

  return processes
}))

export async function init(c: Client) {
  client = c

  handleEvent('reverseTcp', reverseTcp)
  handleEvent('getProcesses', getProcesses)
}

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

  const cmds: string[] = isStr(cmd) ? [cmd] : cmd
  // 空数组会拼出 `shell:`（空命令）= 交互式 shell，永远不会结束
  if (!cmds.length) return []

  const device = await client.getDevice(deviceId)

  const socket = await device.shell(cmds.join('\necho "devicedock_separator"\n'))
  // 设备半死不活时 readAll 会永远等不到 end：用 race 保证 shell() 一定会在超时后 reject
  let timer: any = null
  let output: string
  try {
    output = (
      await Promise.race([
        Adb.util.readAll(socket),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            try {
              // destroy(err) 才会触发 readAll 的 error 分支；无参 destroy 只发 close
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

  if (isStr(cmd)) {
    return trim(output)
  }

  return map(output.split('devicedock_separator'), (val) => trim(val))
}

// shell() 只拿得到 stdout、没有退出码：rm / pm disable / settings put 失败时会被当成成功。
// 这里在命令尾追加哨兵行回传 $?，非 0 直接抛错，让上层 UI 能报错而不是假成功。
export async function shellChecked(
  deviceId: string,
  command: string,
  timeoutMs = 15000
): Promise<string> {
  const marker = '__devicedock_exit'
  const output = await shell(
    deviceId,
    `${command}; echo "${marker}:$?"`,
    timeoutMs
  )
  const lines = output.split('\n')
  let code = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const matched = lines[i].match(/^\s*__devicedock_exit:(\d+)\s*$/)
    if (matched) {
      code = toNum(matched[1])
      lines.splice(i, 1)
      break
    }
  }
  const text = trim(lines.join('\n'))
  if (code !== 0) {
    throw new Error(`命令执行失败（exit ${code}）：${text || command}`)
  }
  return text
}

export async function forwardTcp(deviceId: string, remote: string) {
  const device = await client.getDevice(deviceId)
  const forwards = await device.listForwards()

  for (let i = 0, len = forwards.length; i < len; i++) {
    const forward = forwards[i]
    if (forward.remote === remote && forward.serial === deviceId) {
      return toNum(forward.local.replace('tcp:', ''))
    }
  }

  const port = await getPort()
  const local = `tcp:${port}`
  await device.forward(local, remote)

  return port
}

export const reverseTcp: IpcReverseTcp = async function (deviceId, remote) {
  const device = await client.getDevice(deviceId)
  const reverses = await device.listReverses()

  for (let i = 0, len = reverses.length; i < len; i++) {
    const reverse = reverses[i]
    if (reverse.remote === remote) {
      return toNum(reverse.local.replace('tcp:', ''))
    }
  }

  const port = await getPort()
  const local = `tcp:${port}`
  await device.reverse(remote, local)

  return port
}

const deviceStore: types.PlainObj<any> = {}

export function getDeviceStore(deviceId: string, key: string) {
  return deviceStore[deviceId] && deviceStore[deviceId][key]
}

export function setDeviceStore(deviceId: string, key: string, value: any) {
  if (!deviceStore[deviceId]) {
    deviceStore[deviceId] = {}
  }
  deviceStore[deviceId][key] = value
}

// 设备拔掉/隧道断开时回收：deviceClient 里握着一条 socket 和 pending 请求，
// 不清理的话反复插拔设备会一直攒着（旧 forward 端口、死 socket 也会被复用）
export function deleteDeviceStore(deviceId: string) {
  const entry = deviceStore[deviceId]
  if (entry && entry.deviceClient && typeof entry.deviceClient.dispose === 'function') {
    try {
      entry.deviceClient.dispose()
    } catch {
      // ignore
    }
  }
  delete deviceStore[deviceId]
}

export function getAdbPath() {
  let bin = isWindows
    ? resolveResources('adb/adb.exe')
    : resolveResources('adb/adb')
  const adbPath = settingsStore.get('adbPath')
  // 只接受名为 adb / adb.exe 的普通文件，避免被设置成任意可执行文件
  if (
    adbPath === 'adb' ||
    (!isStrBlank(adbPath) &&
      (path.basename(adbPath) === 'adb' ||
        path.basename(adbPath) === 'adb.exe') &&
      fs.existsSync(adbPath) &&
      fs.statSync(adbPath).isFile())
  ) {
    bin = adbPath
  }
  return bin
}

export function spawnAdb(
  args: string[],
  timeoutMs = 60000
): Promise<{
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}> {
  const bin = getAdbPath()

  return new Promise((resolve, reject) => {
    // 直接 spawn 参数数组（shell:false）：
    // 不再经过 cmd.exe，避免 % 变量展开、& | ^ 等特殊字符问题，也少一层进程开销
    const cp = childProcess.spawn(bin, args, {
      env: { ...process.env },
      windowsHide: true,
    })

    // 先收集原始字节，结束时整体解码：
    // adb 输出是 UTF-8；cmd.exe 的报错是 GBK（中文 Windows），
    // 逐块用 fatal 解码会在多字节字符被切分时误判成 GBK，导致乱码。
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let done = false

    cp.stdout?.on('data', (data: Buffer) => outChunks.push(data))
    cp.stderr?.on('data', (data: Buffer) => errChunks.push(data))

    // 编码判定与解码逻辑抽到 common/adbParse（有单元测试），这里只保留调用名
    const decodeAll = decodeAdbOutput

    // 兜底超时：设备/隧道卡死时不能再无限等待
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        cp.kill()
      } catch {
        // ignore
      }
      // adb 偶尔不响应 SIGTERM（卡在 USB 读写）：2 秒后再补一刀，别留下僵尸进程
      const hardKill = setTimeout(() => {
        try {
          cp.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, 2000)
      hardKill.unref?.()
      resolve({
        stdout: decodeAll(outChunks),
        stderr: (decodeAll(errChunks) + '\n[timeout]').trim(),
        code: -1,
        timedOut: true,
      })
    }, timeoutMs)

    cp.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(err)
    })

    cp.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({
        stdout: decodeAll(outChunks),
        stderr: decodeAll(errChunks),
        code,
        timedOut: false,
      })
    })
  })
}

// 流式版：全盘 find 可能要跑几十秒，边读边把「找到几个」报给界面，
// 否则用户只能盯着一个转圈猜是不是卡死了。
// onSpawn 把「立即结束这次搜索」的句柄交给调用方：用户继续输入时新搜索
// 可以杀掉上一次还在设备上遍历整盘的 find，避免进程越堆越多、越搜越慢。
export function spawnAdbLines(
  args: string[],
  timeoutMs: number,
  onLine: (line: string) => void,
  onSpawn?: (kill: () => void) => void
): Promise<{ code: number | null; timedOut: boolean }> {
  const bin = getAdbPath()

  return new Promise((resolve, reject) => {
    const cp = childProcess.spawn(bin, args, {
      env: { ...process.env },
      windowsHide: true,
    })
    let done = false
    // 按字节缓冲到换行再解码：逐 chunk 解码会在多字节字符中间切开，
    // 中文文件名会变成乱码/替换符（decodeAdbOutput 自己的注释就警告过）。
    let rest: Buffer = Buffer.alloc(0)

    const finish = (code: number | null, timedOut: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        cp.kill()
      } catch {
        // ignore
      }
      resolve({ code, timedOut })
    }

    const timer = setTimeout(() => {
      finish(-1, true)
    }, timeoutMs)

    if (onSpawn) onSpawn(() => finish(null, false))

    cp.stdout?.on('data', (chunk: Buffer) => {
      rest = Buffer.concat([rest, chunk])
      let idx = rest.indexOf(0x0a)
      while (idx >= 0) {
        const line = decodeAdbOutput([rest.subarray(0, idx)]).replace(/\r$/, '')
        rest = rest.subarray(idx + 1)
        if (line.trim()) onLine(line)
        idx = rest.indexOf(0x0a)
      }
      // 没有换行的超长行兜底，避免异常输出把内存吃满
      if (rest.length > 1024 * 1024) {
        const line = decodeAdbOutput([rest])
        rest = Buffer.alloc(0)
        if (line.trim()) onLine(line)
      }
    })
    cp.stderr?.on('data', () => {})

    cp.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(err)
    })

    cp.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (rest.length) {
        const line = decodeAdbOutput([rest]).replace(/\r$/, '')
        if (line.trim()) onLine(line)
      }
      resolve({ code, timedOut: false })
    })
  })
}

export async function isRooted(deviceId: string): Promise<boolean> {
  const id = await shell(deviceId, 'id')
  return contain(id, 'uid=0')
}

// 二进制安全版：exec-out 拉文件不能走 decodeAdbOutput（会把内容按 UTF-8/GBK 解码破坏掉）
export function spawnAdbBuffer(
  args: string[],
  timeoutMs = 60000
): Promise<{ buffer: Buffer; code: number | null; timedOut: boolean }> {
  const bin = getAdbPath()

  return new Promise((resolve, reject) => {
    const cp = childProcess.spawn(bin, args, {
      env: { ...process.env },
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    let done = false

    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        cp.kill()
      } catch {
        // ignore
      }
      resolve({ buffer: Buffer.concat(chunks), code: -1, timedOut: true })
    }, timeoutMs)

    cp.stdout?.on('data', (data: Buffer) => chunks.push(data))
    // stderr 丢弃即可：run-as 的报错会体现在 code != 0
    cp.stderr?.on('data', () => {})

    cp.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(err)
    })

    cp.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ buffer: Buffer.concat(chunks), code, timedOut: false })
    })
  })
}
