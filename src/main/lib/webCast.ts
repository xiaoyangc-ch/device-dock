/**
 * 投屏服务端管理：scrcpy-server 3.1 + adb forward。
 *
 * 每台设备同一时刻只允许一个投屏 server：
 * - 启动/停止/换源全部走 withLock 串行，否则两个会话会互相删对方的 forward；
 * - 每次启动用不同的 jar 文件名，旧 server 退出时会删自己的 jar，同名会把新的删掉；
 * - 停止时必须同时 kill 设备端 app_process，只杀本地 adb 客户端会留下占着 socket 的僵尸。
 */
import childProcess from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import { app } from 'electron'
import log from 'share/common/log'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import { getAdbPath, spawnAdb } from './adb/base'
import {
  IpcInstallWebCastApk,
  IpcReverseWebCast,
  IpcStartWebCast,
  IpcStopWebCast,
  IpcWaitWebCast,
  IpcWebCastDisplays,
} from 'common/types'

const logger = log('webCast')

const JAR_DIR = '/data/local/tmp/devicedock'
const SERVER_VERSION = '3.1'
// 只清理本程序推上去的 server，避免误杀用户自己开的 scrcpy
const KILL_CMD = `pkill -f ${JAR_DIR}/scrcpy-`

const procs = new Map<string, childProcess.ChildProcess>()
const forwardPorts = new Map<string, number>()

// ---------------------------------------------------------------------------
// 设备级串行锁
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>()

function withLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(deviceId) || Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  locks.set(deviceId, tail)
  tail.then(() => {
    if (locks.get(deviceId) === tail) locks.delete(deviceId)
  })
  return run
}

// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------

/** 参数会拼进设备 shell：只允许 k=v 的白名单字符，防止注入。 */
function buildServerCmd(jarRemote: string, args: string[]) {
  const safe = args.map((arg) => {
    if (!/^[A-Za-z0-9_]+=[A-Za-z0-9_.,:+-]*$/.test(arg)) {
      throw new Error('非法的投屏参数: ' + arg)
    }
    return arg
  })
  return `CLASSPATH=${jarRemote} app_process /system/bin com.genymobile.scrcpy.Server ${SERVER_VERSION} ${safe.join(
    ' '
  )}`
}

async function killSession(deviceId: string) {
  const cp = procs.get(deviceId)
  if (cp) {
    procs.delete(deviceId)
    try {
      cp.kill()
    } catch {
      // 已经退出
    }
  }

  const port = forwardPorts.get(deviceId)
  if (port) {
    forwardPorts.delete(deviceId)
    await spawnAdb(
      ['-s', deviceId, 'forward', '--remove', `tcp:${port}`],
      8000
    ).catch(() => undefined)
  }

  // 只 kill 本地 adb 客户端不会结束设备端 app_process：
  // 残留 server 占着 abstract socket，重连可能连到旧会话（参数看起来没生效）
  await spawnAdb(['-s', deviceId, 'shell', KILL_CMD], 8000).catch(
    () => undefined
  )
}

export const startWebCast: IpcStartWebCast = (deviceId, args) =>
  withLock(deviceId, async () => {
    const jar = resolveResources('scrcpy.jar')
    if (!fs.existsSync(jar)) {
      return { ok: false, error: '缺少 resources/scrcpy.jar' }
    }

    // 每次用不同文件名：旧 server 退出时会删除自己的 jar
    const jarRemote = `${JAR_DIR}/scrcpy-${Date.now()}-${Math.floor(
      Math.random() * 1000
    )}.jar`

    const old = procs.get(deviceId)
    if (old) {
      procs.delete(deviceId)
      try {
        old.kill()
      } catch {
        // ignore
      }
    }

    let cmd: string
    try {
      cmd = buildServerCmd(jarRemote, args)
    } catch (e: any) {
      return { ok: false, error: e.message }
    }

    await spawnAdb(['-s', deviceId, 'shell', `mkdir -p ${JAR_DIR}`], 15000)
    const push = await spawnAdb(
      ['-s', deviceId, 'push', jar, jarRemote],
      60000
    )
    if (push.code !== 0) {
      logger.error('push failed', push.stderr)
      return { ok: false, error: push.stderr || '推送 scrcpy.jar 失败' }
    }

    logger.info('start server', cmd)
    const cp = childProcess.spawn(
      getAdbPath(),
      ['-s', deviceId, 'shell', cmd],
      { env: { ...process.env }, windowsHide: true }
    )
    cp.stdout?.on('data', (d: Buffer) => {
      const text = String(d).trim()
      if (text) logger.info('[server]', text)
    })
    cp.stderr?.on('data', (d: Buffer) => {
      const text = String(d).trim()
      if (text) logger.error('[server]', text)
    })
    // spawn 失败（adb 被删/被杀毒软件锁）只发 error 不发 exit：
    // 不处理就是主进程未捕获异常，procs 里还会留下死进程
    cp.on('error', (e) => {
      logger.error('adb shell spawn failed', e)
      if (procs.get(deviceId) === cp) procs.delete(deviceId)
    })
    cp.on('exit', (code) => {
      logger.info('server exit', code)
      if (procs.get(deviceId) === cp) procs.delete(deviceId)
    })

    procs.set(deviceId, cp)
    return { ok: true }
  })

export const stopWebCast: IpcStopWebCast = (deviceId) =>
  withLock(deviceId, () => killSession(deviceId))

// ---------------------------------------------------------------------------
// forward（本机 → 设备 abstract socket）
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

