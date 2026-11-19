export interface ITopPackage {
  name: string
  pid: number
}

export interface IPackageEntry {
  name: string
  path: string
  versionCode: string
}

const PACKAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.]*$/

/** `am get-current-user` 在不同固件上可能是纯数字，也可能是 `Current user: 0`。 */
export function parseCurrentUser(output: string): number | null {
  for (const raw of String(output).split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const matched =
      line.match(/(?:current\s*user|user)\s*[:=]?\s*(\d+)/i) ||
      line.match(/^(\d+)$/)
    if (matched) return Number(matched[1])
  }
  return null
}

/**
 * 解析 `pm list packages [-f] [--show-versioncode]`。
 * Huawei/旧版 pm 的选项支持不一致，因此路径、版本号都按可选字段处理。
 */
export function parsePackageListing(output: string): IPackageEntry[] {
  const entries = new Map<string, IPackageEntry>()

  for (const raw of String(output).split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('package:')) continue

    let payload = line.slice('package:'.length).trim()
    const version = payload.match(/\s+versionCode\s*[:=]\s*(\d+)\s*$/i)
    const versionCode = version?.[1] || ''
    if (version) {
      payload = payload.slice(0, version.index ?? payload.length).trim()
    }

    let name = payload
    let path = ''
    const separator = payload.lastIndexOf('=')
    if (separator > 0 && payload.slice(0, separator).startsWith('/')) {
      path = payload.slice(0, separator)
      name = payload.slice(separator + 1)
    }
    if (!PACKAGE_NAME.test(name)) continue

    const previous = entries.get(name)
    if (!previous) {
      entries.set(name, { name, path, versionCode })
      continue
    }
    entries.set(name, {
      name,
      path: previous.path || path,
      versionCode: previous.versionCode || versionCode,
    })
  }

  return [...entries.values()]
}

/** `pm path` / `cmd package path` 会返回一到多个 `package:/...apk` 行。 */
export function parsePackagePaths(output: string): string[] {
  const paths = new Set<string>()
  for (const raw of String(output).split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('package:')) continue
    const value = line.slice('package:'.length).trim()
    if (value.startsWith('/')) paths.add(value)
  }
  return [...paths]
}

/**
 * Huawei/HarmonyOS 常见的是 mResumedActivity/mFocusedApp，
 * 原生/部分 AOSP 固件则是 top-activity 里的 pid:package/activity。
 */
export function parseTopPackage(output: string): ITopPackage {
  const text = String(output)
  const topActivity = text
    .split('\n')
    .find((line) => line.includes('top-activity'))
  if (topActivity) {
    const matched = topActivity.match(
      /\b(\d+):([A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.$]+)/
    )
    if (matched) {
      return {
        name: matched[2].split('/')[0],
        pid: Number(matched[1]) || 0,
      }
    }
  }

  for (const line of text.split('\n')) {
    if (
      !/(?:mResumedActivity|ResumedActivity|mFocusedActivity|mFocusedApp|mCurrentFocus)/.test(
        line
      )
    ) {
      continue
    }
    const matched = line.match(
      /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/[A-Za-z0-9_.$]+/
    )
    if (matched) return { name: matched[1], pid: 0 }
  }
  return { name: '', pid: 0 }
}
