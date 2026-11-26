/**
 * 设备端服务客户端（devicedock.dex）+ 应用信息/文件服务。
 *
 * 协议：设备上跑 `com.devicedock.server.Server`，监听 localabstract:devicedock；
 * 请求/响应是 protobuf 的 length-delimited 消息（Request{id,method,params} /
 * Response{id,result}），params/result 都是 JSON 字符串。
 *
 * 所有连接都按设备缓存，设备移除时由 base.deleteDeviceStore 调 dispose()。
 */
import { randomUUID } from 'node:crypto'
import { Client } from '@devicefarmer/adbkit'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import wire from '../wire'
import waitUntil from 'licia/waitUntil'
import { forwardTcp, getDeviceStore, setDeviceStore, shell } from './base'
import log from 'share/common/log'
import { IPackageInfo, IpcGetFileUrl, IpcGetPackageInfos } from 'common/types'
import { encodeDevicePath } from './filePath'
import { normalizeDevicePath } from 'common/guards'
import { LruCache } from 'common/lru'
import { parsePackageListing } from './packageParse'
import {
  buildPackageDumpCommand,
  IPackageDumpInfo,
  normalizePackageTimestamp,
  parsePackageDump,
} from './packageDump'
import { packageLabelFallback } from './packageLabel'
import pkg from '../../../../package.json'
import { isDeviceServerCompatible } from './deviceProtocol'

const logger = log('server')

let client: Client

interface DeviceRequestMap {
  getVersion: {
    params: Record<string, never>
    result: { version: string; protocolVersion: number }
  }
  shutdown: {
    params: Record<string, never>
    result: { ok: boolean }
  }
  getPackageInfos: {
    params: { packageNames: string[] }
    result: { packageInfos: IPackageInfo[] }
  }
  startFileServer: {
    params: Record<string, never>
    result: { port: number; token: string }
  }
  isFileServerRunning: {
    params: Record<string, never>
    result: { running: boolean }
  }
  allowFile: {
    params: { path: string; token: string }
    result: { allowed: boolean }
  }
}

type DeviceMethod = keyof DeviceRequestMap
type DeviceParams<M extends DeviceMethod> = DeviceRequestMap[M]['params']
type DeviceResult<M extends DeviceMethod> = DeviceRequestMap[M]['result']

const REQUEST_TIMEOUTS: Partial<Record<DeviceMethod, number>> = {
  getVersion: 5000,
  getPackageInfos: 30000,
  startFileServer: 15000,
}
const MAX_FRAME_BYTES = 8 * 1024 * 1024

// ---------------------------------------------------------------------------
// 设备服务连接
// ---------------------------------------------------------------------------

