export function parseIpAndMac(out: string) {
  const interfaces = String(out)
    .split(/\n(?=\d+: )/)
    .map((block) => ({
      block,
      name: (block.match(/^\d+: ([^:@]+)/) || [])[1] || '',
      hasIpv4: /inet (?!127\.)/.test(block),
    }))

  const pick = (name: string) =>
    interfaces.find((item) => item.name === name && item.hasIpv4)
  let target = pick('wlan0')
  let netType = '无线网络'
  if (!target) {
    target = pick('eth0')
    netType = '有线网络'
  }
  if (!target) {
    target = interfaces.find((item) => item.name !== 'lo' && item.hasIpv4)
    netType = '网络'
  }

  let ip = ''
  let mac = ''
  if (target) {
    const ipMatch = target.block.match(/inet (\d+\.\d+\.\d+\.\d+)/)
    const macMatch = target.block.match(
      /link\/ether (([0-9A-Fa-f]{2}:){5}([0-9A-Fa-f]{2}))/
    )
    if (ipMatch) ip = ipMatch[1]
    if (macMatch) mac = macMatch[1]
  }
  return { ip, mac, netType }
}

/**
 * Huawei/HiSilicon 固件常见的是普通 `SSID:`，部分版本没有 `mWifiInfo` 前缀；
 * 引号和 SSID 后缀也可能不同，因此逐行做两种格式兜底。
 */
export function parseWifiSsid(out: string): string {
  for (const raw of String(out).split('\n')) {
    const matched = raw.match(
      /(?:\bmWifiInfo\s+)?\bSSID:\s*(?:"([^"]*)"|([^,\n]+))/
    )
    const ssid = (matched?.[1] ?? matched?.[2] ?? '').trim()
    if (!ssid || /^<unknown ssid>$/i.test(ssid)) continue
    return ssid
  }
  return ''
}

export function parseScreen(wmSize: string, wmDensity: string) {
  const physicalResolution = findProp('Physical size', wmSize)
  const physicalDensity = findProp('Physical density', wmDensity)
  const hasOverrideResolution = wmSize.includes('Override')
  const hasOverrideDensity = wmDensity.includes('Override')

  return {
    resolution: hasOverrideResolution
      ? findProp('Override size', wmSize)
      : physicalResolution,
    physicalResolution,
    density: hasOverrideDensity
      ? findProp('Override density', wmDensity)
      : physicalDensity,
    physicalDensity,
  }
}

export function parseMemory(memInfo: string) {
  const total = findProp('MemTotal', memInfo)
  const free = findProp('MemAvailable', memInfo) || findProp('MemFree', memInfo)
  if (!total || !free) return { memTotal: 0, memUsed: 0 }

  const memTotal = parseInt(total, 10) * 1024
  const memFree = parseInt(free, 10) * 1024
  return { memTotal, memUsed: Math.max(0, memTotal - memFree) }
}

/**
 * 优先读取 `dumpsys diskstats`，部分 Huawei/定制固件不返回 Data-Free，
 * 再用同一批 shell 里的 `df -k /data` 兜底。
 */
export function parseStorage(storageInfo: string, dfInfo = '') {
  const matched = String(storageInfo).match(/Data-Free:\s*(\d+)K\s*\/\s*(\d+)K/i)
  if (matched) {
    const free = parseInt(matched[1], 10) * 1024
    const total = parseInt(matched[2], 10) * 1024
    return { storageTotal: total, storageUsed: Math.max(0, total - free) }
  }

  for (const raw of String(dfInfo).split('\n')) {
    const fields = raw.trim().split(/\s+/)
    if (!fields.length || !/(?:^|\/)data$/.test(fields[fields.length - 1])) {
      continue
    }
    const numeric = fields.filter((field) => /^\d+$/.test(field))
    if (numeric.length < 2) continue
    const total = Number(numeric[0]) * 1024
    const used = Number(numeric[1]) * 1024
    if (total > 0) return { storageTotal: total, storageUsed: used }
  }
  return { storageTotal: 0, storageUsed: 0 }
}

/** 取 `Key: value` 行的值；找不到返回空串。 */
export function findProp(key: string, text: string): string {
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line.startsWith(key)) continue
    return line.replace(/.*:/, '').trim()
  }
  return ''
}
