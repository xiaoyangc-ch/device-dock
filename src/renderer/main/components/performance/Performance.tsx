/**
 * 性能页：CPU 总量/分核、内存、FPS 三条曲线 + 电池/开机时长。
 *
 * 采样 1 秒一次，全部请求并行并等齐（allSettled）：
 * 远程比 1 秒慢时不能继续叠任务，否则设备侧会堆几百条 dumpsys。
 */
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useRef, useState } from 'react'
import store from '../../store'
import LunaPerformanceMonitor from 'luna-performance-monitor/react'
import {
  green4,
  green4Dark,
  green6,
  green6Dark,
  orange6,
  orange6Dark,
  purple6,
  purple6Dark,
} from 'common/theme'
import { t } from 'common/util'
import Style from './Performance.module.scss'
import durationFormat from 'licia/durationFormat'
import PageToolbar, {
  Page,
  PageBody,
  ToolSpace,
  ToolText,
} from '../layout/PageToolbar'
import isEmpty from 'licia/isEmpty'
import extend from 'licia/extend'

interface ICpuProps {
  dataRef: any
  index: number
}

const Cpu = observer(function (props: ICpuProps) {
  const cpuData = useCallback(() => {
    const load = props.dataRef.current.cpuLoads[props.index] ?? 0
    return Math.floor(load * 100)
  }, [])

  const isDark = store.theme === 'dark'
  // dumpsys 解析残缺时 cpus 与 cpuLoads 长度可能不一致：
  // 索引不到按 0 处理，别让整个面板崩掉
  const speed = props.dataRef.current.cpus[props.index]?.speed ?? 0

  return (
    <LunaPerformanceMonitor
      title={`CPU${props.index} ${speed}MHz`}
      data={cpuData}
      theme={store.theme}
      max={100}
      height={50}
      color={isDark ? green4Dark : green4}
      unit="%"
    />
  )
})

export default observer(function Performance() {
  const [uptime, setUptime] = useState(0)

  // 曲线数据源用 ref：每秒更新不能触发 React 重渲染，
  // 由 LunaPerformanceMonitor 自己按帧画
  const dataRef = useRef({
    topPackage: { name: '', label: '', pid: 0 },
    memUsed: 0,
    memTotal: 0,
    batteryLevel: 0,
    batteryTemperature: 0,
    batteryVoltage: 0,
    cpuLoads: [] as number[],
    cpus: [] as any[],
    cpuTemperature: 0,
    fps: 0,
  })

  const memData = useCallback(
    () => Math.round(dataRef.current.memUsed / 1024 / 1024),
    []
  )
  const cpuData = useCallback(() => {
    const loads = dataRef.current.cpuLoads
    if (isEmpty(loads)) return 0

    let total = 0
    for (const load of loads) total += load
    return Math.floor((total / loads.length) * 100)
  }, [])
  const fpsData = useCallback(() => dataRef.current.fps, [])

  const { device } = store

  useEffect(() => {
    let destroyed = false
    let tick = 0
    let busy = false

    async function sample() {
      // 窗口不可见时没必要每秒跑 4 条远程命令
      if (document.hidden) {
        if (!destroyed) setTimeout(sample, 15000)
        return
      }

      if (device && store.panel === 'performance' && !busy) {
        busy = true
        try {
          const jobs: Promise<any>[] = [
            main.getUptime(device.id).then(setUptime),
            main
              .getPerformance(device.id)
              .then((data) => extend(dataRef.current, data)),
            main.getTopPackage(device.id).then(async (topPackage) => {
              extend(dataRef.current.topPackage, topPackage)
              if (!topPackage.name) return

              const infos = await main.getPackageInfos(device.id, [
                topPackage.name,
              ])
              if (infos?.[0]) {
                dataRef.current.topPackage.label = infos[0].label
              }
            }),
          ]

          // FPS 要跑 dumpsys SurfaceFlinger：2 秒一次就够
          if (tick++ % 2 === 0) {
            jobs.push(
              main
                .getFps(device.id, dataRef.current.topPackage.name)
                .then((fps) => {
                  dataRef.current.fps = fps
                })
            )
          }

          // 单条命令失败（设备掉线/进程退出）不影响其它指标
          await Promise.allSettled(jobs)
        } finally {
          busy = false
        }
      }

      if (!destroyed) setTimeout(sample, 1000)
    }

    sample()

    return () => {
      destroyed = true
    }
  }, [device?.id, device?.type])

  const isDark = store.theme === 'dark'
  const data = dataRef.current

  const batteryLevel = data.batteryLevel + '%'
  const batteryInfo = `${(data.batteryVoltage / 1000).toFixed(2)}V ${(
    data.batteryTemperature / 10
  ).toFixed(1)}°C`

  return (
    <Page>
      <PageToolbar>
        <ToolText mono>
          {t('uptime')} {durationFormat(uptime, 'd:hh:mm:ss')}
        </ToolText>
        <ToolSpace />
        <div className={Style.batteryContainer}>
          <span className={Style.batteryInfo}>{batteryInfo}</span>
          <span className={Style.batteryLevel}>{batteryLevel}</span>
          <div className={Style.battery}>
            <div className={Style.batteryHead} />
            <div
              className={Style.batteryInside}
              style={{ width: batteryLevel }}
            />
          </div>
        </div>
      </PageToolbar>
      <PageBody className={Style.charts}>
        <LunaPerformanceMonitor
          title={
            data.cpuTemperature > 0
              ? `CPU ${data.cpuTemperature}°C`
              : 'CPU --'
          }
          data={cpuData}
          theme={store.theme}
          max={100}
          color={isDark ? green6Dark : green6}
          height={80}
          unit="%"
        />
        <div className={Style.cpuContainer}>
          {data.cpuLoads.map((_load, index) => (
            <Cpu key={index} index={index} dataRef={dataRef} />
          ))}
        </div>
        <LunaPerformanceMonitor
          title={`${t('memory')} ${
            data.memUsed
              ? Math.round((data.memUsed / data.memTotal) * 100) + '%'
              : ''
          }`}
          data={memData}
          theme={store.theme}
          smooth={false}
          color={isDark ? purple6Dark : purple6}
          height={80}
          unit="MB"
        />
        <LunaPerformanceMonitor
          title={`FPS ${data.topPackage.label}`}
          data={fpsData}
          theme={store.theme}
          smooth={false}
          height={80}
          color={isDark ? orange6Dark : orange6}
        />
      </PageBody>
    </Page>
  )
})
