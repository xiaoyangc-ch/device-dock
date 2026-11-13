import { app } from 'electron'
import Adb, { Client, Device } from '@devicefarmer/adbkit'
import androidDeviceList from 'android-device-list'
import {
  resolveResources,
  handleEvent,
  getUserDataPath,
} from 'share/main/lib/util'
import map from 'licia/map'
import types from 'licia/types'
import filter from 'licia/filter'
import isStrBlank from 'licia/isStrBlank'
import trim from 'licia/trim'
import startWith from 'licia/startWith'
import toNum from 'licia/toNum'
import contain from 'licia/contain'
import * as window from 'share/main/lib/window'
import fs from 'fs-extra'
import { getSettingsStore } from './store'
import isWindows from 'licia/isWindows'
import isEmpty from 'licia/isEmpty'
import * as base from './adb/base'
import * as webCast from './webCast'
import { shell, getAdbPath, spawnAdb } from './adb/base'
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
import path from 'node:path'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import isMac from 'licia/isMac'
import sleep from 'licia/sleep'

const logger = log('adb')

const settingsStore = getSettingsStore()

let client: Client

const prewarmed = new Set<string>()
function schedulePrewarm(deviceId: string) {
  // 排障开关：DEVICEDOCK_NO_PREWARM=1 可关掉预热做 A/B
  if (process.env.DEVICEDOCK_NO_PREWARM || prewarmed.has(deviceId)) return
  prewarmed.add(deviceId)
  // 别和启动时的设备枚举抢 adb
  setTimeout(() => {
    server.prewarm(deviceId)
  }, 5000)
}

// 型号/系统版本基本不变：设备列表每次刷新都拉一遍 getProperties 是 10 台设备 × 几百行属性。
// 60 秒内复用；设备移除/重启 adb 时清空。
const deviceInfoCache = new Map<string, { ts: number; info: any }>()
const DEVICE_INFO_TTL = 60000

const getDevices: IpcGetDevices = async function () {
  let devices = await client.listDevices()
  devices = filter(
    devices,
    (device: Device) => device.type === 'emulator' || device.type === 'device'
  )
  if (devices.length) {
    schedulePrewarm(devices[0].id)
  }

  return Promise.all(
    map(devices, async (device: Device) => {
      const cached = deviceInfoCache.get(device.id)
      if (cached && Date.now() - cached.ts < DEVICE_INFO_TTL) {
        return { ...cached.info, type: device.type }
      }
      try {
        const properties = await client.getDevice(device.id).getProperties()

        let name = `${properties['ro.product.manufacturer']} ${properties['ro.product.model']}`
        const marketName = getMarketName(properties)
        if (marketName) {
          name = marketName
        }

        const info = {
          id: device.id,
          type: device.type,
          serialno: properties['ro.serialno'] || '',
          name,
          androidVersion: properties['ro.build.version.release'],
          sdkVersion: properties['ro.build.version.sdk'],
        }
        deviceInfoCache.set(device.id, { ts: Date.now(), info })
        return info
      } catch (e) {
        // 单台设备离线/未授权不能让整张列表消失（原来 Promise.all 的 .catch 直接返回 []）
        logger.error('getProperties failed', device.id, e)
        // 失败时退回上一次的名称：离线设备也不至于从「型号名」变成一串 IP
        if (cached) {
          return { ...cached.info, type: device.type }
        }
        return {
          id: device.id,
          type: device.type,
          serialno: '',
          name: device.id,
          androidVersion: '',
          sdkVersion: '',
        }
      }
    })
  )
}

