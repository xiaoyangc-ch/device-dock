export function parseCpuTemperature(thermal: string) {
  const cpuValues: number[] = []
  const socValues: number[] = []

  // Huawei/Kirin 的传感器名可能是 CPU-0、cpu_0、soc-thermal 等，
  // 字段顺序也不保证固定，因此先按完整 Temperature{...} 块读取。
  for (const matched of String(thermal).matchAll(/Temperature\{([^}]*)\}/g)) {
    const block = matched[1]
    const value = Number((block.match(/mValue=(-?[\d.]+)/) || [])[1])
    const name = ((block.match(/mName=([^,}\s]+)/) || [])[1] || '').trim()
    if (!Number.isFinite(value) || value < -40 || value > 200 || !name) {
      continue
    }

    const lower = name.toLowerCase()
    if (lower.includes('cpu')) {
      cpuValues.push(value)
    } else if (
      /(?:^|[-_])(soc|ap|tsensor)(?:$|[-_])/.test(lower) &&
      !/gpu|battery|charger/.test(lower)
    ) {
      socValues.push(value)
    }
  }

  const values = cpuValues.length ? cpuValues : socValues
  if (!values.length) return 0
  const average = values.reduce((sum, value) => sum + value, 0) / values.length
  return Number(average.toFixed(3))
}
