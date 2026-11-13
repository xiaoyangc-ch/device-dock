/**
 * 文件管理：列目录、搜索、上传/下载、复制/移动/删除、全盘索引。
 *
 * 统一约定：
 * - 设备路径一律单引号转义（文件名可能带 $()、空格、引号）；
 * - 破坏性操作走 fileShell(..., checked=true)，adb shell 不返回退出码，
 *   失败必须让上层看到，不能 UI 显示成功；
 * - 大目录操作显式传 timeoutMs（删除/复制 600s，mv 120s）。
 */
import { Client } from '@devicefarmer/adbkit'
import fs from 'fs-extra'
import path from 'node:path'
import { handleEvent } from 'share/main/lib/util'
import { getUserDataPath } from 'share/main/lib/util'
import { shell as electronShell } from 'electron'
import {
  isRooted,
  shell,
  shellChecked,
  spawnAdb,
  spawnAdbBuffer,
  spawnAdbLines,
} from './base'
import startWith from 'licia/startWith'
import contain from 'licia/contain'
import uuid from 'licia/uuid'
import { getPackages } from './package'
import { parseLsLine } from './lsLine'
import {
  IFile,
  IpcCreateDir,
  IpcDeleteDir,
  IpcDeleteFile,
  IpcMoveFile,
  IpcOpenFile,
  IpcPasteFiles,
  IpcPullFile,
  IpcPushFile,
  IpcReadDir,
  IpcReadDirPage,
  IpcSearchDir,
  IpcStatFile,
  TransferType,
} from 'common/types'
import * as window from 'share/main/lib/window'
import throttle from 'licia/throttle'
import Semaphore from 'licia/Semaphore'
import splitPath from 'licia/splitPath'
import mime from 'licia/mime'

let client: Client

// 文件传输并发 5：太快会把设备 adbd 压死，太慢大目录要等很久
const fileSemaphore = new Semaphore(5)
function waitFileSlot(): Promise<void> {
  return new Promise((resolve) => fileSemaphore.wait(() => resolve()))
}

// 递归目录时 stat/readdir 不经过 fileSemaphore：几千个文件会同时开几千条 adb 连接。
// 元数据操作单独限流 8，文件传输仍走上面的 5。
const metaSemaphore = new Semaphore(8)
function withMetaSlot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    metaSemaphore.wait(async () => {
      try {
        resolve(await fn())
      } catch (e) {
        reject(e)
      } finally {
        metaSemaphore.signal()
      }
    })
  })
}

// ---------------------------------------------------------------------------
// 下载 / 打开
// ---------------------------------------------------------------------------

const pullFile: IpcPullFile = async function (deviceId, src, dest) {
  const stat = await withMetaSlot(() => statFile(deviceId, src))

  if (stat.directory) {
    await fs.ensureDir(dest)
    const files = await withMetaSlot(() => readDir(deviceId, src))
    // 分批递归：stat 已限流，这里再压一层并发，避免几千个 pull 同时开连接
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(
        files
          .slice(i, i + 8)
          .map((file) =>
            pullFile(
              deviceId,
              `${src}/${file.name}`,
              path.join(dest, file.name)
            )
          )
      )
    }
    return
  }

  await waitFileSlot()
  // 目标目录可能不存在（下载到 Downloads 子目录）：先建父目录，
  // 否则 createWriteStream 直接 ENOENT，进度停在 0%
  await fs.ensureDir(path.dirname(dest))

  let released = false
  const release = () => {
    if (released) return
    released = true
    fileSemaphore.signal()
  }

  try {
    const id = uuid()

    // 非 root 读 /data/data：run-as 把内容直接流到本地，设备上不落盘。
    // 旧做法「run-as cp 到 /data/local/tmp」会因 shell:shell 0771 无写权限失败，
    // 而 shell() 不返回退出码，最后只得到一个 0 字节文件。
    if (startWith(src, '/data/data/') && !(await isRooted(deviceId))) {
      const pkg = src.replace('/data/data/', '').split('/')[0]
      const rel = src.replace(`/data/data/${pkg}/`, '')
      window.sendTo(
        'main',
        'startTransfer',
        id,
        TransferType.Download,
        src,
        dest,
        stat.size
      )
      const result = await spawnAdbBuffer(
        [
          '-s',
          deviceId,
          'exec-out',
          `run-as ${shellQuotePath(pkg)} cat ${shellQuotePath(rel)}`,
        ],
        120000
      )
      if (result.timedOut) throw new Error('拉取超时')
      if (result.code !== 0) {
        throw new Error('拉取失败：没有权限读取该文件（设备未 root）')
      }
      const expected = stat.size || 0
      if (expected > 0 && result.buffer.length !== expected) {
        throw new Error(
          `文件不完整：期望 ${expected} 字节，实际 ${result.buffer.length} 字节`
        )
      }
      await fs.writeFile(dest, result.buffer)
      window.sendTo('main', 'finishTransfer', id, true)
      release()
      return
    }

    const device = await client.getDevice(deviceId)
    const transfer = await device.pull(src)
    window.sendTo(
      'main',
      'startTransfer',
      id,
      TransferType.Download,
      src,
      dest,
      stat.size
    )

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let writable: ReturnType<typeof fs.createWriteStream> | null = null
      // adbd 卡死 / USB 半断时 transfer 既不 error 也不 finish：
      // 没有超时的话 finish 永不执行，fileSemaphore 槽位泄漏，
      // 攒够 5 次之后所有上传下载都停在 waitFileSlot 上，只能重启应用
      let idle: ReturnType<typeof setTimeout> | null = null
      const armIdle = () => {
        if (idle) clearTimeout(idle)
        idle = setTimeout(
          () => finish(new Error('传输超时：120 秒没有进展')),
          120000
        )
      }

      const finish = (error?: any) => {
        if (settled) return
        settled = true
        if (idle) {
          clearTimeout(idle)
          idle = null
        }
        release()
        if (error) {
          // 失败时收掉写流和 adbkit 的 sync 传输，否则连接一直挂在 adb server 上
          try {
            writable?.destroy()
          } catch {
            // ignore
          }
          try {
            ;(transfer as any).cancel?.()
          } catch {
            // ignore
          }
        }
        window.sendTo('main', 'finishTransfer', id, !error)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }

      writable = fs.createWriteStream(dest)
      // 磁盘满/无权限时 WriteStream 会发 error，没监听就是主进程未捕获异常
      writable.on('error', (error) => finish(error))
      writable.on('finish', () => finish())
      transfer.on(
        'progress',
        throttle(({ bytesTransferred }) => {
          armIdle()
          window.sendTo('main', 'updateTransfer', id, bytesTransferred)
        }, 500)
      )
      transfer.on('error', (error) => finish(error))
      armIdle()
      transfer.pipe(writable)
    })
  } catch (e) {
    release()
    throw e
  }
}

const openFile: IpcOpenFile = async function (deviceId, devicePath) {
  // 不能放 os.tmpdir() 且只用 basename：同名文件互相覆盖，
  // 而且整个仓库没有任何地方删它（预览一个 1.5G 视频就永久多占 1.5G）
  const dir = getUserDataPath('preview-cache')
  await fs.ensureDir(dir)
  const tag = deviceId.replace(/[^\w.-]+/g, '_')
  // 同一设备只留最近这份预览，避免越积越多
  try {
    for (const name of await fs.readdir(dir)) {
      if (name.startsWith(tag + '-')) {
        await fs.remove(path.join(dir, name)).catch(() => {})
      }
    }
  } catch {
    // 目录刚建/读失败都不影响打开
  }
  const safeName = (path.basename(devicePath) || 'preview').replace(
    /[^\w.-]+/g,
    '_'
  )
  const dest = path.join(dir, `${tag}-${safeName}`)
  await pullFile(deviceId, devicePath, dest)
  electronShell.openPath(dest)
}

// ---------------------------------------------------------------------------
// 删除 / 新建
// ---------------------------------------------------------------------------

// rm -rf 不可逆：设备盘根、内部存储根、系统分区一律拒绝。
// 渲染层传什么就删什么太危险（面板是 visibility:hidden 保活的，历史上误点过）。
const PROTECTED_DELETE = new Set([
  '/',
  '/sdcard',
  '/storage',
  '/storage/emulated',
  '/storage/emulated/0',
  '/data',
  '/data/media',
  '/data/media/0',
  '/mnt',
  '/system',
  '/vendor',
  '/product',
  '/odm',
  '/apex',
])

