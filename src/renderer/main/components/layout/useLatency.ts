import { useEffect, useState } from 'react'

// 侧栏设备卡/页头共用：延迟探测按 3 秒一次，窗口不可见时降频。
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
        const r = await main.measureLatency(deviceId)
        if (alive) setMs(r.ms)
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
