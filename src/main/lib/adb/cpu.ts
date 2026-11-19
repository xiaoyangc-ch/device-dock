/**
 * CPU 采样：/proc/stat 两次差分算负载，/proc/cpuinfo 之外再读 cpufreq 拿实时频率。
 * 温度从 dumpsys thermalservice 里取 CPU* 传感器的平均值。
 */
import sleep from 'licia/sleep'
import { shell } from './base'
import { parseCpuTemperature } from './cpuParse'

const DEFAULT_PERIOD = 50

export async function getCpuLoads(
  deviceId: string,
  allCpus: any[],
  period = 0
) {
  // 两次采样间隔默认 50ms：太短会落在同一个 jiffy 里算出 0/0
  await sleep(period || DEFAULT_PERIOD)
  const next = await getCpus(deviceId, false)

  const loads: number[] = []
  for (let i = 0; i < allCpus.length; i++) {
    // 热插拔/离线核会导致第二次采样少核：缺的核按 0，不能让 index 越界
    loads[i] = next[i] ? calculateCpuLoad(allCpus[i], next[i]) : 0
  }
  return loads
}

function calculateCpuLoad(lastCpu: any, cpu: any) {
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
    times.user + times.sys + times.nice + times.irq + times.iowait + times.softirq
  const tick = load + times.idle

  const delta = tick - lastTick
  // 同 jiffy 内采样是 0/0，不能把 NaN 渲染到界面
  if (!delta || delta < 0) return 0
  return (load - lastLoad) / delta
}

export async function getCpus(deviceId: string, speed = true) {
  const result = String(await shell(deviceId, 'cat /proc/stat'))
  const cpus: any[] = []

  for (const raw of result.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('cpu')) continue

    const parts = line.split(/\s+/)
    // 第一行是汇总的 cpu，不含编号
    if (parts[0] === 'cpu') continue

    cpus.push({
      times: {
        user: Number(parts[1]) || 0,
        nice: Number(parts[2]) || 0,
        sys: Number(parts[3]) || 0,
        idle: Number(parts[4]) || 0,
        iowait: Number(parts[5]) || 0,
        irq: Number(parts[6]) || 0,
        softirq: Number(parts[7]) || 0,
      },
    })
  }

  if (speed && cpus.length) {
    const commands = cpus.map(
      (_, i) => `cat /sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`
    )
    const freqs = (await shell(deviceId, commands)) as string[]
    for (let i = 0; i < cpus.length; i++) {
      const value = String(freqs[i] ?? '').trim()
      // 按下标对齐：某一核读不到频率时不能把后面的核整体错位
      cpus[i].speed = value ? Math.floor(Number(value) / 1000) : undefined
    }
  }

  return cpus
}

export async function getCpuTemperature(deviceId: string) {
  const thermal = String(await shell(deviceId, 'dumpsys thermalservice'))
  return parseCpuTemperature(thermal)
}
