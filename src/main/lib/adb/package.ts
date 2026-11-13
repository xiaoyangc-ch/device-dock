import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { Client } from '@devicefarmer/adbkit'
import * as yauzl from 'yauzl'
import { shell, shellChecked, spawnAdb } from './base'
import singleton from 'licia/singleton'
import each from 'licia/each'
import trim from 'licia/trim'
import contain from 'licia/contain'
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

let client: Client

// Android 6 没有 get-current-user（7.0 才加），am 只回一行错误文本。
// 拿不到就返回 null，调用方省掉 --user（走设备默认用户），别把 NaN 拼进命令里。
const getCurrentUser = singleton(async (deviceId: string) => {
  const result = await shell(deviceId, 'am get-current-user')
  const user = parseInt(trim(result).split('\n')[0].trim(), 10)
  return Number.isFinite(user) ? user : null
})

// 原来用 singleton 永久缓存：装/卸应用后，本次运行内列表再也不会变（应用页刷新拿到的还是旧包）
const pkgCache = new Map<string, { ts: number; list: string[] }>()
const PKG_CACHE_MS = 5000

export const getPackages: IpcGetPackages = async (deviceId, system = true) => {
  const key = `${deviceId}:${system ? 1 : 0}`
  const hit = pkgCache.get(key)
  if (hit && Date.now() - hit.ts < PKG_CACHE_MS) {
    return hit.list
  }
  const user = await getCurrentUser(deviceId)
  const result: string = await shell(
    deviceId,
    `pm list packages${system ? '' : ' -3'}${
      user === null ? '' : ` --user ${user}`
    }`
  )
  // 只认 package: 行：设备不支持某个选项时会回一行 Error，
  // 旧代码 line.slice(8) 把错误文本当成了包名
  const list: string[] = []
  each(trim(result).split('\n'), (line) => {
    const match = trim(line).match(/^package:(\S+)/)
    if (match) {
      list.push(match[1])
    }
  })
  pkgCache.set(key, { ts: Date.now(), list })
  return list
}

const stopPackage: IpcStopPackage = async function (deviceId, pkg) {
  await shell(deviceId, `am force-stop ${pkg}`)
}

const clearPackage: IpcClearPackage = async function (deviceId, pkg) {
  const device = await client.getDevice(deviceId)
  await device.clear(pkg)
}

const startPackage: IpcStartPackage = async function (deviceId, pkg) {
  const component = await getMainComponent(deviceId, pkg)
  const device = await client.getDevice(deviceId)
  await device.startActivity({
    component,
  })
}

const installPackage: IpcInstallPackage = async function (deviceId, apkPath) {
  const device = await client.getDevice(deviceId)
  await device.install(apkPath)
  // 新装的包 versionCode 变了：别等 30 秒 TTL，立刻让应用页重新取
  clearPackageCaches(deviceId)
}

const uninstallPackage: IpcUninstallPackage = async function (deviceId, pkg) {
  const device = await client.getDevice(deviceId)
  await device.uninstall(pkg)
  clearPackageCaches(deviceId)
}


// ---- 应用图标：只在用户选中应用时按需拉取一次 APK，解出最大的一份 launcher 图 ----
const iconMem = new Map<string, string>()
const iconPending = new Map<string, Promise<string>>()

function iconDir() {
  return path.join(app.getPath('userData'), 'icon-cache')
}

function iconCacheFile(pkg: string) {
  return path.join(iconDir(), encodeURIComponent(pkg) + '.txt')
}

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
    yauzl.open(apk, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) return resolve(null)
      const candidates: Array<{ entry: yauzl.Entry; score: number }> = []
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) {
          zip.readEntry()
          return
        }
        const score = iconScore(entry.fileName, entry.uncompressedSize)
        if (score > 0) candidates.push({ entry, score })
        zip.readEntry()
      })
      zip.on('error', () => resolve(null))
      zip.on('end', () => {
        if (!candidates.length) {
          zip.close()
          return resolve(null)
        }
        candidates.sort((a, b) => b.score - a.score)
        const entry = candidates[0].entry
        zip.openReadStream(entry, (readErr, stream) => {
          if (readErr || !stream) {
            zip.close()
            return resolve(null)
          }
          const chunks: Buffer[] = []
          let size = 0
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length
            // 图标不该有几 MB：超过就直接放弃，避免把畸形 APK 读进内存
            if (size <= 2 * 1024 * 1024) chunks.push(chunk)
          })
          stream.on('error', () => {
            zip.close()
            resolve(null)
          })
          stream.on('end', () => {
            zip.close()
            if (!chunks.length) return resolve(null)
            const ext = path.extname(entry.fileName).toLowerCase()
            resolve({
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

async function readIconCache(pkg: string) {
  const hit = iconMem.get(pkg)
  if (hit) return hit
  try {
    const text = await fs.readFile(iconCacheFile(pkg), 'utf8')
    if (text.startsWith('data:image/')) {
      iconMem.set(pkg, text)
      return text
    }
  } catch {
    // 没缓存
  }
  return ''
}

export const getPackageIcon: IpcGetPackageIcon = async function (
  deviceId,
  pkg
) {
  // 包名会拼进 pm 命令和本地缓存文件名，先卡死字符集
  if (!/^[A-Za-z0-9_.]+$/.test(pkg)) return ''
  const cached = await readIconCache(pkg)
  if (cached) return cached
  const running = iconPending.get(pkg)
  if (running) return running

  const task = (async () => {
    const out = await shell(deviceId, `pm path ${pkg}`).catch(() => '')
    const apk = String(out)
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
      iconMem.set(pkg, url)
      fs.mkdir(iconDir(), { recursive: true })
        .then(() => fs.writeFile(iconCacheFile(pkg), url))
        .catch(() => undefined)
      return url
    } catch {
      return ''
    } finally {
      fs.unlink(tmp).catch(() => undefined)
    }
  })().finally(() => iconPending.delete(pkg))

  iconPending.set(pkg, task)
  return task
}

async function getMainComponent(deviceId: string, pkg: string) {
  const result = await shell(
    deviceId,
    `dumpsys package ${pkg} | grep -A 1 MAIN`
  )
  const lines = result.split('\n')
  for (let i = 0, len = lines.length; i < len; i++) {
    const line = trim(lines[i])
    if (contain(line, `${pkg}/`)) {
      return line.substring(line.indexOf(`${pkg}/`), line.indexOf(' filter'))
    }
  }

  throw new Error('Failed to get main activity')
}

export const getTopPackage = singleton(<IpcGetTopPackage>(
  async function (deviceId) {
    const topActivity = await shell(deviceId, 'dumpsys activity')
    const lines = topActivity.split('\n')
    let line = ''
    for (let i = 0, len = lines.length; i < len; i++) {
      if (contain(lines[i], 'top-activity')) {
        line = trim(lines[i])
        break
      }
    }

    if (!line) {
      return {
        name: '',
        pid: 0,
      }
    }

    let parts = line.split(/\s+/)
    parts = parts[parts.length - 2].split(':')
    const pid = parseInt(parts[0], 10)
    let name = parts[1]
    if (contain(name, '/')) {
      name = name.split('/')[0]
    }

    return {
      name,
      pid,
    }
  }
))

const disablePackage: IpcDisablePackage = async function (deviceId, pkg) {
  // checked：系统应用禁用失败必须报错，以前一律当成成功
  await shellChecked(deviceId, `pm disable-user ${pkg}`)
}

const enablePackage: IpcEnablePackage = async function (deviceId, pkg) {
  await shellChecked(deviceId, `pm enable ${pkg}`)
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
