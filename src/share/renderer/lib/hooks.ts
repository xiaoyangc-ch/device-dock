import { RefObject, useEffect, useRef } from 'react'
import ResizeSensor from 'licia/ResizeSensor'

export function useWindowResize(resizeCallback: () => void) {
  const callbackRef = useRef(resizeCallback)
  callbackRef.current = resizeCallback
  useEffect(() => {
    const listener = () => callbackRef.current()
    window.addEventListener('resize', listener)
    return () => window.removeEventListener('resize', listener)
  }, [])
}

/** 容器尺寸变化（侧栏折叠、面板拖动）：window resize 捕获不到。 */
export function useResizeSensor(
  containerRef: RefObject<HTMLElement | null>,
  resizeCallback: () => void
) {
  const callbackRef = useRef(resizeCallback)
  callbackRef.current = resizeCallback
  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const sensor = new ResizeSensor(element)
    sensor.addListener(() => callbackRef.current())
    return () => sensor.destroy()
  }, [])
}
