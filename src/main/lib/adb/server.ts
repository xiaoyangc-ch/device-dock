import types from 'licia/types'
import uuid from 'licia/uuid'
import { Client } from '@devicefarmer/adbkit'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import singleton from 'licia/singleton'
import wire from '../wire'
import waitUntil from 'licia/waitUntil'
import { forwardTcp, getDeviceStore, setDeviceStore, shell } from './base'
import contain from 'licia/contain'
import log from 'share/common/log'
import { IPackageInfo, IpcGetFileUrl, IpcGetPackageInfos } from 'common/types'
import isUndef from 'licia/isUndef'
import each from 'licia/each'
import startWith from 'licia/startWith'
import extend from 'licia/extend'
import toNum from 'licia/toNum'

const logger = log('server')

let client: Client

// 每次刷新（按 50 个包分批）都会要 diskstats：缓存 10 秒，避免一屏应用跑十几次 dumpsys
const diskStatsCache = new Map<string, { ts: number; stats: any }>()

class DeviceClient {
  private deviceId = ''
  private socket: any = null
  private buf: Buffer = Buffer.alloc(0)
  private connecting: Promise<void> | null = null
  private resolves: Map<
    string,
    { resolve: (v?: any) => void; reject: (e: any) => void; timer: any }
  > = new Map()
  constructor(deviceId: string) {
    this.deviceId = deviceId
  }
  async warm() {
    await this.ensureConnected()
  }

