/**
 * 延迟测量：一次 adb shell 往返（echo ok）的毫秒数，作为隧道 RTT 的近似。
 */
import { spawnAdb } from './adb/base'
import { handleEvent } from 'share/main/lib/util'
import log from 'share/common/log'
import { IpcMeasureLatency } from 'common/types'

const logger = log('latency')

const measure: IpcMeasureLatency = async (deviceId) => {
  try {
    const started = Date.now()
    const result = await spawnAdb(['-s', deviceId, 'shell', 'echo', 'ok'])
    if (result.code !== 0) return { ms: -1 }
    return { ms: Date.now() - started }
  } catch (e: any) {
    logger.error('measure failed', e)
    return { ms: -1 }
  }
}

export function init() {
  handleEvent('measureLatency', measure)
}
