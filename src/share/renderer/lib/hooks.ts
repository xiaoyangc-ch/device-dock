import { RefObject, useEffect } from 'react'
import ResizeSensor from 'licia/ResizeSensor'

export function useWindowResize(resizeCallback: () => void) {
  useEffect(() => {
    window.addEventListener('resize', resizeCallback)
    return () => window.removeEventListener('resize', resizeCallback)
  }, [])
}

/** 容器尺寸变化（侧栏折叠、面板拖动）：window resize 捕获不到。 */
export function useResizeSensor(
  containerRef: RefObject<HTMLElement | null>,
  resizeCallback: () => void
) {
  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const sensor = new ResizeSensor(element)
    sensor.addListener(resizeCallback)
    return () => sensor.destroy()
  }, [])
}
