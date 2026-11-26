import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, app, dialog } from 'electron'
import { getDevices, getOverview } from './adb'
import { getAdbPath, spawnAdb, type AdbResult } from './adb/base'
import { getDeviceServerInfo } from './adb/server'
import {
  getOperationSnapshot,
  OPERATION_SESSION_ID,
  redactText,
  sanitizeForDiagnostics,
} from 'share/main/lib/operationLog'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import { getRecentLogs } from 'share/main/window/terminal'
import { getSettingsStore } from './store'
import type { IpcExportDiagnostics } from 'common/types'
import { t } from 'common/util'
import pkg from '../../../package.json'

const COMMAND_OUTPUT_MAX = 256 * 1024
const DEVICE_INFO_TIMEOUT = 12_000
const SETTINGS_KEYS = [
  'language',
  'theme',
  'useNativeTitlebar',
  'adbPath',
  'killAdbWhenExit',
  'sidebarCollapsed',
]

function truncate(value: string, max = COMMAND_OUTPUT_MAX) {
  return value.length > max ? value.slice(0, max) + '\n…[truncated]' : value
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`诊断采集超时（${timeoutMs}ms）`)),
        timeoutMs,
      )
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function settled<T>(
  promise: Promise<T>,
  timeoutMs = DEVICE_INFO_TIMEOUT,
) {
  const started = Date.now()
  try {
    return {
      ok: true as const,
      durationMs: Date.now() - started,
      value: await withTimeout(promise, timeoutMs),
    }
  } catch (error) {
    return {
      ok: false as const,
      durationMs: Date.now() - started,
      error: redactText(
        error instanceof Error ? error.stack || error.message : error,
        8000,
      ),
    }
  }
}

function commandResult(args: string[], result: AdbResult) {
  return {
    args,
    ok: result.code === 0 && !result.timedOut,
    code: result.code,
    timedOut: result.timedOut,
    stdout: redactText(truncate(result.stdout)),
    stderr: redactText(truncate(result.stderr)),
  }
}

async function adbCommand(args: string[], timeoutMs = 12_000) {
  const started = Date.now()
  try {
    return {
      durationMs: Date.now() - started,
      ...commandResult(args, await spawnAdb(args, timeoutMs)),
    }
  } catch (error) {
    return {
      args,
      ok: false,
      code: null,
      timedOut: false,
      durationMs: Date.now() - started,
      stdout: '',
      stderr: redactText(error instanceof Error ? error.message : error),
    }
  }
}

function localTimestamp(value: Date) {
  const parts = [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
    '-',
    String(value.getHours()).padStart(2, '0'),
    String(value.getMinutes()).padStart(2, '0'),
    String(value.getSeconds()).padStart(2, '0'),
  ]
  return parts.join('')
}

async function collectDevice(device: {
  id: string
  type: string
  name: string
  serialno: string
  androidVersion: string
  sdkVersion: string
}) {
  const deviceArg = ['-s', device.id]
  const online = device.type === 'device' || device.type === 'emulator'
  const [overview, server, currentUser, packages, packagePaths, versions] =
    await Promise.all([
      online
        ? settled(getOverview(device.id))
        : Promise.resolve({ ok: false, error: `设备状态：${device.type}` }),
      online
        ? settled(getDeviceServerInfo(device.id))
        : Promise.resolve({ ok: false, error: `设备状态：${device.type}` }),
      online
        ? adbCommand([...deviceArg, 'shell', 'am get-current-user'])
        : Promise.resolve(null),
      online
        ? adbCommand([...deviceArg, 'shell', 'pm list packages'])
        : Promise.resolve(null),
      online
        ? adbCommand([...deviceArg, 'shell', 'pm list packages -f'])
        : Promise.resolve(null),
      online
        ? adbCommand([
            ...deviceArg,
            'shell',
            'pm list packages --show-versioncode',
          ])
        : Promise.resolve(null),
    ])

  const samplePackages =
    packages && 'stdout' in packages
      ? String(packages.stdout)
          .split('\n')
          .map((line) => line.match(/^package:(\S+)/)?.[1] || '')
          .filter(Boolean)
          .slice(0, 3)
      : []
  const packageChecks = await Promise.all(
    samplePackages.map((pkg) =>
      adbCommand([...deviceArg, 'shell', `pm path ${pkg}`]),
    ),
  )

  return {
    device,
    overview,
    deviceServer: server,
    probes: {
      currentUser,
      packages,
      packagePaths,
      packageVersions: versions,
      packageChecks,
    },
  }
}

