/**
 * 设备端服务客户端（devicedock.dex）+ 应用信息/文件服务。
 *
 * 协议：设备上跑 `com.devicedock.server.Server`，监听 localabstract:devicedock；
 * 请求/响应是 protobuf 的 length-delimited 消息（Request{id,method,params} /
 * Response{id,result}），params/result 都是 JSON 字符串。
 *
 * 所有连接都按设备缓存，设备移除时由 base.deleteDeviceStore 调 dispose()。
 */
import uuid from 'licia/uuid'
import { Client } from '@devicefarmer/adbkit'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import wire from '../wire'
import waitUntil from 'licia/waitUntil'
import { forwardTcp, getDeviceStore, setDeviceStore, shell } from './base'
import log from 'share/common/log'
import { IPackageInfo, IpcGetFileUrl, IpcGetPackageInfos } from 'common/types'

const logger = log('server')

let client: Client

// ---------------------------------------------------------------------------
// 设备服务连接
// ---------------------------------------------------------------------------

class DeviceClient {
  private deviceId: string
  private socket: any = null
  private buf: Buffer = Buffer.alloc(0)
  private connecting: Promise<void> | null = null
  private pending = new Map<
    string,
    { resolve: (value?: any) => void; reject: (error: any) => void; timer: any }
  >()

  constructor(deviceId: string) {
    this.deviceId = deviceId
  }

  async warm() {
    await this.ensureConnected()
  }

  /** 建连去重：prewarm 和业务请求同时到达时只建一条 socket。 */
  private ensureConnected(): Promise<void> {
    if (this.socket) return Promise.resolve()
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  async sendMessage(method: string, params: Record<string, any> = {}) {
    await this.ensureConnected()
    if (!this.socket) throw new Error('设备服务未连接：' + this.deviceId)

    const id = uuid()
    this.socket.write(
      wire.com.devicedock.server.Request.encodeDelimited({
        id,
        method,
        params: JSON.stringify(params),
      }).finish()
    )

    // 设备端不回包时不能把 IPC 永久挂住
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('设备服务响应超时: ' + method))
      }, 10000)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  private handleFrame(message: any) {
    const { id, result } = message
    const waiting = this.pending.get(id)
    if (!waiting) return

    this.pending.delete(id)
    clearTimeout(waiting.timer)
    try {
      waiting.resolve(JSON.parse(result))
    } catch (e) {
      waiting.reject(e)
    }
  }

  /**
   * 一个 TCP 段里可能粘了多个 length-delimited 包：
   * 只解第一个就清空 buffer，会把后面的响应整包丢掉，对应请求永远不返回。
   */
  private onSocketData(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk

    for (;;) {
      let pos = 0
      let len = 0
      let shift = 0
      let byte = 0
      do {
        if (pos >= this.buf.length) return // 长度前缀还没收全
        byte = this.buf[pos++]
        len |= (byte & 0x7f) << shift
        shift += 7
        if (shift > 35) {
          // varint 已经错位：丢弃缓冲重新同步
          this.buf = Buffer.alloc(0)
          return
        }
      } while (byte & 0x80)

      if (this.buf.length - pos < len) return // 包体还没收全
      const body = this.buf.subarray(pos, pos + len)
      this.buf = this.buf.subarray(pos + len)

      try {
        this.handleFrame(wire.com.devicedock.server.Response.decode(body))
      } catch (e) {
        logger.error('decode response failed', e)
      }
    }
  }

  private failAllPending(error: any) {
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(error)
    }
    this.pending.clear()
  }

  dispose() {
    this.failAllPending(new Error('设备已移除'))
    try {
      this.socket?.destroy?.()
    } catch {
      // ignore
    }
    this.socket = null
    this.buf = Buffer.alloc(0)
  }

  private async connect(tryStart = true) {
    logger.info('connect')
    try {
      const device = client.getDevice(this.deviceId)
      const socket = await device.openLocal('localabstract:devicedock')
      // 先登记再绑事件：回调里用 this.socket === socket 判断自己是否已被顶替
      this.socket = socket

      socket.on('readable', () => {
        if (this.socket !== socket) return
        let chunk: Buffer | null
        while ((chunk = socket.read()) !== null) {
          if (chunk.length) this.onSocketData(chunk)
        }
      })
      socket.on('error', (e: any) => {
        logger.error('设备服务连接错误', e)
        if (this.socket === socket) {
          this.socket = null
          this.buf = Buffer.alloc(0)
          this.failAllPending(e || new Error('设备服务连接错误'))
        }
      })
      socket.on('end', () => {
        if (this.socket === socket) {
          this.socket = null
          this.buf = Buffer.alloc(0)
          this.failAllPending(new Error('设备服务连接已关闭'))
        }
      })
    } catch (e) {
      if (tryStart) {
        try {
          await this.push()
          await this.start()
          await waitUntil(this.isRunning, 10000, 100)
          await this.connect(false)
        } catch (err) {
          logger.error('device server start failed', err)
        }
      }
      // 不吞异常：调用方要知道是设备掉了还是 dex 没推上去
      if (!this.socket) throw e
    }
  }

  /** 每次都实际检查：服务刚启动时第一次检查可能还是 false，不能永久缓存。 */
  private isRunning = async (): Promise<boolean> => {
    const out: string = await shell(this.deviceId, 'cat /proc/net/unix')
    return String(out).includes('@devicedock')
  }

  private async push() {
    logger.info('push')
    // adb push 不会自动建父目录：目录不存在时 dex 推不上去，
    // 应用名/图标全走 dex，界面就是空列表
    await shell(this.deviceId, 'mkdir -p /data/local/tmp/devicedock')
    const device = client.getDevice(this.deviceId)
    await device.push(
      resolveResources('devicedock.dex'),
      '/data/local/tmp/devicedock/devicedock.dex'
    )
  }

  private async start() {
    logger.info('start')
    const device = client.getDevice(this.deviceId)
    const stream: any = await device.shell(
      'CLASSPATH=/data/local/tmp/devicedock/devicedock.dex app_process /system/bin com.devicedock.server.Server'
    )
    // 这条连接只用来拉起 server：挂空 error 监听并消费数据，
    // 避免 adbkit 的 stream 报未处理 error 把主进程带走
    stream.on('error', () => {})
    if (typeof stream.resume === 'function') stream.resume()
  }
}