  // 建连去重：prewarm 和业务请求同时到达时只建一条 socket，
  // 否则后建的那条会覆盖 this.socket，旧 socket 的字节串进同一个 buffer 导致帧错位
  private ensureConnected(): Promise<void> {
    if (this.socket) return Promise.resolve()
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  async sendMessage(
    method: string,
    params: types.PlainObj<any> = {}
  ): Promise<any> {
    await this.ensureConnected()
    if (!this.socket) {
      throw new Error('设备服务未连接：' + this.deviceId)
    }

    const id = uuid()

    this.socket.write(
      wire.com.devicedock.server.Request.encodeDelimited({
        id,
        method,
        params: JSON.stringify(params),
      }).finish()
    )

    // 必须有超时和 reject 分支：设备端不回包时不能把 IPC 永久挂住
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resolves.delete(id)
        reject(new Error('设备服务响应超时: ' + method))
      }, 10000)
      this.resolves.set(id, { resolve, reject, timer })
    })
  }
  private handleFrame(message: any) {
    const { id, result } = message
    const pending = this.resolves.get(id)
    if (!pending) return
    this.resolves.delete(id)
    clearTimeout(pending.timer)
    try {
      pending.resolve(JSON.parse(result))
    } catch (e) {
      pending.reject(e)
    }
  }
  // 一个 TCP 段里可能粘了多个 length-delimited 包：
  // 只解第一个就把 buf 清空，会把后面的响应整包丢掉，对应的 sendMessage 永远不返回
  private onSocketData(chunk: Buffer) {
    this.buf =
      this.buf.length > 0 ? Buffer.concat([this.buf, chunk]) : chunk
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
          // 长度前缀已经错位，丢弃缓冲重新同步
          this.buf = Buffer.alloc(0)
          return
        }
      } while (byte & 0x80)

      if (this.buf.length - pos < len) return // 包体还没收全，等下一个 chunk
      const body = this.buf.subarray(pos, pos + len)
      this.buf = this.buf.subarray(pos + len)
      try {
        this.handleFrame(wire.com.devicedock.server.Response.decode(body))
      } catch (e) {
        logger.error('decode response failed', e)
      }
    }
  }
  private failAllPending(e: any) {
    for (const [, pending] of this.resolves) {
      clearTimeout(pending.timer)
      pending.reject(e)
    }
    this.resolves.clear()
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
      // 先登记再绑事件：下面所有回调都用 this.socket === socket 判断自己是否已被顶替
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
      this.socket = socket
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
      // 不吞异常：调用方需要知道是「设备掉了 / dex 没推上去」，
      // 否则后面 this.socket.write 只会报 null 的 TypeError
      if (!this.socket) throw e
    }
  }
  private isRunning = singleton(async () => {
    const result: string = await shell(this.deviceId, `cat /proc/net/unix`)
    return contain(result, '@devicedock')
  })
  private async push() {
    logger.info('push')
    // adb push 不会自动建父目录：/data/local/tmp/devicedock 不存在时 dex 推不上去，
    // 应用名/图标全走 dex，界面就是空列表（老设备第一次用最容易踩到）
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
    // 这条连接用来拉起 server，之后不再需要：挂上空 error 监听并消费数据，
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

// 应用名/图标只跟「包 + versionCode」有关：缓存后二次打开应用页只需要 pm list，
// 升级/新装的包才重新走 dex。体积每次都用 diskstats 覆盖，不会显示旧占用。
const pkgInfoCache = new Map<string, { ver: string; info: IPackageInfo }>()
const verCache = new Map<string, { ts: number; map: Map<string, string> | null }>()

// 预热：设备连上后提前把 dex 服务拉起来（冷启动约 1.2s），
// 用户点开「应用」时不用再等这一步
export async function prewarm(deviceId: string) {
  try {
    const client = await getDeviceClient(deviceId)
    await client.warm()
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
  const hit = verCache.get(deviceId)
  // 应用很少变；装/卸/升级由 clearPackageCaches 主动失效，这里放宽到 5 分钟
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.map

  let map: Map<string, string> | null = null
  try {
    const out = await shell(deviceId, 'pm list packages --show-versioncode')
    const parsed = new Map<string, string>()
    for (const line of String(out).split('\n')) {
      const m = line.match(/^package:(\S+)(?:\s+versionCode:(\d+))?/)
      if (!m) continue
      parsed.set(m[1], m[2] || '')
    }
    // 老系统不支持 --show-versioncode：拿不到版本号就停用缓存，避免升级后图标/名字不更新
    map = [...parsed.values()].some((v) => v) ? parsed : null
  } catch {
    map = null
  }
  verCache.set(deviceId, { ts: Date.now(), map })

  if (map) {
    const prefix = deviceId + '|'
    for (const [key, entry] of pkgInfoCache) {
      if (!key.startsWith(prefix)) continue
      const ver = map.get(key.slice(prefix.length))
      if (ver === undefined || ver !== entry.ver) pkgInfoCache.delete(key)
    }
  }
  return map
}

const getPackageInfos: IpcGetPackageInfos = async function (
  deviceId,
  packageNames
) {
  const versions = await getPackageVersions(deviceId)
  const result: Array<IPackageInfo | null> = new Array(packageNames.length).fill(
    null
  )
  const misses: string[] = []
  const missIdx: number[] = []

  for (let i = 0; i < packageNames.length; i++) {
    const pkg = packageNames[i]
    const key = deviceId + '|' + pkg
    const ver = versions ? versions.get(pkg) : undefined
    const hit = ver !== undefined ? pkgInfoCache.get(key) : undefined
    if (hit && hit.ver === ver) {
      // 拷一份：下面会用最新 diskstats 覆盖体积，不能改到缓存对象
      result[i] = { ...hit.info }
    } else {
      misses.push(pkg)
      missIdx.push(i)
    }
  }

  if (misses.length) {
    const client = await getDeviceClient(deviceId)
    const { packageInfos } = await client.sendMessage('getPackageInfos', {
      packageNames: misses,
    })
    const fetched: IPackageInfo[] = packageInfos || []
    const idxByName = new Map<string, number[]>()
    for (let j = 0; j < misses.length; j++) {
      const list = idxByName.get(misses[j]) || []
      list.push(missIdx[j])
      idxByName.set(misses[j], list)
    }
    for (const info of fetched) {
      if (!info || !info.packageName) continue
      if (versions) {
        pkgInfoCache.set(deviceId + '|' + info.packageName, {
          ver: versions.get(info.packageName) || '',
          info: { ...info },
        })
      }
      for (const i of idxByName.get(info.packageName) || []) {
        result[i] = { ...info }
      }
    }
  }

  const list = result.filter(Boolean) as IPackageInfo[]
  if (!list.length) return list

  const serverPort = await getFileServerPort(deviceId)
  for (const info of list) {
    if (info.icon) info.icon = await getFileUrl(deviceId, info.icon, serverPort)
  }

  // diskstats 有 10 秒缓存，每次刷新都覆盖体积；失败时保留缓存里的旧值
  let packageDiskStats: types.PlainObj<any> = {}
  try {
    packageDiskStats = await getPackageDiskStats(deviceId)
  } catch (e) {
    logger.warn('getPackageDiskStats failed', e)
  }
  for (const info of list) {
    if (info.packageName && packageDiskStats[info.packageName]) {
      extend(info, packageDiskStats[info.packageName])
    } else if (isUndef(info.appSize)) {
      info.appSize = 0
      info.dataSize = 0
      info.cacheSize = 0
    }
  }
  return list
}

const getPackageDiskStats = async function (deviceId: string) {
  // 应用页是分批（50 个包）取详情的：没有缓存的话，600 个包每次刷新要跑 12 次 dumpsys diskstats
  const cache = diskStatsCache.get(deviceId)
  if (cache && Date.now() - cache.ts < 10000) return cache.stats
  const diskStats = await shell(deviceId, 'dumpsys diskstats')
  const packageDiskStats: types.PlainObj<{
    appSize: number
    dataSize: number
    cacheSize: number
  }> = {}

  const packageNames: string[] = []
  const appSizes: string[] = []
  const dataSizes: string[] = []
  const cacheSizes: string[] = []

  function parseLine(line: string, prefix: string, arr: string[]) {
    if (!startWith(line, prefix)) {
      return
    }
    line = line.slice(prefix.length)
    arr.push(...JSON.parse(line))
  }
  each(diskStats.split('\n'), (line) => {
    parseLine(line, 'Package Names:', packageNames)
    parseLine(line, 'App Sizes:', appSizes)
    parseLine(line, 'App Data Sizes:', dataSizes)
    parseLine(line, 'Cache Sizes:', cacheSizes)
  })
  for (let i = 0, len = packageNames.length; i < len; i++) {
    const name = packageNames[i]
    packageDiskStats[name] = {
      appSize: toNum(appSizes[i]),
      dataSize: toNum(dataSizes[i]),
      cacheSize: toNum(cacheSizes[i]),
    }
  }

  diskStatsCache.set(deviceId, { ts: Date.now(), stats: packageDiskStats })
  return packageDiskStats
}

const getFileServerPort = singleton(async function (deviceId): Promise<number> {
  const client = await getDeviceClient(deviceId)
  let port = getDeviceStore(deviceId, 'fileServerPort')
  if (port) {
    const { running } = await client.sendMessage('isFileServerRunning')
    if (running) {
      return port
    }
  }
  const result = await client.sendMessage('startFileServer')
  port = await forwardTcp(deviceId, `tcp:${result.port}`)
  setDeviceStore(deviceId, 'fileServerPort', port)
  return port
})

const getFileUrl: IpcGetFileUrl = async function (deviceId, path, port) {
  if (!port) {
    port = await getFileServerPort(deviceId)
  }

  return `http://127.0.0.1:${port}${encodeURI(path)}`
}

export async function init(c: Client) {
  client = c

  handleEvent('getPackageInfos', getPackageInfos)
  handleEvent('getFileUrl', getFileUrl)
}