function assertDeletable(devicePath: string) {
  const nor = devicePath.replace(/\/+$/, '') || '/'
  if (PROTECTED_DELETE.has(nor)) {
    throw new Error(`拒绝删除受保护路径：${devicePath}`)
  }
  // 只删顶层的 /xxx 也拦掉：那基本都是挂载点或系统目录
  if (nor.split('/').filter(Boolean).length < 2) {
    throw new Error(`拒绝删除顶层目录：${devicePath}`)
  }
}

const deleteFile: IpcDeleteFile = async function (deviceId, devicePath) {
  assertDeletable(devicePath)
  // checked：rm 失败（只读挂载/权限不足）必须报错，不能让 UI 显示删除成功
  await fileShell(deviceId, 'rm', devicePath, undefined, true, 120000)
  resetFileIndex(deviceId)
}

const deleteDir: IpcDeleteDir = async function (deviceId, devicePath) {
  assertDeletable(devicePath)
  await fileShell(deviceId, 'rm -rf', devicePath, undefined, true, 600000)
  resetFileIndex(deviceId)
}

const createDir: IpcCreateDir = async function (deviceId, devicePath) {
  await fileShell(deviceId, 'mkdir -p', devicePath, undefined, true, 60000)
  resetFileIndex(deviceId)
}

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

