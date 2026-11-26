/**
 * 设备管理层：枚举、属性、概览、截屏、连接/配对、adb server 生命周期。
 *
 * 这里只做「设备」这一层的事，具体功能（文件/应用/日志/终端）在 adb/ 子目录里。
 * 设备属性按 60 秒缓存：列表刷新很频繁，但型号/系统版本几乎不变。
 */
import { app } from 'electron'
import Adb, { Client, Device } from '@devicefarmer/adbkit'
import androidDeviceList from 'android-device-list'
import {
  resolveResources,
  handleEvent,
  getUserDataPath,
} from 'share/main/lib/util'
import * as window from 'share/main/lib/window'
import fs from 'fs-extra'
import path from 'node:path'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import sleep from 'licia/sleep'
import { getSettingsStore } from './store'
import * as base from './adb/base'
import { ensureAdbServer, shell, getAdbPath, spawnAdb } from './adb/base'
import * as webCast from './webCast'
import * as logcat from './adb/logcat'
import * as shellAdb from './adb/shell'
import * as server from './adb/server'
import { scanLan } from './lanScan'
import { scanHostPorts, cancelPortScan } from './portScan'
import * as packageAdb from './adb/package'
import * as file from './adb/file'
import * as fps from './adb/fps'
import * as port from './adb/port'
import { getCpuLoads, getCpus, getCpuTemperature } from './adb/cpu'
import {
  findProp,
  parseIpAndMac,
  parseMemory,
  parseScreen,
  parseStorage,
  parseWifiSsid,
} from './adb/deviceParse'
import log from 'share/common/log'
import {
  IpcCancelPortScan,
  IpcConnectDevice,
  IpcDisconnectDevice,
  IpcGetDevices,
  IpcInputKey,
  IpcPairDevice,
  IpcScanDevicePorts,
  IpcScreencap,
  IpcScreencapRaw,
} from 'common/types'

const logger = log('adb')
const settingsStore = getSettingsStore()

let client: Client

/** 设备属性缓存：60 秒内复用，设备增删/adb 重启时清空。 */
const deviceInfoCache = new Map<string, { at: number; info: any }>()
const DEVICE_INFO_TTL = 60 * 1000

/** 已预热过设备服务的设备，避免重复推 dex。 */
const prewarmed = new Set<string>()

/** 侧栏预览上一帧的哈希，画面没变就不重复解码。 */
const lastFrameHash = new Map<string, string>()

function schedulePrewarm(deviceId: string) {
  if (process.env.DEVICEDOCK_NO_PREWARM || prewarmed.has(deviceId)) return
  prewarmed.add(deviceId)
  // 别和启动时的设备枚举抢 adb
  setTimeout(() => {
    server.prewarm(deviceId)
  }, 5000)
}

// ---------------------------------------------------------------------------
// 设备列表
// ---------------------------------------------------------------------------

export const getDevices: IpcGetDevices = async () => {
  if (!client) return []

  const devices = (await client.listDevices()).filter(
    (device) => device.type !== 'unknown',
  )
  const firstOnline = devices.find(
    (device) => device.type === 'emulator' || device.type === 'device',
  )
  if (firstOnline) schedulePrewarm(firstOnline.id)

  return Promise.all(
    devices.map(async (device) => {
      const cached = deviceInfoCache.get(device.id)
      if (cached && Date.now() - cached.at < DEVICE_INFO_TTL) {
        return { ...cached.info, type: device.type }
      }
      if (device.type !== 'device' && device.type !== 'emulator') {
        return {
          id: device.id,
          type: device.type,
          serialno: '',
          name: device.id,
          androidVersion: '',
          sdkVersion: '',
        }
      }

      try {
        const properties = await client.getDevice(device.id).getProperties()
        const info = {
          id: device.id,
          type: device.type,
          serialno: properties['ro.serialno'] || '',
          name: listName(properties),
          androidVersion: properties['ro.build.version.release'],
          sdkVersion: properties['ro.build.version.sdk'],
        }
        deviceInfoCache.set(device.id, { at: Date.now(), info })
        return info
      } catch (e) {
        // 单台设备离线/未授权不能让整张列表消失
        logger.error('getProperties failed', device.id, e)
        if (cached) return { ...cached.info, type: device.type }
        return {
          id: device.id,
          type: device.type,
          serialno: '',
          name: device.id,
          androidVersion: '',
          sdkVersion: '',
        }
      }
    }),
  )
}

