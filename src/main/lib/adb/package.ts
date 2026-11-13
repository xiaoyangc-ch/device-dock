/**
 * 应用管理：包列表、启停/安装/卸载/清数据/禁用、应用图标、前台应用。
 *
 * 应用图标是「按需」拉取的：用户选中某个应用时才 pull 它的 APK，
 * 解出最大的一份 launcher 图后缓存到 userData/icon-cache，同一应用只拉一次。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { Client } from '@devicefarmer/adbkit'
import * as yauzl from 'yauzl'
import { shell, shellChecked, spawnAdb } from './base'
import { handleEvent } from 'share/main/lib/util'
import { clearPackageCaches } from './server'
import {
  IpcClearPackage,
  IpcDisablePackage,
  IpcEnablePackage,
  IpcGetPackageIcon,
  IpcGetPackages,
  IpcGetTopPackage,
  IpcInstallPackage,
  IpcStartPackage,
  IpcStopPackage,
  IpcUninstallPackage,
} from 'common/types'
import { assertPackageName } from 'common/guards'

let client: Client

// ---------------------------------------------------------------------------
// 包列表
// ---------------------------------------------------------------------------

/**
 * Android 6 没有 `am get-current-user`（7.0 才加），失败时返回一行错误文本。
 * 拿不到就返回 null，调用方省掉 --user，不要把 NaN 拼进命令。
 */
let currentUserCache: Map<string, Promise<number | null>> | null = null
function getCurrentUser(deviceId: string) {
  if (!currentUserCache) currentUserCache = new Map()
  let pending = currentUserCache.get(deviceId)
  if (!pending) {
    pending = (async () => {
      try {
        const out = await shell(deviceId, 'am get-current-user')
        const value = parseInt(String(out).split('\n')[0].trim(), 10)
        return Number.isFinite(value) ? value : null
      } catch {
        return null
      }
    })()
    currentUserCache.set(deviceId, pending)
    pending.catch(() => currentUserCache?.delete(deviceId))
  }
  return pending
}

const PKG_CACHE_MS = 5000
const pkgCache = new Map<string, { at: number; list: string[] }>()

export const getPackages: IpcGetPackages = async (deviceId, system = true) => {
  const key = `${deviceId}:${system ? 1 : 0}`
  const hit = pkgCache.get(key)
  if (hit && Date.now() - hit.at < PKG_CACHE_MS) return hit.list

  const user = await getCurrentUser(deviceId)
  const args = [
    'pm',
    'list',
    'packages',
    system ? '' : '-3',
    user === null ? '' : `--user ${user}`,
  ]
    .filter(Boolean)
    .join(' ')
  const out = String(await shell(deviceId, args))

  // 只认 package: 行：设备不认某个选项时会回一行 Error，
  // 直接 slice(8) 会把错误文本当成包名
  const list: string[] = []
  for (const raw of out.split('\n')) {
    const matched = raw.trim().match(/^package:(\S+)/)
    if (matched) list.push(matched[1])
  }

  pkgCache.set(key, { at: Date.now(), list })
  return list
}

// ---------------------------------------------------------------------------
// 启停 / 安装 / 卸载 / 清数据 / 禁用
// ---------------------------------------------------------------------------

const stopPackage: IpcStopPackage = async (deviceId, pkg) => {
  assertPackageName(pkg)
  await shell(deviceId, `am force-stop ${pkg}`)
}

const clearPackage: IpcClearPackage = async (deviceId, pkg) => {
  const device = await client.getDevice(deviceId)
  await device.clear(pkg)
}

const startPackage: IpcStartPackage = async (deviceId, pkg) => {
  const component = await getMainComponent(deviceId, pkg)
  const device = await client.getDevice(deviceId)
  await device.startActivity({ component })
}

const installPackage: IpcInstallPackage = async (deviceId, apkPath) => {
  const device = await client.getDevice(deviceId)
  await device.install(apkPath)
  // 新装包的 versionCode 变了：立刻让应用页重新取，不等 5 秒缓存
  clearPackageCaches(deviceId)
}

const uninstallPackage: IpcUninstallPackage = async (deviceId, pkg) => {
  const device = await client.getDevice(deviceId)
  await device.uninstall(pkg)
  clearPackageCaches(deviceId)
}

const disablePackage: IpcDisablePackage = async (deviceId, pkg) => {
  assertPackageName(pkg)
  // checked：系统应用禁用失败必须报错，以前一律当成功
  await shellChecked(deviceId, `pm disable-user ${pkg}`)
}

const enablePackage: IpcEnablePackage = async (deviceId, pkg) => {
  assertPackageName(pkg)
  await shellChecked(deviceId, `pm enable ${pkg}`)
}