const pushFile: IpcPushFile = async function (deviceId, src, dest) {
  const stat = await fs.stat(src)

  if (stat.isDirectory()) {
    await createDir(deviceId, dest)
    const names = await fs.readdir(src)
    // 分批递归：一次 Promise.all 几千个 push 会把 adb server 打满
    for (let i = 0; i < names.length; i += 8) {
      await Promise.all(
        names
          .slice(i, i + 8)
          .map((name) =>
            pushFile(deviceId, path.join(src, name), `${dest}/${name}`)
          )
      )
    }
    return
  }

  await waitFileSlot()
  let released = false
  const release = () => {
    if (released) return
    released = true
    fileSemaphore.signal()
  }

  let tmpFilePath = ''
  try {
    // 非 root 写 /data/data：先推到 /data/local/tmp，成功后再 cp 进目标目录
    if (startWith(dest, '/data/data/') && !(await isRooted(deviceId))) {
      tmpFilePath = '/data/local/tmp/' + uuid()
    }

    const device = await client.getDevice(deviceId)
    const transfer = await device.push(src, tmpFilePath || dest)

    const id = uuid()
    window.sendTo(
      'main',
      'startTransfer',
      id,
      TransferType.Upload,
      src,
      dest,
      stat.size
    )

    await new Promise<void>((resolve, reject) => {
      let settled = false
      // 同 pullFile：传输卡死时必须有出口，否则信号量泄漏
      let idle: ReturnType<typeof setTimeout> | null = null
      const armIdle = () => {
        if (idle) clearTimeout(idle)
        idle = setTimeout(
          () => done(new Error('传输超时：120 秒没有进展')),
          120000
        )
      }

      const done = (error?: any) => {
        if (settled) return
        settled = true
        if (idle) {
          clearTimeout(idle)
          idle = null
        }
        release()
        window.sendTo('main', 'finishTransfer', id, !error)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const cleanup = (error?: any) => {
        if (settled) return
        if (error || !tmpFilePath) {
          // 失败时别往 /data/data 里拷半个文件，直接删临时文件
          if (tmpFilePath) deleteFile(deviceId, tmpFilePath).catch(() => {})
          return done(error)
        }
        fileShell(deviceId, 'cp', tmpFilePath, dest)
          .then(() => deleteFile(deviceId, tmpFilePath).catch(() => {}))
          .then(() => done())
          .catch((e) => done(e))
      }

      transfer.on('end', () => cleanup())
      transfer.on(
        'progress',
        throttle(({ bytesTransferred }) => {
          armIdle()
          window.sendTo('main', 'updateTransfer', id, bytesTransferred)
        }, 500)
      )
      transfer.on('error', (error) => cleanup(error))
      armIdle()
    })
  } catch (e) {
    release()
    throw e
  }
  resetFileIndex(deviceId)
}

// ---------------------------------------------------------------------------
// 移动 / 粘贴
// ---------------------------------------------------------------------------

const moveFile: IpcMoveFile = async function (deviceId, src, dest) {
  // mv 会静默覆盖同名文件。界面只看到当前分页，目标可能在未加载的下一页，
  // 必须在设备侧再拦一次，避免重命名顺手删掉一个文件
  if (await devicePathExists(deviceId, dest)) {
    throw new Error('目标已存在同名文件')
  }
  await fileShell(deviceId, 'mv', src, dest, true, 120000)
  resetFileIndex(deviceId)
}

function joinDevicePath(dir: string, name: string) {
  if (!dir || dir === '/') return '/' + name
  return dir.replace(/\/+$/, '') + '/' + name
}

async function devicePathExists(deviceId: string, devicePath: string) {
  const out = await shell(
    deviceId,
    `[ -e ${shellQuotePath(devicePath)} ] && echo 1 || echo 0`
  )
  return String(out).trim() === '1'
}

/**
 * 复制/剪切粘贴：目标重名时自动加 " (1)"，逐个处理，单个失败不影响其余。
 */
const pasteFiles: IpcPasteFiles = async function (deviceId, sources, dest, cut) {
  const failed: { name: string; error: string }[] = []
  const used = new Set<string>()
  let copied = 0

  for (const src of sources) {
    const base = src.split('/').filter(Boolean).pop()
    try {
      if (!src || !base) continue
      const parent = src.replace(/\/[^/]+$/, '') || '/'
      // 原地剪切不算操作
      if (cut && parent === dest) continue
      if (dest === src || startWith(dest + '/', src + '/')) {
        throw new Error('不能粘贴到自身或子目录')
      }

      let target = joinDevicePath(dest, base)
      let n = 1
      while (used.has(target) || (await devicePathExists(deviceId, target))) {
        const dot = base.lastIndexOf('.')
        const name =
          dot > 0
            ? `${base.slice(0, dot)} (${n})${base.slice(dot)}`
            : `${base} (${n})`
        target = joinDevicePath(dest, name)
        if (++n > 500) throw new Error('目标重名过多')
      }
      used.add(target)

      await fileShell(
        deviceId,
        cut ? 'mv' : 'cp -r',
        src,
        target,
        true,
        600000
      )
      copied++
    } catch (e: any) {
      failed.push({ name: base || src, error: e?.message || String(e) })
    }
  }

  if (copied) resetFileIndex(deviceId)
  return { copied, failed }
}

// ---------------------------------------------------------------------------
// 列目录
// ---------------------------------------------------------------------------

const readDir: IpcReadDir = async function (deviceId, deviceDir) {
  // /data 下非 root 走 run-as，普通 readdir 会被 SELinux 拒绝
  if (
    startWith(deviceDir, '/data/') &&
    !startWith(deviceDir, '/data/local/tmp/')
  ) {
    if (!(await isRooted(deviceId))) {
      return readDataDir(deviceId, deviceDir)
    }
  }

  const device = await client.getDevice(deviceId)
  const files: any[] = await device.readdir(deviceDir)

  const result: IFile[] = []
  for (const file of files) {
    const item: IFile = {
      name: file.name,
      directory: !file.isFile(),
      mtime: new Date(file.mtimeMs),
      mode: file.mode,
    }
    if (!item.directory) {
      item.size = file.size
      item.mime = mime(splitPath(file.name).ext.slice(1))
    }
    result.push(item)
  }
  return result
}

/** 设备路径转 shell 单引号字符串：文件名里的 ' 要转成 '\''。 */
function shellQuotePath(devicePath: string) {
  return "'" + devicePath.replace(/'/g, "'\\''") + "'"
}

/**
 * Android 6 及更早的 ls 是 toolbox：不认 -L，直接 abort，整页为空；
 * 7.0 起 toybox 才支持。每条命令试错太慢，按设备探测一次并缓存。
 */
const lsFollowCache = new Map<string, Promise<boolean>>()
function lsFollowsSymlink(deviceId: string): Promise<boolean> {
  let probe = lsFollowCache.get(deviceId)
  if (!probe) {
    probe = shell(
      deviceId,
      `ls -laL / >/dev/null 2>&1 && echo devicedock_ls_follow || echo devicedock_ls_plain`
    )
      .then((out) => contain(out, 'devicedock_ls_follow'))
      .catch(() => false)
    lsFollowCache.set(deviceId, probe)
  }
  return probe
}

/** 老系统不解析 shell 输出：格式/软链/权限全是坑，直接走 adb 同步协议列目录。 */
async function readDirSorted(deviceId: string, deviceDir: string): Promise<IFile[]> {
  const dir = deviceDir.length > 1 ? deviceDir.replace(/\/+$/, '') : deviceDir
  const all = await readDir(deviceId, dir)
  return all.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

/**
 * 设备上不一定有 awk：用两次 ls + grep 拼出「目录在前、文件在后」。
 * 大目录里文件夹若按字母序排在上千文件之后，首屏就会「看不到文件夹」。
 */
function dirsFirst(q: string) {
  return `{ ls -laL ${q} | grep '^d'; ls -laL ${q} | grep -v '^d' | grep -v '^total '; }`
}

// 分页列目录：设备端 ls 很快（几十毫秒），慢的是把上万条完整清单传回来。
// 每页只取 limit 条，先出首屏，点「加载更多」再取下一页。
const readDirPage: IpcReadDirPage = async function (deviceId, path, offset, limit) {
  const syncMode =
    (startWith(path, '/data/') && !startWith(path, '/data/local/tmp/')) ||
    !(await lsFollowsSymlink(deviceId))
  if (syncMode) {
    const all = await readDirSorted(deviceId, path)
    return { files: all.slice(offset, offset + limit), total: all.length }
  }

  const q = shellQuotePath(path)

  // 头部固定是 . 和 .. 两行，分页时跳过；不依赖 awk/sed 的转义
  const cmd = `${dirsFirst(q)} | tail -n +${offset + 3} | head -n ${limit}`
  const r = await spawnAdb(['-s', deviceId, 'shell', cmd], 60000)
  // 超时返回的是半截 stdout，当成完整结果会静默少列文件
  if (r.timedOut) throw new Error('列目录超时：结果不完整，请重试')

  const files: IFile[] = []
  const lines = String(r.stdout || '').split('\n')
  let dataLines = 0
  for (let i = 0, len = lines.length; i < len; i++) {
    if (!lines[i].trim()) continue
    dataLines++
    const parsed: any = parseLsLine(lines[i])
    if (!parsed) continue
    if (!parsed.directory) {
      parsed.mime = mime(splitPath(parsed.name).ext.slice(1))
    }
    files.push(parsed)
  }

  // 不满一页说明已经到末尾，省掉一次 wc 往返（小目录少 200~400ms）
  let total = offset + files.length
  if (dataLines >= limit) {
    const totalR = await spawnAdb(
      ['-s', deviceId, 'shell', `${dirsFirst(q)} | wc -l`],
      30000
    )
    if (!totalR.timedOut) {
      // 去掉 . 和 .. 两行
      total =
        (Number(String(totalR.stdout || '').trim().split(/\s+/)[0]) || 2) - 2
    }
  }
  return { files, total }
}

// ---------------------------------------------------------------------------
// 搜索：当前目录递归 / 全盘
// ---------------------------------------------------------------------------

/**
 * 这些路径下搜索默认递归（存储盘），其它路径只搜当前目录。
 * /media、/usb、/udisk 也要算：不同厂商挂载点不统一，外接盘只出现在其中某个。
 */
const RECURSIVE_ROOTS = [
  '/sdcard',
  '/storage',
  '/mnt',
  '/media',
  '/usb',
  '/udisk',
  '/data/media',
]

function canSearchRecursive(target: string) {
  return RECURSIVE_ROOTS.some((root) => target.startsWith(root))
}

/**
 * Android 4.4 的 toolbox find 不认 -iname/-maxdepth：
 * 探测一次，不支持就退回「只搜当前目录」。
 */
const findCache = new Map<string, Promise<boolean>>()
function supportsRecursiveFind(deviceId: string): Promise<boolean> {
  let probe = findCache.get(deviceId)
  if (!probe) {
    probe = shell(
      deviceId,
      `find . -maxdepth 0 -iname devicedock >/dev/null 2>&1 && echo devicedock_find_ok || echo devicedock_find_no`
    )
      .then((out) => String(out).includes('devicedock_find_ok'))
      .catch(() => false)
    findCache.set(deviceId, probe)
  }
  return probe
}

// ---------------------------------------------------------------------------
// 全盘搜索根：/proc/mounts + 常见兜底 + 顶层真实目录
// ---------------------------------------------------------------------------

// 只有这些 fstype 才是「用户文件盘」；tmpfs/proc/overlay 不搜
const STORAGE_FS = new Set([
  'ext2', 'ext3', 'ext4', 'f2fs', 'vfat', 'exfat', 'ntfs', 'ntfs3',
  'fuseblk', 'texfat', 'msdos', 'iso9660', 'udf', 'sdcardfs', 'fuse', 'esdfs',
])

// Android 会在 /mnt 下挂一堆同一份存储的运行时视图，逐个搜只会重复和拖慢
const SKIP_MOUNTS = [
  '/mnt/runtime/', '/mnt/user/', '/mnt/installer', '/mnt/androidwritable',
  '/mnt/pass_through', '/mnt/asec', '/mnt/obb', '/mnt/secure', '/mnt/expand',
  '/storage/self', '/data/media/obb', '/data/media/android_secure',
  '/data/user', '/data/app', '/data/data', '/data/system', '/data/vendor',
  '/data/misc', '/data/adb', '/data/anr', '/data/tombstones',
  '/data/dalvik-cache', '/data/local', '/data_mirror',
]

// 系统分区不是用户的文件盘，扫它们又慢又没结果
const SYSTEM_MOUNT =
  /^\/(system|system_ext|vendor|vendor_dlkm|product|odm|odm_dlkm|oem|apex|cache|metadata|persist|efs|firmware|boot|init|dev|proc|sys|acct|config|snapshot)(\/|$)/

function isStorageMount(mountPoint: string, fsType: string) {
  if (!STORAGE_FS.has(fsType)) return false
  if (mountPoint === '/' || mountPoint === '/data') return false
  // /data 除了 /data/media（用户文件）以外全是应用数据
  if (mountPoint.startsWith('/data') && !mountPoint.startsWith('/data/media')) {
    return false
  }
  if (SYSTEM_MOUNT.test(mountPoint)) return false
  if (SKIP_MOUNTS.some((skip) => mountPoint.startsWith(skip))) return false
  if (
    mountPoint.includes('/Android/data') ||
    mountPoint.includes('/Android/obb')
  ) {
    return false
  }
  return true
}

/** scan 用来遍历（可能是内核直挂路径），display 是给用户看的路径。 */
interface ISearchRoot {
  scan: string
  display: string
}

/**
 * 全盘搜索根：
 * 1. /proc/mounts 收集真实存储挂载点（厂商自定义路径也能覆盖）；
 * 2. 补常见根（/media 可能只是根分区上的普通目录，不会出现在 mount 里）；
 * 3. 根目录下所有真实目录（/media、/hdf、/record 这类非挂载点）。
 *
 * /storage/<卷> 是 fuse 视图，遍历 20 万文件要 80 秒；
 * 同一个卷的 /mnt/media_rw/<卷> 是 ext4 直挂，只要 6 秒，所以优先用直挂路径，
 * 显示路径仍用 /storage。
 */
async function computeSearchRoots(deviceId: string): Promise<ISearchRoot[]> {
  const roots = new Set<string>()
  const allMounts = new Set<string>()

  try {
    const mounts = await shell(deviceId, 'cat /proc/mounts 2>/dev/null')
    for (const line of String(mounts).split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 3) continue
      const mountPoint = parts[1].replace(/\\040/g, ' ')
      if (!mountPoint.startsWith('/')) continue
      allMounts.add(mountPoint)
      if (isStorageMount(mountPoint, parts[2])) roots.add(mountPoint)
    }
  } catch {
    // 读不到就只用下面的兜底根
  }

  // 常见根兜底 + 存在性/可读性探测。
  // /storage、/mnt 只是容器：已经发现它们下面的真实挂载点时就不再整根扫，
  // 否则 /storage/self 这类软链会被 find -L 跟着再走一遍
  const mountList = Array.from(roots)
  const hasStorageMount = mountList.some((item) => item.startsWith('/storage/'))
  const hasMntMount = mountList.some((item) => item.startsWith('/mnt/'))

  // /mnt/sdcard、/mnt/pass_through、/mnt/androidwritable、/storage/self 都是
  // 同一份存储的运行时视图：整根 find -L 会把同一个文件重复搜出好几条，
  // 所以容器根只取真实的非软链子目录（外接盘 /mnt/usb/xxx 仍能进）
  const containers: string[] = []
  if (!hasStorageMount) containers.push('/storage')
  if (!hasMntMount) containers.push('/mnt')

  const plainBases = ['/media', '/usb', '/udisk', '/data/media']
  if (!hasStorageMount) plainBases.push('/sdcard')

  try {
    const list = plainBases.map(shellQuotePath).join(' ')
    const out = await shell(
      deviceId,
      `for p in ${list}; do [ -d "$p" ] && [ -r "$p" ] && [ -x "$p" ] && echo "$p"; done`
    )
    for (const line of String(out).split('\n')) {
      const item = line.trim()
      if (item) roots.add(item)
    }
  } catch {
    // ignore
  }

  // 容器下的这些名字不能用：要么是同一份存储的运行时视图（重复），
  // 要么是系统镜像/应用数据的挂载点（用户不该在「全盘」里搜到）。
  // [ ! -L ] 只能拦住软链，这些是真实挂载点，必须按名字排除。
  const CONTAINER_SKIP: Record<string, string[]> = {
    '/mnt': [
      // 同一份存储的重复视图
      'sdcard', 'pass_through', 'androidwritable', 'installer', 'user',
      'runtime', 'asec', 'obb', 'secure', 'expand',
      // 系统镜像：product/vendor/iso 是只读系统分区或光盘镜像
      'product', 'vendor', 'vendor_dlkm', 'iso',
      // appfuse：Android 11 给 App 访问自身数据用的视图，几十万条目且无用户文件
      'appfuse',
    ],
    '/storage': ['self'],
  }

  for (const base of containers) {
    const skip = CONTAINER_SKIP[base] || []
    try {
      const out = await shell(
        deviceId,
        `for p in ${base}/*; do [ -d "$p" ] && [ ! -L "$p" ] && echo "$p"; done`
      )
      for (const line of String(out).split('\n')) {
        const item = line.trim()
        if (!item) continue
        const name = item.slice(base.length + 1).split('/')[0]
        if (skip.includes(name)) continue
        roots.add(item)
      }
    } catch {
      // 容器根不可读就跳过
    }
  }

  // 顶层真实目录兜底：只在 mounts/容器/常见路径全都没发现存储根时才跑。
  // 平时不能跑 —— Android 根目录里 /lib 是指向 /system/lib 的软链，
  // /root 和 /tmp-mksh 是 shell 的杂物，find -L 跟进去既慢又会搜出系统文件。
  const SKIP_TOP = new Set([
    '/proc', '/sys', '/dev', '/acct', '/config', '/d', '/etc', '/bin', '/res',
    '/lib', '/lib64', '/root', '/tmp-mksh', '/snapshot',
    '/oem', '/system', '/system_ext', '/vendor', '/vendor_dlkm', '/product',
    '/odm', '/odm_dlkm', '/apex', '/data', '/data_mirror', '/cache',
    '/metadata', '/persist', '/efs', '/firmware', '/boot', '/init', '/sbin',
    '/lost+found', '/tmp', '/var', '/linkerconfig', '/debug_ramdisk',
    '/storage', '/mnt', '/sdcard',
  ])
  if (!roots.size) {
    try {
      const out = await shell(
        deviceId,
        'for d in /*; do [ -d "$d" ] && [ ! -L "$d" ] && echo "$d"; done'
      )
      for (const line of String(out).split('\n')) {
        const item = line.trim()
        if (item && !SKIP_TOP.has(item)) roots.add(item)
      }
    } catch {
      // ignore
    }
  }

  if (!roots.size) {
    return [
      { scan: '/storage', display: '/storage' },
      { scan: '/mnt', display: '/mnt' },
    ]
  }

  // fuse → 直挂别名替换
  const scanToDisplay = new Map<string, string>()
  const aliases: Array<[string, string]> = []
  for (const item of Array.from(roots)) {
    if (item === '/storage/emulated') {
      aliases.push(['/data/media', '/storage/emulated'])
    } else if (item.startsWith('/storage/') && item !== '/storage') {
      const id = item.slice('/storage/'.length)
      if (id && !id.includes('/')) {
        const direct = '/mnt/media_rw/' + id
        if (allMounts.has(direct)) aliases.push([direct, item])
      }
    }
  }
  if (aliases.length) {
    try {
      const list = aliases.map(([scan]) => shellQuotePath(scan)).join(' ')
      const out = await shell(
        deviceId,
        `for p in ${list}; do [ -r "$p" ] && [ -x "$p" ] && echo "$p"; done`
      )
      const readable = new Set(
        String(out).split('\n').map((line) => line.trim()).filter(Boolean)
      )
      for (const [scan, display] of aliases) {
        if (!readable.has(scan)) continue
        roots.delete(display)
        roots.add(scan)
        scanToDisplay.set(scan, display)
      }
    } catch {
      // 探测失败就用原来的 fuse 路径
    }
  }

  // /media 常是 /mnt/media_rw/<卷> 或 /storage/<卷> 的软链：
  // 目标根已在列表里就只留真实根，否则同一文件会出现两条
  if (roots.size > 1) {
    try {
      const list = Array.from(roots).map(shellQuotePath).join(' ')
      const out = await shell(
        deviceId,
        `for p in ${list}; do r=$(readlink -f "$p" 2>/dev/null); [ -n "$r" ] && [ "$r" != "$p" ] && echo "$p|$r"; done`
      )
      for (const line of String(out).split('\n')) {
        const [link, real] = line.trim().split('|')
        if (!link || !real || !roots.has(link)) continue
        const covered = Array.from(roots).some(
          (item) =>
            item !== link &&
            (item === real || real.startsWith(item.replace(/\/+$/, '') + '/'))
        )
        if (covered) roots.delete(link)
      }
    } catch {
      // readlink 不可用就保留软链根，find -L 一样能搜到
    }
  }

  let list = Array.from(roots).map((scan) => ({
    scan,
    display: scanToDisplay.get(scan) || scan,
  }))

  // /sdcard、/mnt/sdcard 都是 /storage/emulated/0 的别名：有 storage 视图时丢掉
  const hasEmulated = list.some(
    (item) =>
      item.display === '/storage/emulated' ||
      item.display.startsWith('/storage/emulated/')
  )
  if (hasEmulated) {
    list = list.filter((item) => {
      const display = item.display
      return !(
        display === '/sdcard' ||
        display.startsWith('/sdcard/') ||
        display === '/mnt/sdcard' ||
        display.startsWith('/mnt/sdcard/')
      )
    })
  }

  // 子根已被父根覆盖时去掉子根（/mnt/media_rw 在 /mnt 下）
  return list.filter(
    (root, index) =>
      !list.some(
        (parent, parentIndex) =>
          parentIndex !== index &&
          parent.scan !== root.scan &&
          root.scan.startsWith(parent.scan.replace(/\/+$/, '') + '/')
      )
  )
}

// 挂载点不会每分钟变：缓存 30 秒，避免每敲一个字都重跑 4 条探测命令
const rootsCache = new Map<string, { at: number; roots: ISearchRoot[] }>()
const ROOTS_TTL = 30000

async function getSearchRoots(
  deviceId: string,
  currentPath?: string
): Promise<ISearchRoot[]> {
  let cached = rootsCache.get(deviceId)
  if (!cached || Date.now() - cached.at > ROOTS_TTL) {
    cached = { at: Date.now(), roots: await computeSearchRoots(deviceId) }
    rootsCache.set(deviceId, cached)
  }

  const roots = cached.roots.slice()
  // 当前目录不在任何根里（比如 /data/local/tmp）：也算一个根，
  // 否则「全盘」反而搜不到眼前这个目录
  if (currentPath && currentPath !== '/' && !currentPath.includes('\0')) {
    // /sdcard、/mnt/sdcard 是软链：先解析真实路径，已被现有根覆盖就不再单独加，
    // 否则同一个文件会在 /sdcard 和 /storage/emulated/0 下各出现一次
    let scan = currentPath
    try {
      const real = String(
        await shell(
          deviceId,
          `readlink -f ${shellQuotePath(currentPath)} 2>/dev/null`
        )
      ).trim()
      if (real.startsWith('/')) scan = real
    } catch {
      // readlink 不可用就按原路径处理
    }

    // scan 可能是直挂路径（/data/media），readlink 结果却是 fuse 视图
    // （/storage/emulated/0）：两套前缀都要比，否则会多出一个重复根
    const covered = roots.some((root) => {
      const prefixes = [root.scan, root.display]
      return prefixes.some(
        (prefix) =>
          scan === prefix ||
          scan.startsWith(prefix.replace(/\/+$/, '') + '/')
      )
    })
    if (!covered) roots.push({ scan, display: currentPath })
  }
  return roots
}

// ---------------------------------------------------------------------------
// find 能力探测
// ---------------------------------------------------------------------------

/** `-exec ... {} +` → `;` → 只列文件名，按设备能力逐级降级。 */
type FindExecMode = 'plus' | 'semi' | 'plain'

const findExecCache = new Map<string, Promise<FindExecMode>>()

/** `find` 默认不跟软链：/media/hdf 这类子目录是软链时会直接跳过。 */
const findFollowCache = new Map<string, Promise<boolean>>()
function supportsFindFollow(deviceId: string): Promise<boolean> {
  let probe = findFollowCache.get(deviceId)
  if (!probe) {
    probe = shell(
      deviceId,
      'find -L / -maxdepth 0 >/dev/null 2>&1 && echo devicedock_follow_ok || echo devicedock_follow_no'
    )
      .then((out) => String(out).includes('devicedock_follow_ok'))
      .catch(() => false)
    findFollowCache.set(deviceId, probe)
  }
  return probe
}

function getFindExecMode(deviceId: string): Promise<FindExecMode> {
  let probe = findExecCache.get(deviceId)
  if (!probe) {
    probe = (async () => {
      const works = async (tail: string) => {
        try {
          const out = await shell(
            deviceId,
            `find / -maxdepth 0 -exec ls -ld {} ${tail} 2>/dev/null`
          )
          return parseSearchLines(String(out).split('\n')).length > 0
        } catch {
          return false
        }
      }
      if (await works('+')) return 'plus'
      if (await works(';')) return 'semi'
      return 'plain'
    })()
    findExecCache.set(deviceId, probe)
  }
  return probe
}

// ---------------------------------------------------------------------------
// 搜索命令与结果解析
// ---------------------------------------------------------------------------

/** 全盘搜索是整盘 find，同一台设备只保留最新一次。 */
const activeSearches = new Map<string, () => void>()

function parseSearchLines(lines: string[]): IFile[] {
  const files: IFile[] = []
  for (const line of lines) {
    const parsed: any = parseLsLine(line)
    if (!parsed) continue

    // find 输出是 "./a/b" 这种相对路径，去掉前缀直接用作显示名
    let name = parsed.name
    if (name.startsWith('./')) name = name.slice(2)
    if (!name) continue

    if (!parsed.directory) {
      parsed.mime = mime(splitPath(name).ext.slice(1))
    }
    parsed.name = name
    files.push(parsed)
  }
  return files
}

/** 拼「cd 根 && find」命令：先 cd 进根（根本身是软链也能进）。 */
function findCommand(
  root: string,
  safeKeyword: string,
  mode: FindExecMode,
  follow: string,
  limit: number
) {
  const q = shellQuotePath(root)
  const base = `cd ${q} && find ${follow}. -iname '*${safeKeyword}*'`
  if (mode === 'plus') {
    return `${base} -exec ls -ld {} + 2>/dev/null | head -n ${limit}`
  }
  if (mode === 'semi') {
    return `${base} -exec ls -ld {} \\; 2>/dev/null | head -n ${limit}`
  }
  return `${base} -print 2>/dev/null | head -n ${limit}`
}

/**
 * 只按文件名搜（不依赖 ls/-exec）：老 find 上仍能出结果。
 * 大小/时间拿不到，mtime 用当前时间占位；是不是目录再单独问一次 find -type d。
 */
async function searchRootByNames(
  deviceId: string,
  root: string,
  safeKeyword: string,
  follow: string,
  seen: Set<string>,
  found: IFile[],
  killers?: Array<() => void>,
  displayRoot?: string
): Promise<number> {
  const prefix = displayRoot || root
  const q = shellQuotePath(root)
  const raw: string[] = []

  const result = await spawnAdbLines(
    [
      '-s',
      deviceId,
      'shell',
      `cd ${q} && find ${follow}. -iname '*${safeKeyword}*' -print 2>/dev/null | head -n 1000`,
    ],
    180000,
    (line) => {
      if (line.trim()) raw.push(line)
    },
    killers ? (kill) => killers.push(kill) : undefined
  )
  if (result.timedOut) return 0

  const names = raw
    .map((line) => line.trim())
    .filter((line) => line.startsWith('./') || line.startsWith('/'))
    .map((line) =>
      line.startsWith('/') ? line : `${prefix}/${line.slice(2)}`
    )
  if (!names.length) return 0

  // 目录标记单独查一次，拿不到就当文件处理，至少名字能搜到
  const dirs = new Set<string>()
  try {
    const dirLines: string[] = []
    await spawnAdbLines(
      [
        '-s',
        deviceId,
        'shell',
        `cd ${q} && find ${follow}. -iname '*${safeKeyword}*' -type d -print 2>/dev/null | head -n 1000`,
      ],
      60000,
      (line) => {
        if (line.trim()) dirLines.push(line)
      },
      killers ? (kill) => killers.push(kill) : undefined
    )
    for (const line of dirLines) {
      const item = line.trim()
      if (!item) continue
      dirs.add(item.startsWith('/') ? item : `${prefix}/${item.slice(2)}`)
    }
  } catch {
    // 拿不到目录标记就当文件处理
  }

  let added = 0
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)

    const directory = dirs.has(name)
    const file: IFile = {
      name,
      directory,
      mtime: new Date(),
      mode: '',
    }
    if (!directory) file.mime = mime(splitPath(name).ext.slice(1))
    found.push(file)
    added++
  }
  return added
}