/** 列表里的设备名：厂商市场名优先，其次「厂商 型号」。 */
function listName(properties: Record<string, string>): string {
  const marketName = getMarketName(properties)
  if (marketName) return marketName
  const vendor = properties['ro.product.manufacturer'] || ''
  const model = properties['ro.product.model'] || ''
  return `${vendor} ${model}`.trim()
}

/** 概览页的设备名：市场名优先，其次设备内部名（保持原有显示习惯）。 */
function overviewName(properties: Record<string, string>): string {
  return getMarketName(properties) || properties['ro.product.name'] || ''
}

// ---------------------------------------------------------------------------
// 概览
// ---------------------------------------------------------------------------

export async function getOverview(deviceId: string) {
  const device = client.getDevice(deviceId)
  // 常规概览命令合并成 2 条批量 shell + 1 次 getProperties：
  // 每多一次 adb 往返，概览页就多几十毫秒
  const [properties, cpus, baseInfo, sysInfo] = await Promise.all([
    device.getProperties(),
    getCpus(deviceId, false),
    shell(
      deviceId,
      ['uname -r', 'settings get system font_scale', 'dumpsys wifi', 'ip addr'],
      30000,
    ) as Promise<string[]>,
    shell(
      deviceId,
      [
        'wm size',
        'wm density',
        'cat /proc/meminfo',
        'dumpsys diskstats',
        'df -k /data',
        'id',
      ],
      30000,
    ) as Promise<string[]>,
  ])
  const [kernelVersion, fontScale, wifi, ipOut] = baseInfo
  const [wmSize, wmDensity, memInfo, diskStats, dfInfo, idOut] = sysInfo

  const net = parseIpAndMac(ipOut)
  const screen = parseScreen(wmSize, wmDensity)
  const memory = parseMemory(memInfo)
  const storage = parseStorage(diskStats, dfInfo)

  return {
    name: overviewName(properties),
    processor: properties['ro.product.board'] || '',
    abi: properties['ro.product.cpu.abi'],
    brand: properties['ro.product.brand'],
    model: properties['ro.product.model'],
    serialno: properties['ro.serialno'] || '',
    cpuNum: cpus.length,
    kernelVersion,
    fontScale: fontScale === 'null' ? 0 : Number(fontScale) || 0,
    wifi: parseWifiSsid(wifi) || net.netType,
    ip: net.ip,
    mac: net.mac,
    root: String(idOut).includes('uid=0'),
    ...storage,
    ...memory,
    ...screen,
  }
}

async function getIpAndMac(deviceId: string) {
  return parseIpAndMac(await shell(deviceId, 'ip addr'))
}

async function getInputMethod(deviceId: string) {
  return String(
    await shell(deviceId, 'settings get secure default_input_method'),
  ).trim()
}

async function setFontScale(deviceId: string, scale: number) {
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 4) {
    throw new Error('字体缩放值必须在 0.5 到 4 之间')
  }
  await shell(deviceId, `settings put system font_scale ${scale}`)
}

/** 厂商市场名：各品牌自定义属性不同，按优先级取第一个有值的。 */
function getMarketName(properties: Record<string, string>): string {
  const keys = [
    'ro.product.marketname',
    'ro.product.vendor.marketname',
    'ro.vendor.product.marketname',
    'ro.config.hw_market_name',
    'ro.config.hw.marketname',
    'ro.oppo.market.name',
    'ro.config.marketing_name',
    'ro.vendor.oplus.market.enname',
    'ro.vivo.market.name',
    'ro.asus.product.mkt_name',
  ]
  for (const key of keys) {
    if (properties[key]) return properties[key]
  }

  const device = properties['ro.product.device']
  const model = properties['ro.product.model']
  const devices: any[] = androidDeviceList.getDevicesByDeviceId(device)
  if (!devices || !devices.length) return ''

  const exact = devices.find((item) => item.model === model)
  return exact ? exact.name : devices[0].name
}

