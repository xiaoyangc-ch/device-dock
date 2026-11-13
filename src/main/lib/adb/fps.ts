/**
 * 帧率：优先用 SurfaceFlinger 的 flips 差分；拿不到时按层名查 --latency。
 *
 * dumpsys SurfaceFlinger 输出几 MB，远程链路上要几百毫秒：
 * 同一设备 900ms 内复用结果，并发调用合并成一次。
 */
import { shell, getDeviceStore, setDeviceStore } from './base'
import { handleEvent } from 'share/main/lib/util'
import { IpcGetFps } from 'common/types'

const CACHE_MS = 900
const cache = new Map<string, { at: number; fps: number }>()
const inFlight = new Map<string, Promise<number>>()

const getFps: IpcGetFps = async (deviceId, pkg) => {
  const key = `${deviceId}|${pkg || ''}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.fps

  const running = inFlight.get(key)
  if (running) return running

  const task = computeFps(deviceId, pkg)
    .then((fps) => {
      cache.set(key, { at: Date.now(), fps })
      return fps
    })
    .finally(() => inFlight.delete(key))

  inFlight.set(key, task)
  return task
}

async function computeFps(deviceId: string, pkg: string) {
  const result = String(await shell(deviceId, 'dumpsys SurfaceFlinger'))
  const matched = result.match(/flips=(\d+)/)
  if (!matched) return getFpsByLatency(deviceId, pkg)

  const flips = Number(matched[1]) || 0
  const time = Date.now()
  const storeKey = `flips-${pkg || 'total'}`
  const last = getDeviceStore(deviceId, storeKey)

  let fps = 0
  if (last) {
    const elapsed = time - last.time
    if (elapsed > 0) fps = Math.round(((flips - last.flips) * 1000) / elapsed)
  }
  setDeviceStore(deviceId, storeKey, { time, flips })
  return fps
}

/** SurfaceFlinger 不输出 flips 时，按包名找层，再用 --latency 的时间戳算帧率。 */
async function getFpsByLatency(deviceId: string, pkg: string) {
  if (!pkg) return 0

  const list = String(await shell(deviceId, 'dumpsys SurfaceFlinger --list'))
  let layers = list.split('\n').filter((line) => line.includes(pkg))
  if (!layers.length) return 0

  layers = layers.map((raw) => {
    let layer = raw
    if (layer.startsWith('RequestedLayerState{')) {
      layer = layer.slice('RequestedLayerState{'.length)
      // 层名后面跟着 parentId/z 等字段，截到第一个字段之前
      for (const key of [
        'parentId=',
        'relativeParentId=',
        'mirrorId=',
        'z=',
        'layerStack=',
      ]) {
        const index = layer.indexOf(key)
        if (index >= 0) {
          layer = layer.slice(0, index - 1)
          break
        }
      }
      if (layer.endsWith('}')) layer = layer.slice(0, -1)
    }
    return layer
  })

  // 这些层不是应用画面，算进去会把帧率拉低
  const EXCLUDED = [
    'ActivityRecordInputSink',
    'Background for SurfaceView',
    'ActivityRecord',
    'Bounds for -',
  ]
  layers = layers.filter(
    (layer) => !EXCLUDED.some((content) => layer.includes(content))
  )

  // 层名来自设备端应用，可能含 $(...)/反引号：单引号转义后再拼命令
  const quote = (value: string) => "'" + String(value).replace(/'/g, "'\\''") + "'"
  const latencies = (await shell(
    deviceId,
    layers.map((layer) => `dumpsys SurfaceFlinger --latency ${quote(layer)}`)
  )) as string[]

  let best = 0
  for (const raw of latencies) {
    const timestamps: number[] = []
    for (const line of String(raw).trim().split('\n')) {
      const matched = line.match(/(\d+)\s+(\d+)\s+(\d+)/)
      if (matched) timestamps.push(Number(matched[2]) / 1e9)
    }
    // 最后一个时间戳往往是当前未完成的帧，去掉
    timestamps.pop()

    if (timestamps.length > 1) {
      const seconds = timestamps[timestamps.length - 1] - timestamps[0]
      if (seconds > 0) {
        best = Math.max(best, Math.round((timestamps.length - 1) / seconds))
      }
    }
  }
  return best
}

export async function init() {
  handleEvent('getFps', getFps)
}