async function getDeviceClient(deviceId: string): Promise<DeviceClient> {
  let deviceClient = getDeviceStore(deviceId, 'deviceClient')
  if (!deviceClient) {
    deviceClient = new DeviceClient(deviceId)
    setDeviceStore(deviceId, 'deviceClient', deviceClient)
  }
  return deviceClient
}

// ---------------------------------------------------------------------------
// 应用信息（名称/版本/图标）
// ---------------------------------------------------------------------------

/** 应用名/图标只跟「包 + versionCode」有关；升级/新装由 clearPackageCaches 失效。 */
const pkgInfoCache = new Map<string, { ver: string; info: IPackageInfo }>()
const verCache = new Map<string, { at: number; map: Map<string, string> | null }>()

export async function prewarm(deviceId: string) {
  try {
    const deviceClient = await getDeviceClient(deviceId)
    await deviceClient.warm()
  } catch (e) {
    logger.debug('prewarm failed', e)
  }
}

export function clearPackageCaches(deviceId: string) {
  verCache.delete(deviceId)
  const prefix = deviceId + '|'
  for (const key of [...pkgInfoCache.keys()]) {
    if (key.startsWith(prefix)) pkgInfoCache.delete(key)
  }
}

async function getPackageVersions(
  deviceId: string
): Promise<Map<string, string> | null> {
  const cached = verCache.get(deviceId)
  // 应用很少变；装/卸/升级主动失效，这里放宽到 5 分钟
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.map

  let map: Map<string, string> | null = null
  try {
    const out = await shell(deviceId, 'pm list packages --show-versioncode')
    const parsed = new Map<string, string>()
    for (const line of String(out).split('\n')) {
      const matched = line.match(/^package:(\S+)(?:\s+versionCode:(\d+))?/)
      if (!matched) continue
      parsed.set(matched[1], matched[2] || '')
    }
    // 老系统不支持 --show-versioncode：拿不到版本号就停用缓存，
    // 否则升级后图标/名字永远不更新
    map = [...parsed.values()].some((value) => value) ? parsed : null
  } catch {
    map = null
  }
  verCache.set(deviceId, { at: Date.now(), map })

  // 版本号变了的包：清掉旧信息，下次重新问 dex
  if (map) {
    const prefix = deviceId + '|'
    for (const [key, entry] of pkgInfoCache) {
      if (!key.startsWith(prefix)) continue
      const version = map.get(key.slice(prefix.length))
      if (version === undefined || version !== entry.ver) {
        pkgInfoCache.delete(key)
      }
    }
  }
  return map
}