// ---------------------------------------------------------------------------
// 性能 / 电池 / 运行时长
// ---------------------------------------------------------------------------

async function getPerformance(deviceId: string) {
  const cpus = await getCpus(deviceId)
  const [cpuLoads, cpuTemperature, memory, battery] = await Promise.all([
    getCpuLoads(deviceId, cpus),
    getCpuTemperature(deviceId),
    getMemory(deviceId),
    getBattery(deviceId),
  ])
  return { cpus, cpuLoads, cpuTemperature, ...memory, ...battery }
}

async function getUptime(deviceId: string) {
  const result = await shell(deviceId, 'cat /proc/uptime')
  const [uptime] = String(result).split(' ')
  return Math.round(Number(uptime) * 1000)
}

async function getBattery(deviceId: string) {
  const result = await shell(deviceId, 'dumpsys battery')
  return {
    batteryLevel: Number(findProp('level', result)) || 0,
    batteryTemperature: Number(findProp('temperature', result)) || 0,
    batteryVoltage: Number(findProp('voltage', result)) || 0,
  }
}

// ---------------------------------------------------------------------------
// 截屏
// ---------------------------------------------------------------------------

/**
 * adbd 卡住时 readAll 永不 settle，而侧栏每 4 秒发一次请求：
 * 没有超时就会攒下一堆挂死的 transport + PNG Buffer，必须带超时。
 */