class DeviceClient {
  private deviceId: string
  private socket: any = null
  private buf: Buffer = Buffer.alloc(0)
  private connecting: Promise<void> | null = null
  private verifying: Promise<void> | null = null
  private verified = false
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: unknown) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  constructor(deviceId: string) {
    this.deviceId = deviceId
  }

  async warm() {
    await this.ensureReady()
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

  async sendMessage<M extends DeviceMethod>(
    method: M,
    params: DeviceParams<M>,
  ): Promise<DeviceResult<M>> {
    await this.ensureReady()
    return this.request(method, params)
  }

  private request<M extends DeviceMethod>(
    method: M,
    params: DeviceParams<M>,
    timeoutMs = REQUEST_TIMEOUTS[method] || 10000,
  ): Promise<DeviceResult<M>> {
    if (!this.socket) throw new Error('设备服务未连接：' + this.deviceId)

    const id = randomUUID()
    this.socket.write(
      wire.com.devicedock.server.Request.encodeDelimited({
        id,
        method,
        params: JSON.stringify(params),
      }).finish(),
    )

    // 设备端不回包时不能把 IPC 永久挂住
    return new Promise<DeviceResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('设备服务响应超时: ' + method))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => resolve(value as DeviceResult<M>),
        reject,
        timer,
      })
    })
  }

  private async ensureReady() {
    await this.ensureConnected()
    if (this.verified && this.socket) return
    if (this.verifying) return this.verifying

    this.verifying = (async () => {
      let info: DeviceRequestMap['getVersion']['result'] | null = null
      try {
        info = await this.request('getVersion', {})
      } catch (e) {
        logger.warn('device service version probe failed', e)
      }
      if (isDeviceServerCompatible(info, pkg.version)) {
        this.verified = true
        return
      }
      await this.restart(
        info
          ? `版本不匹配 desktop=${pkg.version} device=${String(
              info.version,
            )} protocol=${String(info.protocolVersion)}`
          : '无法读取设备服务版本',
      )
    })().finally(() => {
      this.verifying = null
    })
    return this.verifying
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

      if (len < 0 || len > MAX_FRAME_BYTES) {
        logger.error(`设备服务响应帧异常: ${len} bytes`)
        this.dispose()
        return
      }
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
    this.verified = false
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
          this.verified = false
          this.buf = Buffer.alloc(0)
          this.failAllPending(e || new Error('设备服务连接错误'))
        }
      })
      socket.on('end', () => {
        if (this.socket === socket) {
          this.socket = null
          this.verified = false
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

  private async restart(reason: string) {
    logger.warn(`restart device service: ${reason}`)
    let graceful = false
    try {
      await this.request('shutdown', {}, 2000)
      graceful = true
    } catch {
      // 4.0.2 及更早的设备端没有 shutdown，下面按进程名兜底
    }
    this.dispose()

    if (!graceful) await new Promise((resolve) => setTimeout(resolve, 100))
    await shell(
      this.deviceId,
      `for p in /proc/[0-9]*; do pid=$(basename "$p"); [ "$pid" = "$$" ] && continue; cmd=$(tr '\\000' ' ' < "$p/cmdline" 2>/dev/null); case "$cmd" in *app_process*com.devicedock.server.Server*) kill -9 "$pid" 2>/dev/null;; esac; done; sleep 0.3`,
      10000,
    ).catch(() => undefined)

    await this.push()
    await this.start()
    await waitUntil(this.isRunning, 10000, 100)
    await this.connect(false)

    const info = await this.request('getVersion', {})
    if (!isDeviceServerCompatible(info, pkg.version)) {
      this.dispose()
      throw new Error(
        `设备服务重启后版本仍不匹配：desktop=${pkg.version} device=${String(
          info.version,
        )} protocol=${String(info.protocolVersion)}`,
      )
    }
    this.verified = true
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
      '/data/local/tmp/devicedock/devicedock.dex',
    )
  }

  private async start() {
    logger.info('start')
    const device = client.getDevice(this.deviceId)
    const stream: any = await device.shell(
      'CLASSPATH=/data/local/tmp/devicedock/devicedock.dex app_process /system/bin com.devicedock.server.Server',
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

export async function getDeviceServerInfo(deviceId: string) {
  const deviceClient = await getDeviceClient(deviceId)
  await deviceClient.warm()
  return deviceClient.sendMessage('getVersion', {})
}

// ---------------------------------------------------------------------------
// 应用信息（名称/版本/图标）
// ---------------------------------------------------------------------------

/** 应用名/图标只跟「包 + versionCode」有关；升级/新装由 clearPackageCaches 失效。 */
const pkgInfoCache = new LruCache<string, { ver: string; info: IPackageInfo }>({
  maxEntries: 2000,
})
const verCache = new Map<
  string,
  { at: number; map: Map<string, string> | null }
>()
interface IHostPackageMeta {
  apkPath: string
  versionCode: string
}
const hostMetaCache = new Map<
  string,
  { at: number; map: Map<string, IHostPackageMeta> | null }
>()
const hostMetaPending = new Map<
  string,
  Promise<Map<string, IHostPackageMeta> | null>
>()
const HOST_META_TTL = 5 * 60 * 1000
const HOST_META_FAILURE_TTL = 10 * 1000
const hostDetailCache = new Map<
  string,
  { at: number; map: Map<string, IPackageDumpInfo> }
>()
const pkgInfoDexBackoff = new Map<string, number>()
const PKG_INFO_RETRY_MS = 60 * 1000

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
  hostMetaCache.delete(deviceId)
  hostDetailCache.delete(deviceId)
  pkgInfoDexBackoff.delete(deviceId)
  const prefix = deviceId + '|'
  for (const key of [...pkgInfoCache.keys()]) {
    if (key.startsWith(prefix)) pkgInfoCache.delete(key)
  }
}

/**
 * 麒麟 Android 6 的设备端 IPackageManager 反射可能失败。
 * 此时用 dumpsys 批量补齐版本、安装时间和 SDK，避免界面长期显示 0/1970。
 */
async function getHostPackageDetails(deviceId: string, packageNames: string[]) {
  const cached = hostDetailCache.get(deviceId)
  const map =
    cached && Date.now() - cached.at < HOST_META_TTL
      ? new Map(cached.map)
      : new Map<string, IPackageDumpInfo>()
  const missing = [...new Set(packageNames)].filter((name) => !map.has(name))

  for (let i = 0; i < missing.length; i += 50) {
    const names = missing.slice(i, i + 50)
    const command = buildPackageDumpCommand(names)
    if (!command) continue
    try {
      const output = await shell(deviceId, command, 20000)
      for (const [name, info] of parsePackageDump(output)) {
        map.set(name, info)
      }
    } catch (e) {
      logger.debug('getHostPackageDetails failed', e)
      break
    }
  }
  hostDetailCache.set(deviceId, { at: Date.now(), map })
  return map
}

/**
 * 一次取回所有包的 APK 路径和版本号。
 * 这是设备端 dex 失败时的兜底，避免应用列表少项、导出按钮拿到空路径。
 */
async function getHostPackageMeta(
  deviceId: string,
): Promise<Map<string, IHostPackageMeta> | null> {
  const cached = hostMetaCache.get(deviceId)
  if (cached) {
    const ttl = cached.map ? HOST_META_TTL : HOST_META_FAILURE_TTL
    if (Date.now() - cached.at < ttl) return cached.map
  }

  const running = hostMetaPending.get(deviceId)
  if (running) return running

  const task = (async () => {
    let map: Map<string, IHostPackageMeta> | null = null
    for (const command of [
      'pm list packages -f --show-versioncode',
      'pm list packages -f',
    ]) {
      try {
        const entries = parsePackageListing(await shell(deviceId, command))
        if (!entries.length) continue
        map = new Map(
          entries.map((entry) => [
            entry.name,
            { apkPath: entry.path, versionCode: entry.versionCode },
          ]),
        )
        break
      } catch {
        // Huawei/旧固件可能不认识组合选项：继续尝试不带版本号的格式
      }
    }
    hostMetaCache.set(deviceId, { at: Date.now(), map })
    return map
  })().finally(() => hostMetaPending.delete(deviceId))

  hostMetaPending.set(deviceId, task)
  return task
}

async function getPackageVersions(
  deviceId: string,
): Promise<Map<string, string> | null> {
  const cached = verCache.get(deviceId)
  // 应用很少变；装/卸/升级主动失效，这里放宽到 5 分钟
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.map

  let map: Map<string, string> | null = null
  try {
    const metadata = await getHostPackageMeta(deviceId)
    const parsed = new Map<string, string>()
    for (const [name, entry] of metadata || []) {
      parsed.set(name, entry.versionCode)
    }
    // 老系统不支持 --show-versioncode：拿不到版本号就停用缓存，
    // 否则升级后图标/名字永远不更新
    map = [...parsed.values()].some(Boolean) ? parsed : null
  } catch {
    map = null
  }
  verCache.set(deviceId, { at: Date.now(), map })

  // 版本号变了的包：清掉旧信息，下次重新问 dex
  if (map) {
    const prefix = deviceId + '|'
    for (const [key, entry] of pkgInfoCache.entries()) {
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
  const result: Array<IPackageInfo | null> = new Array(
    packageNames.length,
  ).fill(null)
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
    const [deviceClient, hostMeta, hostDetails] = await Promise.all([
      getDeviceClient(deviceId),
      getHostPackageMeta(deviceId).catch(() => null),
      getHostPackageDetails(deviceId, misses).catch(
        () => new Map<string, IPackageDumpInfo>(),
      ),
    ])
    let fetched: IPackageInfo[] = []
    if ((pkgInfoDexBackoff.get(deviceId) || 0) <= Date.now()) {
      try {
        const response = await deviceClient.sendMessage('getPackageInfos', {
          packageNames: misses,
        })
        fetched = response.packageInfos || []
        if (fetched.length) {
          pkgInfoDexBackoff.delete(deviceId)
        } else {
          pkgInfoDexBackoff.set(deviceId, Date.now() + PKG_INFO_RETRY_MS)
        }
      } catch (e) {
        // dex 在 Huawei/老 ART 上可能整体不可用；有 pm 兜底时仍应显示完整列表
        pkgInfoDexBackoff.set(deviceId, Date.now() + PKG_INFO_RETRY_MS)
        logger.warn('getPackageInfos dex failed, using pm fallback', e)
      }
    }

    const fetchedByName = new Map<string, IPackageInfo>()
    for (const info of fetched) {
      if (info?.packageName) fetchedByName.set(info.packageName, info)
    }

    for (let j = 0; j < misses.length; j++) {
      const pkg = misses[j]
      const info = fetchedByName.get(pkg)
      const meta = hostMeta?.get(pkg)
      const detail = hostDetails.get(pkg)
      const apkPath =
        (typeof info?.apkPath === 'string' && info.apkPath) ||
        meta?.apkPath ||
        ''
      const system = /^\/(?:system|system_ext|vendor|product|odm|apex)\//.test(
        apkPath,
      )
      const normalized: IPackageInfo = {
        packageName: pkg,
        label:
          typeof info?.label === 'string' && info.label
            ? info.label
            : packageLabelFallback(pkg),
        icon: typeof info?.icon === 'string' ? info.icon : '',
        enabled: info?.enabled !== false,
        versionName:
          typeof info?.versionName === 'string' && info.versionName
            ? info.versionName
            : detail?.versionName || '',
        apkPath,
        apkSize: Number(info?.apkSize) || 0,
        system: typeof info?.system === 'boolean' ? info.system : system,
        firstInstallTime:
          normalizePackageTimestamp(info?.firstInstallTime) ||
          normalizePackageTimestamp(detail?.firstInstallTime),
        lastUpdateTime:
          normalizePackageTimestamp(info?.lastUpdateTime) ||
          normalizePackageTimestamp(detail?.lastUpdateTime),
        minSdkVersion: Number.isFinite(Number(info?.minSdkVersion))
          ? Number(info?.minSdkVersion)
          : detail?.minSdkVersion,
        targetSdkVersion: Number.isFinite(Number(info?.targetSdkVersion))
          ? Number(info?.targetSdkVersion)
          : detail?.targetSdkVersion,
        dataSize: Number(info?.dataSize) || 0,
        cacheSize: Number(info?.cacheSize) || 0,
        appSize: Number(info?.appSize) || 0,
        signatures: Array.isArray(info?.signatures) ? info.signatures : [],
      }
      result[missIndexes[j]] = normalized

      // 只缓存 dex 完整结果；纯 pm 兜底下次仍会重试，避免 dex 恢复后永远缺图标/名称
      if (info && versions) {
        pkgInfoCache.set(`${deviceId}|${pkg}`, {
          ver: versions.get(pkg) || '',
          info: { ...normalized },
        })
      }
    }
  }

  const list = result.filter(Boolean) as IPackageInfo[]
  if (!list.length) return list

  // 图标是设备端文件服务的 URL：先拿一次端口，整批复用
  let serverInfo: FileServerInfo | undefined
  try {
    serverInfo = await getFileServerInfo(deviceId)
  } catch (e) {
    logger.warn('file server unavailable', e)
  }
  if (serverInfo) {
    for (const info of list) {
      if (info.icon) {
        info.icon = fileServerUrl(serverInfo, info.icon)
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

const diskStatsCache = new Map<
  string,
  { at: number; stats: Record<string, any> }
>()
const DISK_STATS_TTL = 10 * 1000

async function getPackageDiskStats(deviceId: string) {
  const cached = diskStatsCache.get(deviceId)
  if (cached && Date.now() - cached.at < DISK_STATS_TTL) return cached.stats

  const out = String(await shell(deviceId, 'dumpsys diskstats'))
  const stats: Record<
    string,
    { appSize: number; dataSize: number; cacheSize: number }
  > = {}

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
interface FileServerInfo {
  port: number
  token: string
}

const fileServerPorts = new Map<string, FileServerInfo>()

/**
 * adb kill-server 会把所有 TCP forward 清掉，但设备端的 app_process 还活着，
 * isFileServerRunning 走的是 localabstract、看不出 forward 已经没了——
 * 缓存里的端口会变成死链，图标 URL 全部 404。重启 adb 前后必须清掉。
 */
export function resetTransportCaches() {
  fileServerPorts.clear()
  diskStatsCache.clear()
}

function fileServerUrl(info: FileServerInfo, path: string) {
  return `http://127.0.0.1:${info.port}${encodeDevicePath(path)}?token=${encodeURIComponent(
    info.token,
  )}`
}

async function getFileServerInfo(deviceId: string): Promise<FileServerInfo> {
  const cached = fileServerPorts.get(deviceId)
  if (cached) {
    try {
      const deviceClient = await getDeviceClient(deviceId)
      const { running } = await deviceClient.sendMessage(
        'isFileServerRunning',
        {},
      )
      if (running) return cached
    } catch {
      // 服务已经挂了：下面重新起
    }
    fileServerPorts.delete(deviceId)
  }

  const deviceClient = await getDeviceClient(deviceId)
  const result = await deviceClient.sendMessage('startFileServer', {})
  const token = String(result.token || '')
  const remotePort = Number(result.port)
  if (!token || !Number.isInteger(remotePort) || remotePort <= 0) {
    throw new Error('设备文件服务启动结果无效')
  }
  const port = await forwardTcp(deviceId, `tcp:${result.port}`)
  const info = { port, token }
  fileServerPorts.set(deviceId, info)
  return info
}

const getFileUrl: IpcGetFileUrl = async (deviceId, path) => {
  path = normalizeDevicePath(path)
  const info = await getFileServerInfo(deviceId)
  const deviceClient = await getDeviceClient(deviceId)
  const result = await deviceClient.sendMessage('allowFile', {
    path,
    token: info.token,
  })
  if (!result.allowed) throw new Error('设备拒绝预览该文件')
  return fileServerUrl(info, path)
}

export async function init(c: Client) {
  client = c

  handleEvent('getPackageInfos', getPackageInfos)
  handleEvent('getFileUrl', getFileUrl)
}