async function getOverview(deviceId: string) {
  const device = client.getDevice(deviceId)
  // 概览原来要 9 次 adb shell 往返（uname/font_scale/wifi/ip addr/wm×2/meminfo/diskstats/id）。
  // 合并成两条批量 shell + 一次 getProperties，概览页和侧栏分辨率的加载速度能快一截。
  const [properties, cpus, baseInfo, sysInfo] = await Promise.all([
    device.getProperties(),
    getCpus(deviceId, false),
    shell(
      deviceId,
      ['uname -r', 'settings get system font_scale', 'dumpsys wifi', 'ip addr'],
      30000
    ) as Promise<string[]>,
    shell(
      deviceId,
      ['wm size', 'wm density', 'cat /proc/meminfo', 'dumpsys diskstats', 'id'],
      30000
    ) as Promise<string[]>,
  ])
  const [kernelVersion, fontScale, wifi, ipOut] = baseInfo
  const [wmSize, wmDensity, memInfo, diskStats, idOut] = sysInfo

  let ssidMatch = wifi.match(/mWifiInfo\s+SSID: "?(.+?)"?,/)
  if (ssidMatch && ssidMatch[1] === '<unknown ssid>') {
    ssidMatch = null
  }

  const net = parseIpAndMac(ipOut)
  const screen = parseScreen(wmSize, wmDensity)
  const memory = parseMemory(memInfo)
  const storage = parseStorage(diskStats)

  return {
    name: getMarketName(properties) || properties['ro.product.name'],
    processor: properties['ro.product.board'] || '',
    abi: properties['ro.product.cpu.abi'],
    brand: properties['ro.product.brand'],
    model: properties['ro.product.model'],
    serialno: properties['ro.serialno'] || '',
    cpuNum: cpus.length,
    kernelVersion,
    fontScale: fontScale === 'null' ? 0 : toNum(fontScale),
    wifi: ssidMatch ? ssidMatch[1] : net.netType,
    ip: net.ip,
    mac: net.mac,
    root: contain(idOut, 'uid=0'),
    ...storage,
    ...memory,
    ...screen,
  }
}

function parseIpAndMac(out: string) {
  const blocks = out.split(/\n(?=\d+: )/)
  let ip = ''
  let mac = ''
  let netType = ''

  const pick = (name: string) =>
    blocks.find((b) => new RegExp(`^\\d+: ${name}[:@]`).test(b))
  const usable = (b?: string) => !!b && /inet (?!127\.)/.test(b)

  let target = pick('wlan0')
  if (usable(target)) {
    netType = '无线网络'
  } else {
    target = pick('eth0')
    if (usable(target)) {
      netType = '有线网络'
    } else {
      target = blocks.find((b) => !/^1: lo/.test(b) && /inet (?!127\.)/.test(b))
      if (target) netType = '网络'
    }
  }

  if (target) {
    const ipMatch = target.match(/inet (\d+\.\d+\.\d+\.\d+)/)
    const macMatch = target.match(
      /link\/ether (([0-9A-Fa-f]{2}:){5}([0-9A-Fa-f]{2}))/
    )
    if (ipMatch) ip = ipMatch[1]
    if (macMatch) mac = macMatch[1]
  }

  return {
    ip,
    mac,
    netType,
  }
}

async function getIpAndMac(deviceId: string) {
  return parseIpAndMac(await shell(deviceId, 'ip addr'))
}

async function getInputMethod(deviceId: string) {
  const out = await shell(deviceId, 'settings get secure default_input_method')
  return out.trim()
}

async function setFontScale(deviceId: string, scale: number) {
  await shell(deviceId, `settings put system font_scale ${scale}`)
}

function getMarketName(properties: types.PlainObj<string>) {
  const keys = [
    // Oppo
    'ro.oppo.market.name',
    // Huawei, Honor
    'ro.config.marketing_name',
    // OnePlus, Realme
    'ro.vendor.oplus.market.enname',
    // Vivo
    'ro.vivo.market.name',
    // Xiaomi, Redmi
    'ro.product.marketname',
    // Asus
    'ro.asus.product.mkt_name',
  ]
  for (let i = 0, len = keys.length; i < len; i++) {
    const key = keys[i]
    if (properties[key]) {
      return properties[key]
    }
  }

  const device = properties['ro.product.device']
  const model = properties['ro.product.model']

  let marketName = ''

  const devices: any[] = androidDeviceList.getDevicesByDeviceId(device)
  if (!isEmpty(devices)) {
    const deviceFilter = filter(devices, (device) => device.model === model)
    if (!isEmpty(deviceFilter)) {
      marketName = deviceFilter[0].name
    } else {
      marketName = devices[0].name
    }
  }

  return marketName
}

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
  const [uptime] = result.split(' ')
  return Math.round(toNum(uptime) * 1000)
}