const getPackageInfos: IpcGetPackageInfos = async (deviceId, packageNames) => {
  const versions = await getPackageVersions(deviceId)
  const result: Array<IPackageInfo | null> = new Array(packageNames.length).fill(
    null
  )
  const misses: string[] = []
  const missIndexes: number[] = []

  for (let i = 0; i < packageNames.length; i++) {
    const pkg = packageNames[i]
    const key = `${deviceId}|${pkg}`
    const version = versions ? versions.get(pkg) : undefined
    const hit = version !== undefined ? pkgInfoCache.get(key) : undefined

    if (hit && hit.ver === version) {
      // 拷一份：后面会用最新 diskstats 覆盖体积，不能改缓存对象
      result[i] = { ...hit.info }
    } else {
      misses.push(pkg)
      missIndexes.push(i)
    }
  }

  if (misses.length) {
    const deviceClient = await getDeviceClient(deviceId)
    const { packageInfos } = await deviceClient.sendMessage(
      'getPackageInfos',
      { packageNames: misses }
    )
    const fetched: IPackageInfo[] = packageInfos || []

    const indexesByName = new Map<string, number[]>()
    for (let j = 0; j < misses.length; j++) {
      const list = indexesByName.get(misses[j]) || []
      list.push(missIndexes[j])
      indexesByName.set(misses[j], list)
    }

    for (const info of fetched) {
      if (!info || !info.packageName) continue
      if (versions) {
        pkgInfoCache.set(`${deviceId}|${info.packageName}`, {
          ver: versions.get(info.packageName) || '',
          info: { ...info },
        })
      }
      for (const index of indexesByName.get(info.packageName) || []) {
        result[index] = { ...info }
      }
    }
  }

  const list = result.filter(Boolean) as IPackageInfo[]
  if (!list.length) return list

  // 图标是设备端文件服务的 URL：先拿一次端口，整批复用
  let serverPort: number | undefined
  try {
    serverPort = await getFileServerPort(deviceId)
  } catch (e) {
    logger.warn('file server unavailable', e)
  }
  if (serverPort) {
    for (const info of list) {
      if (info.icon) {
        info.icon = `http://127.0.0.1:${serverPort}${encodeURI(info.icon)}`
      }
    }
  }

  // diskstats 有 10 秒缓存：每次刷新覆盖体积，失败时保留缓存里的旧值
  let diskStats: Record<string, any> = {}
  try {
    diskStats = await getPackageDiskStats(deviceId)
  } catch (e) {
    logger.warn('getPackageDiskStats failed', e)
  }
  for (const info of list) {
    if (info.packageName && diskStats[info.packageName]) {
      Object.assign(info, diskStats[info.packageName])
    } else if (info.appSize === undefined) {
      info.appSize = 0
      info.dataSize = 0
      info.cacheSize = 0
    }
  }

  return list
}

const diskStatsCache = new Map<string, { at: number; stats: Record<string, any> }>()
const DISK_STATS_TTL = 10 * 1000

async function getPackageDiskStats(deviceId: string) {
  const cached = diskStatsCache.get(deviceId)
  if (cached && Date.now() - cached.at < DISK_STATS_TTL) return cached.stats

  const out = String(await shell(deviceId, 'dumpsys diskstats'))
  const stats: Record<string, { appSize: number; dataSize: number; cacheSize: number }> = {}

  const names: string[] = []
  const appSizes: string[] = []
  const dataSizes: string[] = []
  const cacheSizes: string[] = []

  const collect = (line: string, prefix: string, target: string[]) => {
    if (!line.startsWith(prefix)) return
    try {
      target.push(...JSON.parse(line.slice(prefix.length)))
    } catch {
      // 设备返回的不是标准 JSON：跳过这一行
    }
  }
  for (const line of out.split('\n')) {
    collect(line, 'Package Names:', names)
    collect(line, 'App Sizes:', appSizes)
    collect(line, 'App Data Sizes:', dataSizes)
    collect(line, 'Cache Sizes:', cacheSizes)
  }

  for (let i = 0; i < names.length; i++) {
    stats[names[i]] = {
      appSize: Number(appSizes[i]) || 0,
      dataSize: Number(dataSizes[i]) || 0,
      cacheSize: Number(cacheSizes[i]) || 0,
    }
  }

  diskStatsCache.set(deviceId, { at: Date.now(), stats })
  return stats
}

// ---------------------------------------------------------------------------
// 设备端文件服务
// ---------------------------------------------------------------------------

/** 成功才缓存端口：失败不能缓存 rejection，否则这台设备永远起不来文件服务。 */
const fileServerPorts = new Map<string, number>()

async function getFileServerPort(deviceId: string): Promise<number> {
  const cached = fileServerPorts.get(deviceId)
  if (cached) {
    try {
      const deviceClient = await getDeviceClient(deviceId)
      const { running } = await deviceClient.sendMessage('isFileServerRunning')
      if (running) return cached
    } catch {
      // 服务已经挂了：下面重新起
    }
    fileServerPorts.delete(deviceId)
  }

  const deviceClient = await getDeviceClient(deviceId)
  const result = await deviceClient.sendMessage('startFileServer')
  const port = await forwardTcp(deviceId, `tcp:${result.port}`)
  fileServerPorts.set(deviceId, port)
  return port
}

const getFileUrl: IpcGetFileUrl = async (deviceId, path, port) => {
  const actualPort = port || (await getFileServerPort(deviceId))
  return `http://127.0.0.1:${actualPort}${encodeURI(path)}`
}

export async function init(c: Client) {
  client = c

  handleEvent('getPackageInfos', getPackageInfos)
  handleEvent('getFileUrl', getFileUrl)
}
