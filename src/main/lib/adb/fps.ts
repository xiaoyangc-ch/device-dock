import { shell, getDeviceStore, setDeviceStore } from './base'
import toNum from 'licia/toNum'
import now from 'licia/now'
import filter from 'licia/filter'
import map from 'licia/map'
import isEmpty from 'licia/isEmpty'
import each from 'licia/each'
import contain from 'licia/contain'
import max from 'licia/max'
import last from 'licia/last'
import trim from 'licia/trim'
import { handleEvent } from 'share/main/lib/util'
import { IpcGetFps } from 'common/types'
import startWith from 'licia/startWith'
import endWith from 'licia/endWith'

// dumpsys SurfaceFlinger 是这里最贵的命令（输出几 MB，远程链路上要几百毫秒）：
// 同一设备 900ms 内复用结果，并把并发调用合并成一次
const cache = new Map<string, { ts: number; fps: number }>()
const inFlight = new Map<string, Promise<number>>()

const getFps: IpcGetFps = async function (deviceId, pkg) {
  const key = `${deviceId}|${pkg || ''}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < 900) return hit.fps
  const running = inFlight.get(key)
  if (running) return running
  const task = computeFps(deviceId, pkg)
    .then((fps) => {
      cache.set(key, { ts: Date.now(), fps })
      return fps
    })
    .finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

async function computeFps(deviceId: string, pkg: string) {
  let fps = 0

  const result: string = await shell(deviceId, 'dumpsys SurfaceFlinger')
  const match = result.match(/flips=(\d+)/)
  if (match) {
    const flips = toNum(match[1])
    const time = now()
    const storeKey = `flips-${pkg || 'total'}`
    const lastFlips = getDeviceStore(deviceId, storeKey)
    if (lastFlips) {
      fps = Math.round(
        ((flips - lastFlips.flips) * 1000) / (time - lastFlips.time)
      )
    }
    setDeviceStore(deviceId, storeKey, {
      time,
      flips,
    })

    return fps
  } else {
    fps = await getFpsByLatency(deviceId, pkg)
  }

  return fps
}

async function getFpsByLatency(deviceId: string, pkg: string) {
  const fps = 0

  if (!pkg) {
    return fps
  }

  const list = await shell(deviceId, 'dumpsys SurfaceFlinger --list')
  let layers = filter(list.split('\n'), (line) => contain(line, pkg))
  if (isEmpty(layers)) {
    return fps
  }

  layers = map(layers, (layer) => {
    if (startWith(layer, 'RequestedLayerState{')) {
      layer = layer.replace('RequestedLayerState{', '')
      const keys = [
        'parentId=',
        'relativeParentId=',
        'mirrorId=',
        'z=',
        'layerStack=',
      ]
      for (const key of keys) {
        if (contain(layer, key)) {
          layer = layer.slice(0, layer.indexOf(key) - 1)
          break
        }
      }
      if (endWith(layer, '}')) {
        layer = layer.slice(0, -1)
      }
    }
    return layer
  })

  layers = filter(layers, (layer) => {
    let result = true

    each(
      [
        'ActivityRecordInputSink',
        'Background for SurfaceView',
        'ActivityRecord',
        'Bounds for -',
      ],
      (content) => {
        if (contain(layer, content)) {
          result = false
        }
      }
    )

    return result
  })

  // 层名来自设备端应用，可能含 $(...)/反引号：必须单引号转义后再拼命令
  const quote = (v: string) => "'" + String(v).replace(/'/g, "'\\''") + "'"
  const latencies = await shell(
    deviceId,
    map(layers, (layer) => {
      return `dumpsys SurfaceFlinger --latency ${quote(layer)}`
    })
  )
  const allFps = map(latencies, (latency) => {
    latency = trim(latency)
    let fps = 0
    const timestamps: number[] = []
    each(latency.split('\n'), (line) => {
      const match = line.match(/(\d+)\s+(\d+)\s+(\d+)/)
      if (match) {
        timestamps.push(toNum(match[2]) / 1e9)
      }
    })
    timestamps.pop()

    if (timestamps.length > 1) {
      const seconds = last(timestamps) - timestamps[0]
      if (seconds > 0) {
        fps = Math.round((timestamps.length - 1) / seconds)
      }
    }
    return fps
  })

  // 层列表为空时 max() 没有参数会返回 undefined，界面就成了 NaN
  return allFps.length ? max(...allFps) : 0
}

export async function init() {
  handleEvent('getFps', getFps)
}
