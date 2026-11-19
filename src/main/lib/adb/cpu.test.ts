import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCpuTemperature } from './cpuParse'

test('Kirin 温度：兼容 CPU-0/cpu_0 和字段换序', () => {
  const output = [
    'Temperature{mName=GPU, mValue=48.0, mType=2}',
    'Temperature{mName=CPU-0, mValue=52.5, mType=2}',
    'Temperature{mValue=58.5, mName=cpu_4, mType=2}',
  ].join('\n')
  assert.equal(parseCpuTemperature(output), 55.5)
})

test('Kirin 温度：没有 CPU 传感器时回退 SoC/AP', () => {
  const output = [
    'Temperature{mName=soc-thermal, mValue=47.25, mType=2}',
    'Temperature{mName=AP, mValue=50.75, mType=2}',
    'Temperature{mName=battery, mValue=35, mType=2}',
  ].join('\n')
  assert.equal(parseCpuTemperature(output), 49)
})

test('温度：忽略异常值和未知传感器', () => {
  assert.equal(
    parseCpuTemperature(
      'Temperature{mName=CPU0, mValue=999}\nTemperature{mName=charger, mValue=40}'
    ),
    0
  )
})
