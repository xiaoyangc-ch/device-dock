import { spawnAdb } from './adb/base'
import { handleEvent } from 'share/main/lib/util'
import log from 'share/common/log'
import { IpcMeasureLatency } from 'common/types'

const logger = log('latency')

// 测量一次 adb shell 往返耗时（隧道 RTT）
const measure: IpcMeasureLatency = async function (deviceId) {
  try {
    const t0 = Date.now()
    const r = await spawnAdb(['-s', deviceId, 'shell', 'echo', 'ok'])
    const ms = Date.now() - t0
    if (r.code !== 0) return { ms: -1 }
    return { ms }
  } catch (e: any) {
    logger.error('measure failed', e)
    return { ms: -1 }
  }
}

export function init() {
  handleEvent('measureLatency', measure)
}
