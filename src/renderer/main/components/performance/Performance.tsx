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
import sum from 'licia/sum'
import Style from './Performance.module.scss'
import durationFormat from 'licia/durationFormat'
import PageToolbar, {
  Page,
  PageBody,
  ToolSpace,
  ToolText,
} from '../layout/PageToolbar'
import isEmpty from 'licia/isEmpty'
import map from 'licia/map'
import extend from 'licia/extend'

export default observer(function Performance() {
  const [uptime, setUptime] = useState(0)
  const dataRef = useRef({
    topPackage: {
      name: '',
      label: '',
      pid: 0,
    },
    memUsed: 0,
    memTotal: 0,
    batteryLevel: 0,
    batteryTemperature: 0,
    batteryVoltage: 0,
    cpuLoads: [],
    cpus: [],
    cpuTemperature: 0,
    fps: 0,
  })

  const memData = useCallback(() => {
    return Math.round(dataRef.current.memUsed / 1024 / 1024)
  }, [])

  const cpuData = useCallback(() => {
    const cpuLoads = dataRef.current.cpuLoads
    if (isEmpty(cpuLoads)) {
      return 0
    }
    const cpuLoad = sum(...cpuLoads) / cpuLoads.length
    return Math.floor(cpuLoad * 100)
  }, [])

  const fpsData = useCallback(() => dataRef.current.fps, [])

  const { device } = store

  useEffect(() => {
    let destroyed = false
    let tick = 0
    let busy = false

    async function getPerformance() {
      // 窗口不可见时没必要每秒跑 4 条远程命令
      if (document.hidden) {
        if (!destroyed) setTimeout(getPerformance, 15000)
        return
      }
      if (device && store.panel === 'performance' && !busy) {
        busy = true
        try {
          // 所有请求放进同一批并行等待：远程比 1 秒慢时不能继续叠任务，
          // 否则每分钟会在设备侧堆几百条 dumpsys
          const jobs: Promise<any>[] = [
            main.getUptime(device.id).then(setUptime),
            main
              .getPerformance(device.id)
              .then((performance) => extend(dataRef.current, performance)),
            main.getTopPackage(device.id).then(async (topPackage) => {
              extend(dataRef.current.topPackage, topPackage)
              if (topPackage.name) {
                const packageInfos = await main.getPackageInfos(device.id, [
                  topPackage.name,
                ])
                if (packageInfos && packageInfos[0]) {
                  dataRef.current.topPackage.label = packageInfos[0].label
                }
              }
            }),
          ]
          // FPS 要跑 dumpsys SurfaceFlinger，每 2 秒一次就够
          if (tick++ % 2 === 0) {
            jobs.push(
              main
                .getFps(device.id, dataRef.current.topPackage.name)
                .then((fps) => {
                  dataRef.current.fps = fps
                })
            )
          }
          // allSettled：单条命令失败（设备掉线/进程退出）不影响其它指标
          await Promise.allSettled(jobs)
        } finally {
          busy = false
        }
      }
      if (!destroyed) {
        setTimeout(getPerformance, 1000)
      }
    }

    getPerformance()

    return () => {
      destroyed = true
    }
  }, [device?.id, device?.type])

  const isDark = store.theme === 'dark'

  const data = dataRef.current
  const batteryLevel = data.batteryLevel + '%'
  const batteryVoltage = `${(data.batteryVoltage / 1000).toFixed(2)}V`
  const batteryTemperature = `${data.batteryTemperature / 10}°C`
  const batteryInfo = `${batteryVoltage} ${batteryTemperature}`

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
          {map(data.cpuLoads, (load, idx) => (
            <Cpu key={idx} index={idx} dataRef={dataRef} load={load} />
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

interface ICpuProps {
  dataRef: any
  index: number
  load: number
}

const Cpu = observer(function (props: ICpuProps) {
  const cpuData = useCallback(() => {
    const cpuLoad = props.dataRef.current.cpuLoads[props.index] ?? 0
    return Math.floor(cpuLoad * 100)
  }, [])

  const isDark = store.theme === 'dark'
  // dumpsys 解析残缺时 cpus 与 cpuLoads 长度可能不一致，索引不到就按 0 处理，别让整个面板崩掉
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