// ---------------------------------------------------------------------------
// 全盘搜索索引
// ---------------------------------------------------------------------------

// Android 没有 Everything 那种系统级文件表：第一次整盘遍历时把路径建成索引，
// 之后同一台设备的全盘搜索只查内存（毫秒级）；30 分钟后或文件操作后重建。
const INDEX_TTL = 30 * 60 * 1000
const INDEX_MAX_ENTRIES = 300000

interface IFileIndex {
  /** "d\t/path" | "f\t/path" */
  entries: string[]
  /** 索引只存路径不带类型：父路径出现过就说明是目录 */
  dirs: Set<string>
  at: number
}

function buildDirSet(entries: string[]) {
  const dirs = new Set<string>()
  for (const entry of entries) {
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const item = entry.slice(tab + 1)
    const slash = item.lastIndexOf('/')
    if (slash > 0) dirs.add(item.slice(0, slash))
  }
  return dirs
}

const fileIndexes = new Map<string, IFileIndex>()

/**
 * 设备移除时清掉所有按 deviceId 建表的缓存。
 * 无线设备的 id 是 ip:port，换个端口重连就是新 id：
 * 旧索引（单设备可达 30 万条路径）既占内存又永远不会再被命中。
 */
export function clearDeviceCaches(deviceId: string) {
  const drop = <T>(map: Map<string, T>) => {
    for (const key of [...map.keys()]) {
      if (
        key === deviceId ||
        key.startsWith(deviceId + '|') ||
        key.startsWith(deviceId + '\n') ||
        key.startsWith(deviceId + '/')
      ) {
        map.delete(key)
      }
    }
  }
  drop(fileIndexes)
  drop(metaCache)
  drop(rootsCache)
  drop(lsFollowCache)
  drop(findCache)
  drop(findExecCache)
  drop(statFormatCache)
  try {
    fs.removeSync(fileIndexPath(deviceId))
  } catch {
    // 索引文件本来就不存在
  }
}

