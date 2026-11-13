import sleep from 'licia/sleep'
import each from 'licia/each'
import map from 'licia/map'
import trim from 'licia/trim'
import toNum from 'licia/toNum'
import startWith from 'licia/startWith'
import { shell } from './base'
import types from 'licia/types'
import average from 'licia/average'
import identity from 'licia/identity'
import stripNum from 'licia/stripNum'
import isEmpty from 'licia/isEmpty'

const DEFAULT_PERIOD = 50

export async function getCpuLoads(
  deviceId: string,
  allCpus: any[],
  period = 0
) {
  const cpuLoads: number[] = []
  if (!period) {
    period = DEFAULT_PERIOD
  }

  await sleep(period)
  const newAllCpus = await getCpus(deviceId, false)
  each(allCpus, (cpu, idx) => {
    // 热插拔/离线核会导致第二次采样少核：缺的核按 0 处理，不能让 index 越界
    cpuLoads[idx] = newAllCpus[idx] ? calculateCpuLoad(cpu, newAllCpus[idx]) : 0
  })
  return cpuLoads
}

function calculateCpuLoad(lastCpu, cpu) {
  const lastTimes = lastCpu.times
  const times = cpu.times
  const lastLoad =
    lastTimes.user +
    lastTimes.sys +
    lastTimes.nice +
    lastTimes.irq +
    lastTimes.iowait +
    lastTimes.softirq
  const lastTick = lastLoad + lastTimes.idle
  const load =
    times.user +
    times.sys +
    times.nice +
    times.irq +
    times.iowait +
    times.softirq
  const tick = load + times.idle
  const delta = tick - lastTick
  // 两次采样落在同一个 jiffy 内时是 0/0，不能把 NaN 渲染到界面上
  if (!delta || delta < 0) return 0

  return (load - lastLoad) / delta
}

export async function getCpus(deviceId: string, speed = true) {
  const result: string = await shell(deviceId, 'cat /proc/stat')
  const lines = result.split('\n')
  const cpus: any[] = []

  each(lines, (line) => {
    line = trim(line)
    if (!startWith(line, 'cpu')) {
      return
    }

    const parts = line.split(/\s+/)
    if (parts[0] === 'cpu') {
      return
    }

    const cpu: any = {}
    cpu.times = {
      user: toNum(parts[1]),
      nice: toNum(parts[2]),
      sys: toNum(parts[3]),
      idle: toNum(parts[4]),
      iowait: toNum(parts[5]),
      irq: toNum(parts[6]),
      softirq: toNum(parts[7]),
    }

    cpus.push(cpu)
  })

  if (speed) {
    const freqs = await shell(
      deviceId,
      map(cpus, (cpu, idx) => {
        return `cat /sys/devices/system/cpu/cpu${idx}/cpufreq/scaling_cur_freq`
      })
    )
    const speeds = map(freqs, (line) => {
      const v = trim(line)
      return v ? Math.floor(toNum(v) / 1000) : undefined
    })

    each(cpus, (cpu, idx) => {
      // 按下标对齐：某一核读不到频率时不能把后面的核整体错位
      cpu.speed = speeds[idx]
    })
  }

  return cpus
}

const regTemperature =
  /Temperature\{mValue=([\d.]+),\s*mType=(\d+),\s*mName=(\w+)/
export async function getCpuTemperature(deviceId: string) {
  const thermal = await shell(deviceId, 'dumpsys thermalservice')
  const lines = thermal.split('\n')

  const cpuTemperatures: types.PlainObj<number> = {}

  for (let i = 0, len = lines.length; i < len; i++) {
    const line = lines[i]
    const match = line.match(regTemperature)
    if (match) {
      const name = match[3]
      const value = toNum(match[1])
      if (startWith(name, 'CPU')) {
        cpuTemperatures[name] = value
      }
    }
  }

  if (isEmpty(cpuTemperatures)) {
    return 0
  }

  return stripNum(average(...map(cpuTemperatures, identity)), 3)
}