async function readScreencap(deviceId: string, timeoutMs = 8000) {
  const device = await client.getDevice(deviceId)
  const socket: any = await device.screencap()
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      Adb.util.readAll(socket) as Promise<Buffer>,
      new Promise<Buffer>((_, reject) => {
        timer = setTimeout(() => {
          try {
            socket?.destroy?.(new Error('screencap timeout'))
          } catch {
            // ignore
          }
          reject(new Error('截屏超时'))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const screencap: IpcScreencap = async (deviceId) => {
  const buf = await readScreencap(deviceId)
  return buf.toString('base64')
}

/**
 * 侧栏预览：传原始字节给渲染层做 Blob URL，比 base64 少 1/3 体积；
 * 和上一帧完全一致时返回 null，渲染层不再解码重绘。
 */
const screencapRaw: IpcScreencapRaw = async (deviceId) => {
  try {
    // 只探测设备可用性：adb 重启/设备刚移除时下一轮再试，
    // 不要每秒抛一次 IPC 错误
    await client.getDevice(deviceId)
  } catch {
    return null
  }

  let buf: Buffer
  try {
    buf = await readScreencap(deviceId)
  } catch {
    // 侧栏预览：这一帧失败就跳过，下一轮再试，不要把 IPC 打红
    return null
  }
  const hash = createHash('md5').update(buf).digest('hex')
  if (lastFrameHash.get(deviceId) === hash) return null
  lastFrameHash.set(deviceId, hash)

  // Buffer 可能来自池化内存：切出精确区间再交给 IPC
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer
}

// ---------------------------------------------------------------------------
// 显示 / 内存 / 存储解析
// ---------------------------------------------------------------------------

async function getMemory(deviceId: string) {
  return parseMemory(await shell(deviceId, 'cat /proc/meminfo'))
}

// ---------------------------------------------------------------------------
// 连接 / 配对 / 端口扫描
// ---------------------------------------------------------------------------

function normalizeHost(host: string | undefined): string {
  return String(host || '')
    .trim()
    .replace(/:\d+$/, '')
}

async function waitDeviceOnline(
  host: string,
  port: number,
  timeoutMs = 8000,
): Promise<'device' | 'unauthorized' | null> {
  const target = `${host}:${port}`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const devices = await client.listDevices()
      const found = devices.find((d) => d.id === target)
      if (found && found.type === 'device') return 'device'
      if (found && found.type === 'unauthorized') return 'unauthorized'
    } catch {
      // adb server 忙/重启：继续轮询
    }
    await sleep(250)
  }
  return null
}

const connectDevice: IpcConnectDevice = async (host, port) => {
  const h = normalizeHost(host)
  if (!h) throw new Error('设备地址为空')
  const p = port || 5555
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error('设备端口必须在 1-65535 之间')
  }
  // adb connect 返回只代表命令被接受：设备可能还停在 offline，
  // 立刻刷新列表会看不到它，用户以为“扫到端口却没连上”
  await client.connect(h, p)
  const state = await waitDeviceOnline(h, p)
  if (state === 'unauthorized') {
    throw new Error('设备已连接，但尚未授权：请在手机上允许 USB/无线调试')
  }
  if (state !== 'device') {
    throw new Error('设备未上线：请确认已开启 ADB 调试并在手机上允许授权')
  }
}

const disconnectDevice: IpcDisconnectDevice = async (host, port) => {
  const h = normalizeHost(host)
  if (!h) throw new Error('设备地址为空')
  const p = port || 5555
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error('设备端口必须在 1-65535 之间')
  }
  await client.disconnect(h, p)
}

/** 当前设备端口扫描的取消令牌（扫描 + adb connect 复核都要能取消）。 */
let deviceScan: { cancelled: boolean } | null = null

const scanDevicePorts: IpcScanDevicePorts = async (host, deep) => {
  const h = normalizeHost(host)
  if (!h) throw new Error('设备地址为空')

  // portScan 的取消槽是单槽：新一轮开始前先取消上一轮，
  // 否则第二次扫描会盖掉第一次的 token，用户点「取消」只能取消新的那次
  cancelPortScan()
  const token = { cancelled: false }
  deviceScan = token

  // adb 已经记住的在线端口直接复用：有些定制 adbd 会拒绝裸 CNXN 握手
  try {
    const known: number[] = []
    for (const device of await client.listDevices()) {
      const matched = String(device.id || '').match(/^(.+):(\d+)$/)
      // 只复用真正在线的连接：offline 残留会让「扫本机 IP」秒回假端口
      if (matched && matched[1] === h && device.type === 'device') {
        known.push(Number(matched[2]))
      }
    }
    if (known.length) {
      const adbPorts = [...new Set(known)].sort((a, b) => a - b)
      logger.info('reuse known adb port', h, adbPorts)
      // 提前返回也要清 token，否则 deviceScan 永远指着这一次
      if (deviceScan === token) deviceScan = null
      return {
        ip: h,
        adbPorts,
        openPorts: adbPorts,
        scanned: 0,
        cancelled: false,
        durationMs: 0,
      }
    }
  } catch (e: any) {
    logger.warn('listDevices failed', e && e.message)
  }

  const result = await scanHostPorts(h, {
    deep,
    onProgress: (progress) =>
      window.sendTo('main', 'portScanProgress', progress),
  })

  // 裸握手判不出 ADB 的定制 adbd：用完整 adb connect 再确认一遍
  if (
    !result.cancelled &&
    !token.cancelled &&
    !result.adbPorts.length &&
    result.openPorts.length
  ) {
    const preferred = result.openPorts.filter(
      (p) => (p >= 5550 && p <= 5600) || (p >= 7500 && p <= 7600),
    )
    const candidates = (preferred.length ? preferred : result.openPorts).slice(
      0,
      3,
    )
    for (const port of candidates) {
      if (result.cancelled || token.cancelled) break
      try {
        // adb connect 对不可达端口可能卡十几秒：复核最多等 2.5 秒
        await Promise.race([
          client.connect(h, port).catch(() => undefined),
          sleep(2500),
        ])
        // 再用 online 轮询确认：connect 命令返回时设备往往还是 offline
        const state = await waitDeviceOnline(h, port, 2500)
        if (state === 'device' || state === 'unauthorized') {
          logger.info('adb connect fallback ok', h, port)
          result.adbPorts = [port]
          break
        }
      } catch (e: any) {
        logger.warn('adb connect fallback failed', h, port, e && e.message)
      }
    }
  }

  if (deviceScan === token) deviceScan = null
  return result
}

const cancelDevicePortScan: IpcCancelPortScan = async () => {
  if (deviceScan) deviceScan.cancelled = true
  cancelPortScan()
}

const pairDevice: IpcPairDevice = async (host, port, password) => {
  const target = normalizeHost(host)
  if (!target) throw new Error('设备地址为空')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('配对端口必须在 1-65535 之间')
  }
  if (!/^\d{6,12}$/.test(String(password))) {
    throw new Error('配对码格式不正确')
  }
  const { code, stdout, stderr } = await spawnAdb([
    'pair',
    `${target}:${port}`,
    password,
  ])
  const output = `${stdout}\n${stderr}`
  if (code !== 0 || !output.includes('Successfully')) {
    throw new Error(`Pair device failed: ${output.trim()}`)
  }
}