function fileIndexPath(deviceId: string) {
  return path.join(
    getUserDataPath('file-index'),
    deviceId.replace(/[^\w.-]+/g, '_') + '.idx'
  )
}

function loadFileIndex(deviceId: string): IFileIndex | null {
  const cached = fileIndexes.get(deviceId)
  if (cached) return cached

  try {
    const file = fileIndexPath(deviceId)
    if (!fs.existsSync(file)) return null

    const entries = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.length > 2)
    if (!entries.length) return null

    const index = {
      entries,
      dirs: buildDirSet(entries),
      at: fs.statSync(file).mtimeMs,
    }
    fileIndexes.set(deviceId, index)
    return index
  } catch {
    return null
  }
}

function resetFileIndex(deviceId: string) {
  metaCache.clear()
  indexSearchCache = null
  fileIndexes.delete(deviceId)
  try {
    fs.removeSync(fileIndexPath(deviceId))
  } catch {
    // ignore
  }
}

type IIndexHit = { path: string; directory: boolean; score: number }

/** 全量结果缓存：翻页时不用每次重扫 20 万条索引；10 秒内同设备同关键字复用。 */
let indexSearchCache: {
  deviceId: string
  keyword: string
  hits: IIndexHit[]
  at: number
} | null = null

/**
 * 只收集轻量命中（不构造 IFile/Date/mime）：26k 命中时对象分配是大头，
 * 真正要返回给 UI 的那一页才构造 IFile。
 */
