import { useEffect, useState } from 'react'

/**
 * 延迟探测：3 秒一次；窗口不可见时降到 15 秒，切回前台立刻补一次。
 */
export default function useLatency(deviceId: string) {
  const [ms, setMs] = useState<number | null>(null)

  useEffect(() => {
    setMs(null)
    if (!deviceId) return

    let alive = true
    let timer: ReturnType<typeof setTimeout>
    let running = false

    const tick = async () => {
      if (running) return
      running = true
      try {
        const result = await main.measureLatency(deviceId)
        if (alive) setMs(result.ms)
      } catch {
        if (alive) setMs(-1)
      } finally {
        running = false
      }
      if (alive) timer = setTimeout(tick, document.hidden ? 15000 : 3000)
    }
    tick()

    const onVisibility = () => {
      if (document.hidden) return
      // 回到前台立刻刷新一次，别等下一个 15 秒
      clearTimeout(timer)
      tick()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      alive = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [deviceId])

  return ms
}