// ---------------------------------------------------------------------------
// 按键 / 终端 / root / 无线
// ---------------------------------------------------------------------------

const inputKey: IpcInputKey = async (deviceId, keyCode) => {
  if (!Number.isInteger(keyCode) || keyCode < 0) {
    throw new Error('非法按键码')
  }
  await base.shell(deviceId, `input keyevent ${keyCode}`)
}

async function openAdbCli() {
  let cwd = resolveResources('adb')
  const custom = settingsStore.get('adbPath')
  if (custom && custom.trim() !== '' && fs.existsSync(custom)) {
    cwd = path.dirname(custom)
  } else if (process.platform === 'win32') {
    // Windows 商店版权限问题：把 adb 目录复制到 userData 再开
    const newCwd = getUserDataPath('adb')
    if (!fs.existsSync(newCwd)) {
      await fs.copy(cwd, newCwd)
    }
    cwd = newCwd
  }

  if (process.platform === 'darwin') {
    const child = childProcess.spawn('open', ['-a', 'Terminal', cwd], {
      stdio: 'ignore',
    })
    child.unref()
  } else if (process.platform === 'win32') {
    const child = childProcess.exec('start cmd', { cwd })
    child.unref()
  } else {
    const child = childProcess.spawn('x-terminal-emulator', ['-w', cwd], {
      stdio: 'ignore',
    })
    child.unref()
  }
}

async function root(deviceId: string) {
  const id = await shell(deviceId, 'id')
  if (String(id).includes('uid=0')) return
  const device = await client.getDevice(deviceId)
  await device.root()
}

async function startWireless(deviceId: string) {
  const device = await client.getDevice(deviceId)
  const { ip } = await getIpAndMac(deviceId)
  const port = await device.tcpip(5555)
  await sleep(500)
  await connectDevice(ip, port)
}

async function restartAdbServer() {
  // kill-server 会把无线设备全部断开，USB 会自己回来，无线不会：
  // 先记下来，重启后逐台重连
  const wireless: Array<{ host: string; port: number }> = []
  try {
    for (const device of await client.listDevices()) {
      const matched = String(device.id || '').match(/^(.+):(\d+)$/)
      if (matched) {
        wireless.push({ host: matched[1], port: Number(matched[2]) })
      }
    }
  } catch (e: any) {
    logger.warn('listDevices before restart failed', e && e.message)
  }

  // 重启后属性/预热/预览帧全部失效，必须清
  deviceInfoCache.clear()
  prewarmed.clear()
  lastFrameHash.clear()
  // kill-server 会清掉所有 TCP forward：设备端文件服务的缓存端口随之失效，
  // 不清的话应用页图标会一直拿死端口去请求
  server.resetTransportCaches()

  await client.kill()
  await client.version()
  await sleep(800)

  const reconnect = async ({ host, port }: { host: string; port: number }) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await client.connect(host, port)
        return
      } catch (e: any) {
        if (attempt === 1) {
          logger.warn(
            'reconnect after restart failed',
            host,
            port,
            e && e.message,
          )
        } else {
          await sleep(1000)
        }
      }
    }
  }
  await Promise.all(wireless.map(reconnect))
}

// ---------------------------------------------------------------------------
// 初始化：设备跟踪 + IPC 注册
// ---------------------------------------------------------------------------

