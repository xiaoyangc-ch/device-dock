export interface IPackageDumpInfo {
  packageName: string
  versionName?: string
  firstInstallTime?: number
  lastUpdateTime?: number
  minSdkVersion?: number
  targetSdkVersion?: number
}

const MARKER = '__DEVICEDOCK_PACKAGE__'
const PACKAGE_RE = /^[A-Za-z0-9_.]+$/
const MIN_VALID_TIMESTAMP = Date.UTC(2000, 0, 1)

/** 只拼接经白名单校验的包名，避免 dumpsys 命令被包名注入。 */
export function buildPackageDumpCommand(packageNames: string[]) {
  return packageNames
    .filter((name) => PACKAGE_RE.test(name))
    .map(
      (name) =>
        `echo '${MARKER}${name}'; ` +
        `dumpsys package ${name} 2>/dev/null | ` +
        `grep -E '^[[:space:]]*(versionCode|versionName|firstInstallTime|lastUpdateTime|minSdk|minSdkVersion|targetSdk|targetSdkVersion)='`,
    )
    .join('; ')
}

function parseTimestamp(value: string | undefined) {
  if (!value) return undefined
  // dumpsys 使用 "yyyy-MM-dd HH:mm:ss"，Node 对空格格式的兼容性不稳定。
  const timestamp = Date.parse(value.trim().replace(' ', 'T'))
  return timestamp >= MIN_VALID_TIMESTAMP ? timestamp : undefined
}

/** 部分麒麟固件把未设置的安装时间上报成 1970，不能直接展示。 */
export function normalizePackageTimestamp(value: unknown) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= MIN_VALID_TIMESTAMP
    ? timestamp
    : 0
}

/**
 * Android 6/定制 ROM 的 IPackageManager 反射可能失败。
 * dumpsys 仍可稳定提供版本、时间和 SDK，用来补齐纯 pm 回退缺失的元数据。
 */
export function parsePackageDump(output: string) {
  const result = new Map<string, IPackageDumpInfo>()
  let current: IPackageDumpInfo | null = null

  for (const raw of String(output || '').split('\n')) {
    const line = raw.trim()
    const marker = line.indexOf(MARKER)
    if (marker >= 0) {
      const packageName = line.slice(marker + MARKER.length).trim()
      if (!PACKAGE_RE.test(packageName)) {
        current = null
        continue
      }
      current = { packageName }
      result.set(packageName, current)
      continue
    }
    if (!current) continue

    if (/^versionCode=\d+/.test(line)) {
      for (const matched of line.matchAll(
        /(minSdk(?:Version)?|targetSdk(?:Version)?)=(\d+)/g,
      )) {
        const sdk = Number(matched[2])
        if (!Number.isFinite(sdk)) continue
        if (matched[1].startsWith('minSdk')) current.minSdkVersion = sdk
        else current.targetSdkVersion = sdk
      }
      continue
    }

    const matched = line.match(/^([\w]+)=(.+)$/)
    if (!matched) continue
    const [, key, value] = matched
    if (key === 'versionName' && value) {
      current.versionName = value
    } else if (key === 'firstInstallTime') {
      current.firstInstallTime = parseTimestamp(value)
    } else if (key === 'lastUpdateTime') {
      current.lastUpdateTime = parseTimestamp(value)
    } else if (key === 'minSdk' || key === 'minSdkVersion') {
      const sdk = Number(value)
      if (Number.isFinite(sdk)) current.minSdkVersion = sdk
    } else if (key === 'targetSdk' || key === 'targetSdkVersion') {
      const sdk = Number(value)
      if (Number.isFinite(sdk)) current.targetSdkVersion = sdk
    }
  }
  return result
}