function searchFileIndex(
  deviceId: string,
  index: IFileIndex,
  keyword: string
): IIndexHit[] {
  if (
    indexSearchCache &&
    indexSearchCache.deviceId === deviceId &&
    indexSearchCache.keyword === keyword &&
    Date.now() - indexSearchCache.at < 10000
  ) {
    return indexSearchCache.hits
  }

  const lower = keyword.toLowerCase()
  const hits: IIndexHit[] = []

  for (const entry of index.entries) {
    const tab = entry.indexOf('\t')
    if (tab < 0) continue

    const filePath = entry.slice(tab + 1)
    const slash = filePath.lastIndexOf('/')
    const name = filePath.slice(slash + 1)
    if (!name) continue

    const at = name.toLowerCase().indexOf(lower)
    if (at < 0) continue

    hits.push({
      path: filePath,
      directory: entry[0] === 'd' || index.dirs.has(filePath),
      // 文件名开头命中优先，其次名字短的（更接近用户要找的东西）
      score: at * 10000 + name.length,
    })
  }

  hits.sort((a, b) => a.score - b.score)
  indexSearchCache = { deviceId, keyword, hits, at: Date.now() }
  return hits
}

function hitsToFiles(hits: IIndexHit[]): IFile[] {
  return hits.map((hit) => {
    const name = hit.path.slice(hit.path.lastIndexOf('/') + 1)
    const file: IFile = {
      name: hit.path,
      directory: hit.directory,
      mtime: new Date(),
      mode: '',
    }
    if (!hit.directory) file.mime = mime(splitPath(name).ext.slice(1))
    return file
  })
}

function slicePage(files: IFile[], offset: number, limit: number) {
  return {
    files: files.slice(offset, offset + limit),
    total: files.length,
  }
}

// ---------------------------------------------------------------------------
// 命中后的元数据补全（stat / ls -ld）
// ---------------------------------------------------------------------------

const statFormatCache = new Map<string, Promise<boolean>>()
function supportsStatFormat(deviceId: string): Promise<boolean> {
  let probe = statFormatCache.get(deviceId)
  if (!probe) {
    probe = shell(
      deviceId,
      `find / -maxdepth 0 -exec stat -c '%F|%s|%Y|%a|%n' {} + 2>/dev/null`
    )
      .then((out) => String(out).includes('directory|'))
      .catch(() => false)
    statFormatCache.set(deviceId, probe)
  }
  return probe
}

function applyStatLine(file: IFile, line: string) {
  const parts = line.split('|')
  if (parts.length < 5) return

  file.directory = parts[0] === 'directory'
  file.size = Number(parts[1]) || 0

  const seconds = Number(parts[2])
  if (seconds) file.mtime = new Date(seconds * 1000)
  file.mode = parts[3]
}

/**
 * 索引里只有路径：命中后补元数据（整个结果页，分块 + 3 路并发）。
 * 老设备没有 `stat -c` 时退回 `ls -ld` 解析。
 */
async function enrichMetaChunk(
  deviceId: string,
  chunk: IFile[],
  useStat: boolean
) {
  const paths = chunk.map((file) => shellQuotePath(file.name)).join(' ')

  if (useStat) {
    const out = await shell(
      deviceId,
      `stat -c '%F|%s|%Y|%a|%n' ${paths} 2>/dev/null`
    )
    const byPath = new Map<string, string>()
    for (const line of String(out).split('\n')) {
      const parts = line.split('|')
      if (parts.length < 5) continue
      byPath.set(parts.slice(4).join('|'), line)
    }
    for (const file of chunk) {
      const line = byPath.get(file.name)
      if (line) applyStatLine(file, line)
    }
    return
  }

  const out = await shell(deviceId, `ls -ld ${paths} 2>/dev/null`)
  for (const line of String(out).split('\n')) {
    if (!line.trim()) continue
    const parsed: any = parseLsLine(line)
    if (!parsed) continue

    const match =
      chunk.find((file) => file.name === parsed.name) ||
      chunk.find((file) => file.name.endsWith('/' + parsed.name)) ||
      chunk.find((file) => file.name.split('/').pop() === parsed.name)
    if (!match) continue

    match.directory = !!parsed.directory
    if (parsed.size !== undefined) match.size = parsed.size
    if (parsed.mtime) match.mtime = parsed.mtime
    if (parsed.mode) match.mode = parsed.mode
  }
}

// 同一个文件会在连续搜索里反复命中：缓存 10 分钟内的 stat 结果，
// 重复搜索时整页都不再走设备端 stat
const META_TTL = 10 * 60 * 1000
const META_MAX = 20000
const metaCache = new Map<
  string,
  { directory: boolean; size?: number; mtime: number; mode: string; at: number }
>()

function metaKey(deviceId: string, devicePath: string) {
  return deviceId + '\n' + devicePath
}

function applyCachedMeta(deviceId: string, file: IFile) {
  const cached = metaCache.get(metaKey(deviceId, file.name))
  if (!cached || Date.now() - cached.at > META_TTL) return false

  file.directory = cached.directory
  if (cached.size !== undefined) file.size = cached.size
  file.mtime = new Date(cached.mtime)
  file.mode = cached.mode
  return true
}

function rememberMeta(deviceId: string, file: IFile) {
  if (!file.mode && !file.size && !file.directory) return

  const key = metaKey(deviceId, file.name)
  metaCache.delete(key)
  metaCache.set(key, {
    directory: !!file.directory,
    size: file.size,
    mtime: file.mtime.getTime(),
    mode: String(file.mode || ''),
    at: Date.now(),
  })

  // 简单的 FIFO 上限：超过 2 万条丢最老的
  if (metaCache.size > META_MAX) {
    const oldest = metaCache.keys().next().value
    if (oldest !== undefined) metaCache.delete(oldest)
  }
}

async function statSearchHits(deviceId: string, files: IFile[]) {
  // 一页最多 1000 条：都补，避免往下滚全是「--」
  const targets = files.slice(0, 1000)
  if (!targets.length) return

  // 先吃 meta 缓存，只对没缓存过的文件发 stat
  const need = targets.filter((file) => !applyCachedMeta(deviceId, file))
  if (!need.length) return

  const useStat = await supportsStatFormat(deviceId)

  const chunks: IFile[][] = []
  for (let i = 0; i < need.length; i += 100) {
    chunks.push(need.slice(i, i + 100))
  }

  let next = 0
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++]
      try {
        await enrichMetaChunk(deviceId, chunk, useStat)
      } catch {
        // 单块失败不影响其它块
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(3, chunks.length) }, worker)
  )

  for (const file of need) rememberMeta(deviceId, file)
}

// ---------------------------------------------------------------------------
// 建索引
// ---------------------------------------------------------------------------

// 多台设备同时首次全盘搜索会同时整盘 find：建索引串行排队，
// 已有索引的查询不受影响（走内存）
let indexBuildChain: Promise<unknown> = Promise.resolve()