async function getBattery(deviceId: string) {
  const result = await shell(deviceId, 'dumpsys battery')

  return {
    batteryLevel: toNum(getPropValue('level', result)),
    batteryTemperature: toNum(getPropValue('temperature', result)),
    batteryVoltage: toNum(getPropValue('voltage', result)),
  }
}

const screencap: IpcScreencap = async function (deviceId) {
  const device = await client.getDevice(deviceId)
  const data = await device.screencap()
  const buf = await Adb.util.readAll(data)

  return buf.toString('base64')
}

// 侧栏每 4 秒抓一张：传原始字节给渲染层做 Blob URL，比 base64 少 1/3 体积；
// 画面和上一帧完全一致时返回 null，渲染层不再解码/重绘（静态桌面最常见）
const lastFrameHash = new Map<string, string>()
const screencapRaw: IpcScreencapRaw = async function (deviceId) {
  let device
  try {
    device = await client.getDevice(deviceId)
  } catch {
    // adb 重启/设备刚移除：预览下一轮再试，不要每秒钟抛一次 IPC 错误
    return null
  }
  const data = await device.screencap()
  const buf = await Adb.util.readAll(data)
  const hash = createHash('md5').update(buf).digest('hex')
  if (lastFrameHash.get(deviceId) === hash) {
    return null
  }
  lastFrameHash.set(deviceId, hash)
  // Buffer 可能来自池化的底层内存：切出精确区间再交给 IPC
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

function parseScreen(wmSize: string, wmDensity: string) {
  const physicalResolution = getPropValue('Physical size', wmSize)
  const physicalDensity = getPropValue('Physical density', wmDensity)

  const hasOverrideResolution = contain(wmSize, 'Override')
  const hasOverrideDensity = contain(wmDensity, 'Override')
  const resolution = hasOverrideResolution
    ? getPropValue('Override size', wmSize)
    : physicalResolution
  const density = hasOverrideDensity
    ? getPropValue('Override density', wmDensity)
    : physicalDensity

  return {
    resolution,
    physicalResolution,
    density,
    physicalDensity,
  }
}

async function getMemory(deviceId: string) {
  return parseMemory(await shell(deviceId, 'cat /proc/meminfo'))
}

function parseMemory(memInfo: string) {
  let memTotal = 0
  let memFree = 0

  const totalMatch = getPropValue('MemTotal', memInfo)
  let freeMatch = getPropValue('MemAvailable', memInfo)
  if (!freeMatch) {
    freeMatch = getPropValue('MemFree', memInfo)
  }
  if (totalMatch && freeMatch) {
    memTotal = parseInt(totalMatch, 10) * 1024
    memFree = parseInt(freeMatch, 10) * 1024
  }

  return {
    memTotal,
    memUsed: memTotal - memFree,
  }
}

function parseStorage(storageInfo: string) {
  let storageTotal = 0
  let storageFree = 0

  const match = storageInfo.match(new RegExp('Data-Free: (\\d+)K / (\\d+)K'))
  if (match) {
    storageFree = parseInt(match[1], 10) * 1024
    storageTotal = parseInt(match[2], 10) * 1024
  }

  return {
    storageTotal,
    storageUsed: storageTotal - storageFree,
  }
}

function getPropValue(key: string, str: string) {
  const lines = str.split('\n')
  for (let i = 0, len = lines.length; i < len; i++) {
    const line = trim(lines[i])
    if (startWith(line, key)) {
      return trim(line.replace(/.*:/, ''))
    }
  }

  return ''
}

const connectDevice: IpcConnectDevice = async function (host, port) {
  // 端口留空是最常见的用法：adb 默认 5555；也兼容把 ip:port 整串粘进 IP 框
  const h = String(host || '')
    .trim()
    .replace(/:\d+$/, '')
  const p = port || 5555
  if (!h) throw new Error('设备地址为空')
  await client.connect(h, p)
}

const disconnectDevice: IpcDisconnectDevice = async function (host, port) {
  const h = String(host || '')
    .trim()
    .replace(/:\d+$/, '')
  const p = port || 5555
  if (!h) throw new Error('设备地址为空')
  await client.disconnect(h, p)
}

// 端口框留空时由这里兜底：先扫 ADB 常用段，扫不到再全端口找
let deviceScan: { cancelled: boolean } | null = null

const scanDevicePorts: IpcScanDevicePorts = async function (host, deep) {
  const h = String(host || '')
    .trim()
    .replace(/:\d+$/, '')
  if (!h) throw new Error('设备地址为空')
  // scanHostPorts 只覆盖端口探测阶段；扫描完成后的 adb connect 复核还要能被取消，
  // 否则用户点取消后最坏要再等 3×2.5 秒
  const token = { cancelled: false }
  deviceScan = token

  // 已经连过的设备 adb 自己记着端口，直接用它——有些定制 adbd 会拒绝新的裸 CNXN 握手，
  // 硬扫反而判不出来
  try {
    const devices = await client.listDevices()
    const known: number[] = []
    for (const device of devices) {
      const matched = String(device.id || '').match(/^(.+):(\d+)$/)
      // 只复用真正在线的连接：offline 的残留条目（上次 connect 失败的端口）
      // 会让「扫描本机 IP」秒回几组假 ADB 端口
      if (matched && matched[1] === h && device.type === 'device') {
        known.push(Number(matched[2]))
      }
    }
    if (known.length) {
      const adbPorts = [...new Set(known)].sort((a, b) => a - b)
      logger.info('reuse known adb port', h, adbPorts)
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

  // 裸 CNXN 握手只是快速判据：有些定制 adbd（或经端口转发/隧道）会直接关连接，
  // 端口明明开着却判不出 ADB，用户就看到「扫到 5555 却连不上」。
  // 这里用 adb connect 再确认一遍——它走完整协商，成功且状态为 device 才算数。
  if (
    !result.cancelled &&
    !token.cancelled &&
    !result.adbPorts.length &&
    result.openPorts.length
  ) {
    const quick = result.openPorts.filter(
      (p) => (p >= 5550 && p <= 5600) || (p >= 7500 && p <= 7600)
    )
    const candidates = (quick.length ? quick : result.openPorts).slice(0, 3)
    for (const port of candidates) {
      if (result.cancelled || token.cancelled) break
      try {
        // adb connect 对不可达端口可能卡十几秒：扫描复核最多等 2.5 秒
        await Promise.race([
          client.connect(h, port).catch(() => undefined),
          sleep(2500),
        ])
        await sleep(200)
        const devices = await client.listDevices()
        if (devices.some((d) => d.id === `${h}:${port}` && d.type === 'device')) {
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

const cancelDevicePortScan: IpcCancelPortScan = async function () {
  if (deviceScan) deviceScan.cancelled = true
  cancelPortScan()
}

const pairDevice: IpcPairDevice = async function (host, port, password) {
  const { stdout } = await spawnAdb(['pair', `${host}:${port}`, password])
  if (!contain(stdout, 'Successfully')) {
    throw new Error(`Pair device failed: ${stdout}`)
  }
}

const inputKey: IpcInputKey = async function (deviceId, keyCode) {
  await base.shell(deviceId, `input keyevent ${keyCode}`)
}

async function openAdbCli() {
  let cwd = resolveResources('adb')
  const adbPath = settingsStore.get('adbPath')
  if (!isStrBlank(adbPath) && fs.existsSync(adbPath)) {
    cwd = path.dirname(adbPath)
  } else if (isWindows) {
    // Microsoft store app permission issue workaround
    const newCwd = getUserDataPath('adb')
    if (!(await fs.existsSync(newCwd))) {
      await fs.copy(cwd, newCwd)
    }
    cwd = newCwd
  }

  if (isMac) {
    const child = childProcess.spawn('open', ['-a', 'Terminal', cwd], {
      stdio: 'ignore',
    })
    child.unref()
  } else if (isWindows) {
    const child = childProcess.exec('start cmd', {
      cwd,
    })
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
  if (contain(id, 'uid=0')) {
    return
  }
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
  // 重启前记下无线设备：adb kill-server 会把这些连接全部断掉，
  // USB 设备能自己回来，无线设备不会——不重连的话用户点一次「重启」就丢一片设备
  const wireless: Array<{ host: string; port: number }> = []
  try {
    const devices = await client.listDevices()
    for (const device of devices) {
      const matched = String(device.id || '').match(/^(.+):(\d+)$/)
      if (matched) {
        wireless.push({ host: matched[1], port: Number(matched[2]) })
      }
    }
  } catch (e: any) {
    logger.warn('listDevices before restart failed', e && e.message)
  }

  // adb server 重启后设备重新连接：属性缓存、预热标记、上一帧哈希都该失效，
  // 否则 aya server 不会重新预热、侧栏预览会误判为「画面没变」
  deviceInfoCache.clear()
  prewarmed.clear()
  lastFrameHash.clear()
  await client.kill()
  await client.version()
  await sleep(800)
  // 逐台重连，单台失败不影响其它设备；adb server 刚起来时第一次可能还没就绪，失败重试一次
  const reconnect = async ({ host, port }: { host: string; port: number }) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await client.connect(host, port)
        return
      } catch (e: any) {
        if (attempt === 1) {
          logger.warn('reconnect after restart failed', host, port, e && e.message)
        } else {
          await sleep(1000)
        }
      }
    }
  }
  await Promise.all(wireless.map(reconnect))
}

export async function init() {
  logger.info('init')

  app.on('will-quit', () => {
    if (settingsStore.get('killAdbWhenExit')) {
      logger.info('kill adb')
      // will-quit 不会 await 异步回调：必须同步杀，否则进程先退出、adb server 留下
      try {
        childProcess.spawnSync(getAdbPath(), ['kill-server'], {
          windowsHide: true,
          timeout: 5000,
        })
      } catch (e) {
        logger.error('kill adb failed', e)
      }
    }
  })

  client = Adb.createClient({
    bin: getAdbPath(),
  })
  async function track() {
    logger.info('track devices')
    try {
      const tracker = await client.trackDevices()
      tracker.on('add', onDeviceChange)
      tracker.on('remove', (device: Device) => {
        onDeviceRemoved(device.id)
      })
      tracker.on('error', () => {
        logger.error('tracker error')
      })
      tracker.on('end', async () => {
        logger.info('tracker end')
        await sleep(2000)
        track()
      })
    } catch (e) {
      logger.error('track error', e)
      // restartAdbServer / 设备拔出时 trackDevices 会直接 reject，
      // 原来只记日志：从此再也收不到设备增删事件，列表只能重启应用才更新
      setTimeout(() => track(), 3000)
    }
  }
  // 批量上线/一次 adb 重启会连续收到多个 add：每次都排一次 refresh 会让
  // 设备列表在 2 秒内刷新十几遍，每遍还要重新拉所有设备的属性
  let changeTimer: ReturnType<typeof setTimeout> | null = null
  function onDeviceChange() {
    logger.info('device change')
    if (changeTimer) clearTimeout(changeTimer)
    changeTimer = setTimeout(() => {
      changeTimer = null
      window.sendAll('changeDevice')
    }, 2000)
  }
  function onDeviceRemoved(deviceId: string) {
    logger.info('device removed', deviceId)
    // 设备真的走了：收掉投屏会话、清掉按设备缓存的 socket/端口/属性/预览帧
    webCast.stopWebCast(deviceId).catch(() => {})
    base.deleteDeviceStore(deviceId)
    server.clearPackageCaches(deviceId)
    prewarmed.delete(deviceId)
    deviceInfoCache.delete(deviceId)
    lastFrameHash.delete(deviceId)
    onDeviceChange()
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
  handleEvent('scanLanDevices', scanLan)
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