/**
 * 找应用的主 Activity：`dumpsys package` 里 MAIN intent filter 的第一行就是。
 * 返回 `pkg/Activity`，直接可以给 `am start` 用。
 */
async function getMainComponent(deviceId: string, pkg: string) {
  assertPackageName(pkg)
  const out = String(
    await shell(deviceId, `dumpsys package ${pkg} | grep -A 1 MAIN`)
  )
  const pattern = new RegExp(`${pkg.replace(/\./g, '\\.')}/([\\w.$]+)`)
  for (const raw of out.split('\n')) {
    const matched = raw.match(pattern)
    if (matched) return `${pkg}/${matched[1]}`
  }
  throw new Error('Failed to get main activity')
}

// ---------------------------------------------------------------------------
// 图标：pull APK → 解压挑最大 launcher 图 → 缓存
// ---------------------------------------------------------------------------

const iconMem = new Map<string, string>()
const iconPending = new Map<string, Promise<string>>()

function iconDir() {
  return path.join(app.getPath('userData'), 'icon-cache')
}

// key 必须带设备：两台设备装同包名不同版本/不同图标时会串图，
// 磁盘缓存同样要按设备分开
function iconCacheFile(deviceId: string, pkg: string) {
  return path.join(iconDir(), encodeURIComponent(`${deviceId}|${pkg}`) + '.txt')
}

// 每条 base64 最多 2MB，没有上限会一直涨
const ICON_MEM_MAX = 200

function rememberIcon(key: string, url: string) {
  iconMem.set(key, url)
  while (iconMem.size > ICON_MEM_MAX) {
    const oldest = iconMem.keys().next().value
    if (oldest === undefined) break
    iconMem.delete(oldest)
  }
}

/** 给 APK 里的图标候选打分：mipmap 优先、launcher 命名优先、高 dpi 优先、方形优先。 */
function iconScore(name: string, size: number) {
  if (!/\.(png|webp)$/i.test(name)) return 0
  let score = 0
  if (/\/mipmap[^/]*\//i.test(name)) score += 100
  else if (/\/drawable[^/]*\//i.test(name)) score += 40
  else return 0
  if (/launcher|app_icon|ic_launcher/i.test(name)) score += 40
  if (/xxxhdpi/i.test(name)) score += 30
  else if (/xxhdpi/i.test(name)) score += 24
  else if (/xhdpi/i.test(name)) score += 18
  else if (/hdpi/i.test(name)) score += 10
  // 圆形图标通常是裁切版，优先方形
  if (/round/i.test(name)) score -= 6
  score += Math.min(size / 8192, 12)
  return score
}

function readApkIcon(apk: string): Promise<{ data: Buffer; mime: string } | null> {
  return new Promise((resolve) => {
    // autoClose: false 是必须的：lazyEntries 读到 end 时 yauzl 会自动关掉文件，
    // 后面再 openReadStream 就会报 closed
    yauzl.open(apk, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) return resolve(null)

      const candidates: Array<{ entry: yauzl.Entry; score: number }> = []
      let settled = false
      const finish = (value: { data: Buffer; mime: string } | null) => {
        if (settled) return
        settled = true
        try {
          zip.close()
        } catch {
          // ignore
        }
        resolve(value)
      }

      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) {
          zip.readEntry()
          return
        }
        const score = iconScore(entry.fileName, entry.uncompressedSize)
        if (score > 0) candidates.push({ entry, score })
        zip.readEntry()
      })
      zip.on('error', () => finish(null))
      zip.on('end', () => {
        if (!candidates.length) return finish(null)

        candidates.sort((a, b) => b.score - a.score)
        const entry = candidates[0].entry
        zip.openReadStream(entry, (readErr, stream) => {
          if (readErr || !stream) return finish(null)

          const chunks: Buffer[] = []
          let size = 0
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length
            // 图标不该有几 MB：超过就放弃，避免畸形 APK 把内存吃满
            if (size <= 2 * 1024 * 1024) chunks.push(chunk)
          })
          stream.on('error', () => finish(null))
          stream.on('end', () => {
            if (!chunks.length) return finish(null)
            const ext = path.extname(entry.fileName).toLowerCase()
            finish({
              data: Buffer.concat(chunks),
              mime: ext === '.webp' ? 'image/webp' : 'image/png',
            })
          })
        })
      })
      zip.readEntry()
    })
  })
}

async function readIconCache(deviceId: string, pkg: string) {
  const key = `${deviceId}|${pkg}`
  const hit = iconMem.get(key)
  if (hit) return hit
  try {
    const text = await fs.readFile(iconCacheFile(deviceId, pkg), 'utf8')
    if (text.startsWith('data:image/')) {
      rememberIcon(key, text)
      return text
    }
  } catch {
    // 没缓存
  }
  return ''
}