function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexBuildChain.then(fn, fn)
  indexBuildChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function buildFileIndex(
  deviceId: string,
  currentPath: string,
  keyword: string,
  emit: (files: IFile[]) => void,
  onProgress: (root: string, found: number) => void,
  killers: Array<() => void>,
  aborted: () => boolean
): Promise<IFileIndex | null> {
  const roots = await getSearchRoots(deviceId, currentPath)
  const lower = keyword.toLowerCase()
  const entries: string[] = []
  const seen = new Set<string>()

  let found = 0
  let lastEmit = 0
  let pending: IFile[] = []
  // 流式推送预算：关键字很短时命中可达几万条，渲染层每批 concat 重建数组
  // （O(n²)），而 searchDir resolve 后只用第一页——推多了纯属白做
  let sent = 0
  const EMIT_MAX = 1000

  const flush = (force = false) => {
    if (!pending.length) return
    const now = Date.now()
    // 渲染层每接一批都会重建表格行：整盘搜索时 600ms 一次才不卡
    if (!force && now - lastEmit < 600) return
    lastEmit = now
    if (sent < EMIT_MAX) {
      // slice 超出长度会自动截断，不用先判 pending.length
      const batch = pending.slice(0, EMIT_MAX - sent)
      sent += batch.length
      emit(batch)
    }
    pending = []
  }

  const add = (abs: string) => {
    if (seen.has(abs)) return
    seen.add(abs)

    if (entries.length < INDEX_MAX_ENTRIES) {
      // 建索引只列路径，不逐文件 stat：U 盘/fuse 上 stat 一个文件要 1ms，
      // 6 万个文件就是一分多钟。大小/时间等命中后再批量补
      entries.push(`f\t${abs}`)
    }

    const slash = abs.lastIndexOf('/')
    const name = abs.slice(slash + 1)
    if (!name || !name.toLowerCase().includes(lower)) return

    const file: IFile = {
      name: abs,
      directory: false,
      mtime: new Date(),
      mode: '',
    }
    file.mime = mime(splitPath(name).ext.slice(1))
    pending.push(file)
    found++
    flush()
  }

  // 多个根并行扫（最多 3 路），比串行 for 快几倍
  const queue = roots.slice()
  const workerCount = Math.min(3, Math.max(1, queue.length))
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length && !aborted()) {
      const root = queue.shift()!
      const q = shellQuotePath(root.scan)
      onProgress(root.display, found)

      const cmd = `cd ${q} && find -L . -print 2>/dev/null`
      try {
        await spawnAdbLines(
          ['-s', deviceId, 'shell', cmd],
          300000,
          (line) => {
            if (!line.trim()) return
            const item = line.trim()
            if (!(item.startsWith('./') || item.startsWith('/'))) return
            // 扫描路径可能是 /mnt/media_rw（快），显示路径用 /storage（用户熟悉）
            add(
              item.startsWith('/')
                ? item
                : `${root.display}/${item.slice(2)}`
            )
          },
          (kill) => killers.push(kill)
        )
      } catch {
        // 单个根失败不影响其它根
      }
      onProgress(root.display, found)
    }
  })
  await Promise.all(workers)
  flush(true)

  // 中途被新的搜索打断：不要保存半截索引，否则下一次搜索会漏文件
  if (aborted() || !entries.length) return null

  try {
    await fs.outputFile(fileIndexPath(deviceId), entries.join('\n'))
    const index = { entries, dirs: buildDirSet(entries), at: Date.now() }
    fileIndexes.set(deviceId, index)
    return index
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 全盘搜索执行
// ---------------------------------------------------------------------------

async function searchAllDisksWithIndex(
  deviceId: string,
  currentPath: string,
  keyword: string,
  started: number,
  killers: Array<() => void>,
  aborted: () => boolean,
  offset: number,
  limit: number
): Promise<{ files: IFile[]; total: number } | null> {
  const emitProgress = (root: string, found: number) => {
    window.sendTo('main', 'searchProgress', {
      deviceId,
      root,
      found,
      elapsedMs: Date.now() - started,
    })
  }
  const emitFiles = (files: IFile[]) => {
    if (files.length) {
      window.sendTo('main', 'searchResults', { deviceId, kw: keyword, files })
    }
  }

  const cached = loadFileIndex(deviceId)
  if (cached && Date.now() - cached.at < INDEX_TTL) {
    // 命中索引：只查内存，不再碰设备（补元数据一次批量 stat）
    const hits = searchFileIndex(deviceId, cached, keyword)
    emitProgress('索引', hits.length)
    const files = hitsToFiles(hits.slice(offset, offset + limit))
    await statSearchHits(deviceId, files)
    return { files, total: hits.length }
  }

  const index = await withIndexLock(() =>
    buildFileIndex(
      deviceId,
      currentPath,
      keyword,
      emitFiles,
      emitProgress,
      killers,
      aborted
    )
  )
  if (index) {
    const hits = searchFileIndex(deviceId, index, keyword)
    const files = hitsToFiles(hits.slice(offset, offset + limit))
    await statSearchHits(deviceId, files)
    return { files, total: hits.length }
  }

  // 建索引失败（老设备没有 stat/-exec +）：交给整盘 find 兜底
  return null
}

/** 兜底：不支持索引的老设备，仍按 find 逐根扫（会慢一些）。 */
async function liveSearchAllDisks(
  deviceId: string,
  currentPath: string,
  safeKeyword: string,
  killers: Array<() => void>,
  aborted: () => boolean
): Promise<IFile[]> {
  const roots = await getSearchRoots(deviceId, currentPath)
  const mode = await getFindExecMode(deviceId)
  const follow = (await supportsFindFollow(deviceId)) ? '-L ' : ''

  const found: IFile[] = []
  const seen = new Set<string>()
  const started = Date.now()
  const emit = (root: string) =>
    window.sendTo('main', 'searchProgress', {
      deviceId,
      root,
      found: found.length,
      elapsedMs: Date.now() - started,
    })

  for (const root of roots) {
    if (aborted()) break
    emit(root.display)
    const timer = setInterval(() => emit(root.display), 500)

    try {
      if (mode !== 'plain') {
        let lines = 0
        let parsed = 0
        const cmd = findCommand(root.scan, safeKeyword, mode, follow, 1000)

        await spawnAdbLines(
          ['-s', deviceId, 'shell', cmd],
          180000,
          (line) => {
            lines++
            const files = parseSearchLines([line])
            if (files.length) parsed++
            for (const file of files) {
              const name = file.name.startsWith('/')
                ? file.name
                : `${root.display}/${file.name}`
              if (seen.has(name)) continue
              seen.add(name)
              file.name = name
              found.push(file)
            }
          },
          (kill) => killers.push(kill)
        )

        // 输出有内容但一行都没解析出来：说明 ls -ld 格式不认，退回只搜文件名
        if (lines > 0 && parsed === 0) {
          await searchRootByNames(
            deviceId,
            root.scan,
            safeKeyword,
            follow,
            seen,
            found,
            killers,
            root.display
          )
        }
      } else {
        await searchRootByNames(
          deviceId,
          root.scan,
          safeKeyword,
          follow,
          seen,
          found,
          killers,
          root.display
        )
      }
    } catch {
      // 单个根超时/无权限：继续搜下一个根
    } finally {
      clearInterval(timer)
      emit(root.display)
    }
  }
  return found
}

/**
 * 搜索入口：
 * - 存储盘递归（覆盖子目录），其它路径只搜当前目录；
 * - 老系统没有 toybox ls 时退回 adb 同步协议。
 */
const searchDir: IpcSearchDir = async (
  deviceId,
  target,
  keyword,
  allDisks,
  offset = 0,
  limit = 1000
) => {
  const kw = keyword.trim()
  if (!kw) return { files: [], total: 0 }

  const safeKeyword = kw.replace(/'/g, "'\\''")

  // 新搜索开始：先终止同一台设备上还在跑的上一轮 find。
  // 每次搜索都注册 kill 句柄（不只是全盘）：默认搜索也可能在大目录里跑很久
  const previous = activeSearches.get(deviceId)
  if (previous) previous()

  const killers: Array<() => void> = []
  let cancelled = false
  const killer = () => {
    cancelled = true
    for (const kill of killers) kill()
  }
  activeSearches.set(deviceId, killer)

  try {
    // 直接粘贴完整路径（/media/hdf/202412/60000120.ys）：精确命中只返回它；
    // 没命中就把文件名当关键字，在所在目录里递归找
    if (kw.startsWith('/') && kw !== '/') {
      const slash = kw.lastIndexOf('/')
      const dir = slash === 0 ? '/' : kw.slice(0, slash + 1)
      const base = kw.slice(slash + 1)

      if (base) {
        try {
          const result = await spawnAdb(
            ['-s', deviceId, 'shell', `ls -ld ${shellQuotePath(kw)} 2>/dev/null`],
            30000
          )
          const exact = parseSearchLines(String(result.stdout || '').split('\n'))
          if (exact.length) {
            exact[0].name = kw
            return { files: exact, total: 1 }
          }
        } catch {
          // 路径不存在/无权限：继续按目录 + 文件名找
        }

        const baseKeyword = base.replace(/'/g, "'\\''")
        const follow = (await supportsFindFollow(deviceId)) ? '-L ' : ''
        const mode = await getFindExecMode(deviceId)
        const found: IFile[] = []
        const seen = new Set<string>()

        if (mode === 'plain') {
          await searchRootByNames(
            deviceId,
            dir,
            baseKeyword,
            follow,
            seen,
            found,
            killers
          )
        } else {
          const cmd = findCommand(dir, baseKeyword, mode, follow, 500)
          await spawnAdbLines(
            ['-s', deviceId, 'shell', cmd],
            120000,
            (line) => {
              for (const file of parseSearchLines([line])) {
                if (!file.name.startsWith('/')) file.name = dir + file.name
                if (seen.has(file.name)) continue
                seen.add(file.name)
                found.push(file)
              }
            },
            (kill) => killers.push(kill)
          )
        }

        if (cancelled) return { files: [], total: 0 }
        return { files: found, total: found.length }
      }
    }

    // 全盘：有现成索引就查内存，否则边整盘遍历边建索引并推结果
    if (allDisks) {
      const started = Date.now()
      const page = await searchAllDisksWithIndex(
        deviceId,
        target,
        kw,
        started,
        killers,
        () => cancelled,
        offset,
        limit
      )

      const result =
        page === null
          ? slicePage(
              await liveSearchAllDisks(
                deviceId,
                target,
                safeKeyword,
                killers,
                () => cancelled
              ),
              offset,
              limit
            )
          : page

      if (cancelled) return { files: [], total: 0 }

      window.sendTo('main', 'searchProgress', {
        deviceId,
        root: '完成',
        found: result.total,
        elapsedMs: Date.now() - started,
      })
      return result
    }

    // 当前目录递归
    if (canSearchRecursive(target) && (await supportsRecursiveFind(deviceId))) {
      const follow = (await supportsFindFollow(deviceId)) ? '-L ' : ''
      const mode = await getFindExecMode(deviceId)

      if (mode === 'plain') {
        const files: IFile[] = []
        const seen = new Set<string>()
        await searchRootByNames(
          deviceId,
          target,
          safeKeyword,
          follow,
          seen,
          files,
          killers
        )
        if (cancelled) return { files: [], total: 0 }
        return { files, total: files.length }
      }

      const cmd = findCommand(target, safeKeyword, mode, follow, 500)
      const files: IFile[] = []
      const seen = new Set<string>()
      const result = await spawnAdbLines(
        ['-s', deviceId, 'shell', cmd],
        60000,
        (line) => {
          for (const file of parseSearchLines([line])) {
            if (seen.has(file.name)) continue
            seen.add(file.name)
            files.push(file)
          }
        },
        (kill) => killers.push(kill)
      )

      if (cancelled) return { files: [], total: 0 }
      if (result.timedOut) throw new Error('搜索超时：结果不完整，请缩小范围')
      return { files, total: files.length }
    }

    // 不支持递归：当前目录内过滤
    const syncMode =
      (target.startsWith('/data/') && !target.startsWith('/data/local/tmp/')) ||
      !(await lsFollowsSymlink(deviceId))

    if (syncMode) {
      const all = await readDirSorted(deviceId, target)
      const lower = kw.toLowerCase()
      const hit = all.filter((file) => file.name.toLowerCase().includes(lower))
      return { files: hit, total: hit.length }
    }

    const q = shellQuotePath(target)
    const cmd = `${dirsFirst(q)} | grep -iF -- '${safeKeyword}' | head -n 3000`
    const result = await spawnAdb(['-s', deviceId, 'shell', cmd], 60000)
    const files = parseSearchLines(String(result.stdout || '').split('\n'))
    return { files, total: files.length }
  } finally {
    if (activeSearches.get(deviceId) === killer) activeSearches.delete(deviceId)
  }
}

// ---------------------------------------------------------------------------
// /data 下的特殊目录（非 root 走 run-as / pm 列表）
// ---------------------------------------------------------------------------

async function readDataDir(deviceId: string, target: string) {
  if (target.startsWith('/data/app/')) return readDataAppDir(deviceId, target)
  if (target.startsWith('/data/data/')) return readDataDataDir(deviceId, target)

  const stat = await statFile(deviceId, '/data')
  // 面包屑返回上一级时拿到的是 /data/local（没有尾斜杠），
  // 以前只匹配带斜杠的写法，会掉进下面的兜底，显示一份假的 data/app/local 列表
  const nor = target.replace(/\/+$/, '') || '/'

  if (nor === '/data/local') {
    return [
      {
        name: 'tmp',
        directory: true,
        mtime: stat.mtime,
        mode: stat.mode,
        size: stat.size,
      },
    ]
  }

  if (nor === '/data') {
    // /data 根：其余子目录是应用数据（SELinux 拒绝），只暴露这三个入口
    return ['data', 'app', 'local'].map((name) => ({
      name,
      directory: true,
      mtime: stat.mtime,
      mode: stat.mode,
      size: stat.size,
    }))
  }

  // 其它 /data/*（/data/media、/data/system 等）没有特殊通道：
  // 真读一次，读不到就让界面显示无权限，不要伪造条目
  return readDirSorted(deviceId, nor)
}

async function readDataAppDir(deviceId: string, target: string) {
  const packages = String(await shell(deviceId, 'pm list packages -f'))
  const prefix = `package:${target}`
  const lines = packages
    .split('\n')
    .filter((line) => line.trim() !== '' && line.includes(prefix))

  const paths = lines.map((line) => line.slice(prefix.length).split('/'))
  const stat = await statFile(deviceId, '/data')

  const result: any[] = []
  for (const segments of paths) {
    if (segments.length > 1) {
      result.push({
        name: segments[0],
        directory: true,
        mtime: stat.mtime,
        mode: stat.mode,
        size: stat.size,
      })
    } else if (segments[0].includes('.apk')) {
      const name = segments[0].split('.apk')[0] + '.apk'
      const apkStat = await statFile(deviceId, target + name)
      result.push({
        name,
        directory: false,
        mtime: apkStat.mtime,
        mode: apkStat.mode,
        size: apkStat.size,
      })
    }
  }
  return result
}

async function readDataDataDir(deviceId: string, target: string) {
  const stat = await statFile(deviceId, '/data')

  if (target === '/data/data/') {
    const packages = await getPackages(deviceId)
    return packages.map((pkg) => ({
      name: pkg,
      directory: true,
      mtime: stat.mtime,
      mode: stat.mode,
      size: stat.size,
    }))
  }

  const ls = await fileShell(deviceId, 'ls -al', target)
  if (ls.includes('not debuggable')) return []

  const result: any[] = []
  for (const line of String(ls).split('\n')) {
    const item = parseLsLine(line)
    if (item) result.push(item)
  }
  return result
}

/**
 * 设备端执行文件命令：/data/data 下非 root 走 run-as。
 * 路径来自设备返回的文件名，可能含引号/$/反引号，必须转义，
 * 否则等于在设备端执行任意命令。
 */
async function fileShell(
  deviceId: string,
  cmd: string,
  devicePath: string,
  dest?: string,
  checked = false,
  timeoutMs = 15000
) {
  const exec = checked ? shellChecked : shell

  if (
    devicePath.startsWith('/data/data/') ||
    (dest && dest.startsWith('/data/data/'))
  ) {
    if (!(await isRooted(deviceId))) {
      const source = dest && dest.startsWith('/data/data/') ? dest : devicePath
      const pkg = source.replace('/data/data/', '').split('/')[0]
      return exec(
        deviceId,
        `run-as ${shellQuotePath(pkg)} ${cmd} ${shellQuotePath(
          devicePath
        )}${dest ? ' ' + shellQuotePath(dest) : ''}`,
        timeoutMs
      )
    }
  }

  return exec(
    deviceId,
    `${cmd} ${shellQuotePath(devicePath)}${dest ? ' ' + shellQuotePath(dest) : ''}`,
    timeoutMs
  )
}

const statFile: IpcStatFile = async (deviceId, devicePath) => {
  // /data/data 下非 root：run-as 走 ls -ld，解析不了就直接报错
  if (devicePath.startsWith('/data/data/') && !(await isRooted(deviceId))) {
    const ls = await fileShell(deviceId, 'ls -ld', devicePath)
    const item = parseLsLine(String(ls).trim())
    if (!item) throw new Error(`Failed to stat file: ${devicePath}`)
    return {
      size: item.size,
      mtime: item.mtime,
      directory: item.directory,
      mode: item.mode,
    }
  }

  const device = await client.getDevice(deviceId)
  const stat = await device.stat(devicePath)
  return {
    size: stat.size,
    mtime: new Date(stat.mtimeMs),
    directory: !stat.isFile(),
    mode: stat.mode,
  }
}

export async function init(c: Client) {
  client = c

  handleEvent('pullFile', pullFile)
  handleEvent('pushFile', pushFile)
  handleEvent('readDir', readDir)
  handleEvent('readDirPage', readDirPage)
  handleEvent('searchDir', searchDir)
  handleEvent('resetFileIndex', (deviceId: string) => resetFileIndex(deviceId))
  handleEvent('openFile', openFile)
  handleEvent('deleteFile', deleteFile)
  handleEvent('deleteDir', deleteDir)
  handleEvent('createDir', createDir)
  handleEvent('moveFile', moveFile)
  handleEvent('pasteFiles', pasteFiles)
  handleEvent('statFile', statFile)
}