export const reverseWebCast: IpcReverseWebCast = (deviceId, remote) =>
  withLock(deviceId, async () => {
    const oldPort = forwardPorts.get(deviceId)
    if (oldPort) {
      await spawnAdb(
        ['-s', deviceId, 'forward', '--remove', `tcp:${oldPort}`],
        10000
      ).catch(() => undefined)
      forwardPorts.delete(deviceId)
    }

    // tcp:0 让 adb 自己挑端口，避免「先探测再 bind」之间被别的进程抢走
    let port = 0
    const auto = await spawnAdb(
      ['-s', deviceId, 'forward', 'tcp:0', remote],
      15000
    )
    const matched = String(auto.stdout || '')
      .trim()
      .match(/^(\d+)$/)
    if (auto.code === 0 && matched) {
      port = Number(matched[1])
    } else {
      port = await getFreePort()
      const result = await spawnAdb(
        ['-s', deviceId, 'forward', `tcp:${port}`, remote],
        15000
      )
      if (result.code !== 0) {
        return {
          ok: false,
          port: 0,
          error: (result.stderr || result.stdout || 'adb forward 失败').trim(),
        }
      }
    }

    forwardPorts.set(deviceId, port)
    return { ok: true, port }
  })

// ---------------------------------------------------------------------------
// APK 安装 / 信号源枚举
// ---------------------------------------------------------------------------

export const installApk: IpcInstallWebCastApk = async (deviceId, apkPath) => {
  const result = await spawnAdb(
    ['-s', deviceId, 'install', '-r', '-t', apkPath],
    180000
  )
  return {
    ok: result.code === 0,
    message: (result.stdout || result.stderr || '').trim(),
  }
}

const displayCache = new Map<
  string,
  { at: number; list: { id: number; name: string }[] }
>()
const DISPLAY_TTL = 60 * 1000

export const listDisplays: IpcWebCastDisplays = async (deviceId) => {
  const cached = displayCache.get(deviceId)
  if (cached && Date.now() - cached.at < DISPLAY_TTL) return cached.list

  const jar = resolveResources('scrcpy.jar')
  if (!fs.existsSync(jar)) return [{ id: 0, name: '主屏' }]

  // 固定文件名：避免每点一次「信号源」就在设备 tmp 里堆一个 jar
  const jarRemote = `${JAR_DIR}/scrcpy-list.jar`
  await spawnAdb(['-s', deviceId, 'shell', `mkdir -p ${JAR_DIR}`], 15000)
  const push = await spawnAdb(
    ['-s', deviceId, 'push', jar, jarRemote],
    60000
  )
  if (push.code !== 0) {
    logger.error('list displays push failed', push.stderr)
    return [{ id: 0, name: '主屏' }]
  }

  const cmd = `CLASSPATH=${jarRemote} app_process /system/bin com.genymobile.scrcpy.Server ${SERVER_VERSION} list_displays=true max_size=1280 audio=false control=false tunnel_forward=true`
  const result = await spawnAdb(['-s', deviceId, 'shell', cmd], 20000)
  const output = (result.stdout || '') + (result.stderr || '')

  const displays: { id: number; name: string }[] = []
  for (const line of output.split('\n')) {
    const matched = line.match(/display[^\n]*?id=(\d+)/i)
    if (!matched) continue
    const id = Number(matched[1])
    if (displays.some((item) => item.id === id)) continue
    const size = line.match(/(\d+)x(\d+)/)
    displays.push({
      id,
      name: id === 0 ? '主屏' : `副屏 ${id}${size ? ` (${size[0]})` : ''}`,
    })
  }
  if (!displays.length) displays.push({ id: 0, name: '主屏' })

  // LRU 上限 32：设备多了不能无限长
  if (displayCache.size > 32) {
    const oldest = displayCache.keys().next().value
    if (oldest !== undefined) displayCache.delete(oldest)
  }
  displayCache.set(deviceId, { at: Date.now(), list: displays })
  return displays
}

// ---------------------------------------------------------------------------
// 等待 server 监听 / 退出清理
// ---------------------------------------------------------------------------

/** 轮询设备端 abstract socket，确认 scrcpy-server 已经开始监听。 */
export const waitWebCast: IpcWaitWebCast = async (deviceId, scid) => {
  const name = `scrcpy_${scid.padStart(8, '0')}`
  for (let i = 0; i < 60; i++) {
    // 会话已被停掉（换源/关窗口）就别空跑 12 秒
    if (!procs.has(deviceId)) return { ok: false }

    const result = await spawnAdb(
      ['-s', deviceId, 'shell', `cat /proc/net/unix | grep -c ${name}`],
      8000
    )
    const count = (result.stdout || '').trim()
    if (result.code === 0 && count && count !== '0') return { ok: true }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return { ok: false }
}

/** will-quit 不等待异步回调：退出清理必须用 spawnSync 同步做。 */
function cleanupAllSync() {
  const adb = getAdbPath()
  for (const [deviceId, cp] of procs) {
    try {
      cp.kill()
    } catch {
      // ignore
    }
    const port = forwardPorts.get(deviceId)
    if (port) {
      childProcess.spawnSync(
        adb,
        ['-s', deviceId, 'forward', '--remove', `tcp:${port}`],
        { timeout: 3000, windowsHide: true }
      )
    }
    childProcess.spawnSync(adb, ['-s', deviceId, 'shell', KILL_CMD], {
      timeout: 3000,
      windowsHide: true,
    })
  }
  procs.clear()
  forwardPorts.clear()
}

export function init() {
  handleEvent('reverseWebCast', reverseWebCast)
  handleEvent('startWebCast', startWebCast)
  handleEvent('stopWebCast', stopWebCast)
  handleEvent('installWebCastApk', installApk)
  handleEvent('waitWebCast', waitWebCast)
  handleEvent('getWebCastDisplays', listDisplays)
  app.on('will-quit', cleanupAllSync)
}