/** 设备移除 / 卸载重装时清掉该设备的图标缓存（内存 + 磁盘） */
export function clearIconCache(deviceId: string) {
  const prefix = deviceId + '|'
  for (const key of [...iconMem.keys()]) {
    if (key.startsWith(prefix)) iconMem.delete(key)
  }
  iconDirCleanup(deviceId)
}

function iconDirCleanup(deviceId: string) {
  const prefix = encodeURIComponent(deviceId + '|')
  fs.readdir(iconDir())
    .then((names) => {
      for (const name of names) {
        if (name.startsWith(prefix)) {
          fs.unlink(path.join(iconDir(), name)).catch(() => undefined)
        }
      }
    })
    .catch(() => undefined)
}

export const getPackageIcon: IpcGetPackageIcon = async (deviceId, pkg) => {
  // 包名会拼进 pm 命令和本地缓存文件名，先卡死字符集
  assertPackageName(pkg)
  const key = `${deviceId}|${pkg}`

  const cached = await readIconCache(deviceId, pkg)
  if (cached) return cached
  const running = iconPending.get(key)
  if (running) return running

  const task = (async () => {
    const out = String(
      await shell(deviceId, `pm path ${pkg}`).catch(() => '')
    )
    const apk = out
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('package:'))
      ?.slice('package:'.length)
    if (!apk) return ''

    const tmp = path.join(
      app.getPath('temp'),
      `devicedock-icon-${Date.now()}-${Math.random().toString(36).slice(2)}.apk`
    )
    try {
      await spawnAdb(['-s', deviceId, 'pull', apk, tmp], 120000)
      const icon = await readApkIcon(tmp)
      if (!icon) return ''

      const url = `data:${icon.mime};base64,${icon.data.toString('base64')}`
      rememberIcon(key, url)
      fs.mkdir(iconDir(), { recursive: true })
        .then(() => fs.writeFile(iconCacheFile(deviceId, pkg), url))
        .catch(() => undefined)
      return url
    } catch {
      return ''
    } finally {
      fs.unlink(tmp).catch(() => undefined)
    }
  })().finally(() => iconPending.delete(key))

  iconPending.set(key, task)
  return task
}

// ---------------------------------------------------------------------------
// 前台应用
// ---------------------------------------------------------------------------

const TOP_PACKAGE_TTL = 2000
let topPackageCache: {
  at: number
  deviceId: string
  promise: Promise<{ name: string; pid: number }>
} | null = null

export const getTopPackage: IpcGetTopPackage = (deviceId) => {
  // 性能页会轮询这个值：必须短 TTL，否则前台应用永远停在第一次的快照
  if (
    topPackageCache &&
    topPackageCache.deviceId === deviceId &&
    Date.now() - topPackageCache.at < TOP_PACKAGE_TTL
  ) {
    return topPackageCache.promise
  }

  const promise = (async () => {
    // 只需要 top-activity 那一行：全量 dumpsys activity 输出 144KB / 0.19 秒，
    // 性能页每 2 秒轮询一次，光传输就占掉不少。先让设备端 grep 只回一行，
    // 个别固件没有 grep 或输出为空时再退回全量解析。
    let out = String(
      await shell(deviceId, "dumpsys activity 2>/dev/null | grep -m1 top-activity")
    )
    if (!out.trim()) {
      out = String(await shell(deviceId, 'dumpsys activity'))
    }
    const line = out
      .split('\n')
      .find((item) => item.includes('top-activity'))
    if (!line) return { name: '', pid: 0 }

    // 形如 `... 1234:com.xxx/.MainActivity ...`：倒数第二个字段是 pid:name
    const parts = line.trim().split(/\s+/)
    const token = parts[parts.length - 2] || ''
    const [pidText, rawName = ''] = token.split(':')
    const name = rawName.includes('/') ? rawName.split('/')[0] : rawName
    return { name, pid: parseInt(pidText, 10) || 0 }
  })()

  const entry = { at: Date.now(), deviceId, promise }
  topPackageCache = entry
  promise.catch(() => {
    if (topPackageCache === entry) topPackageCache = null
  })
  return promise
}

export async function init(c: Client) {
  client = c

  handleEvent('getPackages', getPackages)
  handleEvent('getPackageIcon', getPackageIcon)
  handleEvent('stopPackage', stopPackage)
  handleEvent('startPackage', startPackage)
  handleEvent('installPackage', installPackage)
  handleEvent('uninstallPackage', uninstallPackage)
  handleEvent('getTopPackage', getTopPackage)
  handleEvent('clearPackage', clearPackage)
  handleEvent('disablePackage', disablePackage)
  handleEvent('enablePackage', enablePackage)
}