function localPathReplacements(): Array<[string, string]> {
  const paths: Array<[string, string]> = [
    [app.getPath('userData'), '[USER_DATA]'],
    [app.getPath('temp'), '[TEMP]'],
    [app.getPath('home'), '[HOME]'],
  ]
  return paths.sort((a, b) => String(b[0]).length - String(a[0]).length)
}

function redactPathText(text: string, paths: Array<[string, string]>) {
  let output = text
  for (const [localPath, placeholder] of paths) {
    if (!localPath) continue
    output = output.split(String(localPath)).join(placeholder)
  }
  return output
}

/**
 * Windows 路径在 JSON.stringify 后会变成 C:\\Users\\...，如果只在最终字符串里替换
 * C:\Users\... 就永远匹配不到。先遍历对象值，再做一次字符串兜底。
 */
function redactHomePaths<T>(value: T): T {
  const paths = localPathReplacements()

  function walk(current: unknown): unknown {
    if (typeof current === 'string') return redactPathText(current, paths)
    if (Array.isArray(current)) return current.map(walk)
    if (current && typeof current === 'object') {
      return Object.fromEntries(
        Object.entries(current).map(([key, child]) => [key, walk(child)]),
      )
    }
    return current
  }

  return walk(value) as T
}

async function collectDiagnostics() {
  const started = Date.now()
  const settingsStore = getSettingsStore()
  const operations = getOperationSnapshot().filter(
    (item) =>
      !(item.channel === 'exportDiagnostics' && item.status === 'pending'),
  )
  const rawDevices = await adbCommand(['devices', '-l'], 8000)
  const adbVersion = await adbCommand(['version'], 5000)
  let devices: Awaited<ReturnType<typeof getDevices>> = []
  let deviceListError = ''
  try {
    devices = await withTimeout(getDevices(), 12_000)
  } catch (error) {
    deviceListError = redactText(
      error instanceof Error ? error.stack || error.message : error,
    )
  }

  const deviceDetails = await Promise.all(
    devices.map((device) => collectDevice(device)),
  )
  const settings = Object.fromEntries(
    SETTINGS_KEYS.map((key) => [key, settingsStore.get(key)]),
  )
  const windows = BrowserWindow.getAllWindows().map((win) => ({
    title: win.getTitle(),
    url: redactText(win.webContents.getURL()),
    visible: win.isVisible(),
    focused: win.isFocused(),
    destroyed: win.isDestroyed(),
  }))

  return sanitizeForDiagnostics({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    operationSessionId: OPERATION_SESSION_ID,
    collectionDurationMs: Date.now() - started,
    privacy: {
      excluded: ['剪贴板', '屏幕内容', '文件正文', '密码明文', '访问令牌'],
      note: '主目录、userData、临时目录已替换为占位符；URL token、密码类字段自动脱敏。',
    },
    app: {
      name: app.getName(),
      version: pkg.version,
      electronVersion: process.versions.electron,
      packaged: app.isPackaged,
      locale: app.getLocale(),
      theme: settingsStore.get('theme'),
      resourcesPath: redactText(resolveResources('')),
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      osType: os.type(),
      osRelease: os.release(),
      osVersion: process.getSystemVersion?.() || '',
      cpuCount: os.cpus().length,
      versions: process.versions,
    },
    settings,
    windows,
    adb: {
      path: redactText(getAdbPath()),
      version: adbVersion,
      devices: rawDevices,
      deviceListError,
    },
    devices: deviceDetails,
    operations,
    logs: getRecentLogs(),
  })
}

const exportDiagnostics: IpcExportDiagnostics = async () => {
  const now = new Date()
  const parent = BrowserWindow.getFocusedWindow()
  const options = {
    title: t('exportDiagnostics'),
    defaultPath: path.join(
      app.getPath('downloads'),
      `devicedock-diagnostics-${localTimestamp(now)}.json`,
    ),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  }
  const result = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { canceled: true }

  const diagnostics = redactHomePaths(await collectDiagnostics())
  const content = JSON.stringify(diagnostics, null, 2)
  const temp = `${result.filePath}.${process.pid}.tmp`
  try {
    await fs.writeFile(temp, content, 'utf8')
    await fs.move(temp, result.filePath, { overwrite: true })
    return { canceled: false, path: result.filePath }
  } finally {
    await fs.remove(temp).catch(() => undefined)
  }
}

export function init() {
  handleEvent('exportDiagnostics', exportDiagnostics)
}
