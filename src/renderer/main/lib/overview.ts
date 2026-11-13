/**
 * getOverview 的 15 秒缓存：侧栏设备卡、文件页状态栏、概览页都会各调一次，
 * 不缓存的话同一台设备会连续跑几轮 dumpsys（切页/重挂载时最明显）。
 */
const cache = new Map<string, { ts: number; data: any }>()
const TTL = 15000

export async function getOverview(deviceId: string, force = false) {
  const hit = cache.get(deviceId)
  if (!force && hit && Date.now() - hit.ts < TTL) {
    return hit.data
  }

  const data = await main.getOverview(deviceId)
  cache.set(deviceId, { ts: Date.now(), data })
  return data
}

export function clearOverview(deviceId?: string) {
  if (deviceId) {
    cache.delete(deviceId)
  } else {
    cache.clear()
  }
}