export async function init() {
  logger.info('init')

  await ensureAdbServer().catch((e) => {
    logger.error('prepare adb server failed', e)
  })

  app.on('will-quit', () => {
    if (!settingsStore.get('killAdbWhenExit')) return
    logger.info('kill adb')
    // will-quit 不会 await：必须同步杀，否则进程先退出、adb server 留下
    try {
      childProcess.spawnSync(getAdbPath(), ['kill-server'], {
        windowsHide: true,
        timeout: 5000,
      })
    } catch (e) {
      logger.error('kill adb failed', e)
    }
  })

  client = Adb.createClient({ bin: getAdbPath() })

  // 批量上线/adb 重启会连续收到多个 add：2 秒防抖，只刷新一次
  let changeTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleRefresh() {
    if (changeTimer) clearTimeout(changeTimer)
    changeTimer = setTimeout(() => {
      changeTimer = null
      window.sendAll('changeDevice')
    }, 2000)
  }

  function onDeviceAdded() {
    logger.info('device change')
    scheduleRefresh()
  }

  function onDeviceRemoved(deviceId: string) {
    logger.info('device removed', deviceId)
    webCast.stopWebCast(deviceId).catch(() => {})
    base.deleteDeviceStore(deviceId)
    base.clearProcessCaches(deviceId)
    server.clearPackageCaches(deviceId)
    // 按 deviceId 建表的缓存都要清：file 的全盘索引/stat 缓存（单设备可达 30 万条）、
    // 应用图标（内存 + disk），否则无线设备换个端口重连就留下一份永久驻留的旧数据
    file.clearDeviceCaches(deviceId)
    packageAdb.clearIconCache(deviceId)
    prewarmed.delete(deviceId)
    deviceInfoCache.delete(deviceId)
    lastFrameHash.delete(deviceId)
    scheduleRefresh()
  }

  // tracker 断开后要重建：原实现 end 和 error 各起一个定时器，
  // 两边同时触发会挂出两个 tracker，这里收敛成单一重连入口
  let trackerRetry: ReturnType<typeof setTimeout> | null = null
  function scheduleTracker(delay: number) {
    if (trackerRetry) return
    trackerRetry = setTimeout(() => {
      trackerRetry = null
      track()
    }, delay)
  }

  async function track() {
    logger.info('track devices')
    try {
      const tracker = await client.trackDevices()
      tracker.on('add', onDeviceAdded)
      // unauthorized → device（用户在手机上点“允许调试”）只会发 change，不发 add；
      // 不订阅的话，扫描连上后列表一直不刷新，看起来就是“扫到端口但没连上”
      tracker.on('change', onDeviceAdded)
      tracker.on('remove', (device: Device) => onDeviceRemoved(device.id))
      tracker.on('error', () => {
        logger.error('tracker error')
        scheduleTracker(3000)
      })
      tracker.on('end', () => {
        logger.info('tracker end')
        scheduleTracker(2000)
      })
    } catch (e) {
      logger.error('track error', e)
      scheduleTracker(3000)
    }
  }

  track()

  base.init(client)
  logcat.init(client)
  shellAdb.init(client)
  server.init(client)
  packageAdb.init(client)
  file.init(client)
  fps.init()
  port.init(client)

  handleEvent('getDevices', getDevices)
  handleEvent('scanLanDevices', () =>
    scanLan((progress) => window.sendTo('main', 'lanScanProgress', progress)),
  )
  handleEvent('scanDevicePorts', scanDevicePorts)
  handleEvent('cancelPortScan', cancelDevicePortScan)
  handleEvent('getOverview', getOverview)
  handleEvent('setFontScale', setFontScale)
  handleEvent('getInputMethod', getInputMethod)
  handleEvent('screencap', screencap)
  handleEvent('screencapRaw', screencapRaw)
  handleEvent('getPerformance', getPerformance)
  handleEvent('getUptime', getUptime)
  handleEvent('connectDevice', connectDevice)
  handleEvent('disconnectDevice', disconnectDevice)
  handleEvent('inputKey', inputKey)
  handleEvent('openAdbCli', openAdbCli)
  handleEvent('root', root)
  handleEvent('startWireless', startWireless)
  handleEvent('restartAdbServer', restartAdbServer)
  handleEvent('pairDevice', pairDevice)
}
