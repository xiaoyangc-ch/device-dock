import { observer } from 'mobx-react-lite'
import Style from './Graph.module.scss'
import LunaPerformanceMonitor from 'luna-performance-monitor/react'
import store from '../store'
import { colorPrimary, colorPrimaryDark } from 'common/theme'
import { t } from '../../../common/i18n'
import { useCallback, useEffect, useRef } from 'react'

export default observer(function Graph() {
  // 曲线数据源用 ref：每次采样更新不能触发 React 重渲染，
  // 渲染由 LunaPerformanceMonitor 自己按帧画
  const dataRef = useRef({ cpu: 0, mem: 0 })

  const cpuData = useCallback(() => +dataRef.current.cpu.toFixed(1), [])
  const memData = useCallback(
    () => +(dataRef.current.mem / 1024 / 1024).toFixed(2),
    []
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let alive = true

    async function sample() {
      timer = null
      const { cpu, memory } = await main.getCpuAndMem()
      if (!alive) return
      dataRef.current.cpu = cpu
      dataRef.current.mem = memory
      // 用 setTimeout 串行采样：主进程卡住时不会堆积多个请求
      timer = setTimeout(sample, 2000)
    }

    sample()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [])

  const color = store.theme === 'dark' ? colorPrimaryDark : colorPrimary

  return (
    <div className={Style.graphPane}>
      <LunaPerformanceMonitor
        title="CPU"
        data={cpuData}
        theme={store.theme}
        color={color}
        height={50}
        unit="%"
      />
      <LunaPerformanceMonitor
        title={t('memory')}
        data={memData}
        theme={store.theme}
        color={color}
        height={50}
        unit="GB"
      />
    </div>
  )
})
