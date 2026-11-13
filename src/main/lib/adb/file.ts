import { Client } from '@devicefarmer/adbkit'
import fs from 'fs-extra'
import os from 'node:os'
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
import map from 'licia/map'
import filter from 'licia/filter'
import startWith from 'licia/startWith'
import contain from 'licia/contain'
import trim from 'licia/trim'
import each from 'licia/each'
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

const fileSemaphore = new Semaphore(5)
const waitFileSemaphore = function (): Promise<void> {
  return new Promise((resolve) => {
    fileSemaphore.wait(() => resolve())
  })
}

// 目录递归时 stat/readdir 之前不受限：几千个文件会同时开几千条 adb 连接。
// 单独给元数据操作限流，文件传输仍走 fileSemaphore(5)。
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

const pullFile: IpcPullFile = async function (deviceId, src, dest) {
  const stat = await withMetaSlot(() => statFile(deviceId, src))

  if (stat.directory) {
    await fs.ensureDir(dest)
    const files = await withMetaSlot(() => readDir(deviceId, src))
    // 分批递归：不一次把整目录的 pullFile 全推出去（stat 已限流，这里再压并发）
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(
        files
          .slice(i, i + 8)
          .map((file) =>
            pullFile(
              deviceId,
              src + '/' + file.name,
              path.join(dest, file.name)
            )
          )
      )
    }
  } else {
    await waitFileSemaphore()
    // 目标目录可能还不存在（例如下载到 Downloads 下的子目录），
    // 先建父目录，否则 createWriteStream 直接 ENOENT，进度停在 0%
    await fs.ensureDir(path.dirname(dest))
    // 拿到信号量之后任何一条路径都不能漏掉 signal()，否则 5 次失败后整个文件页永久卡死
    let released = false
    const release = () => {
      if (released) return
      released = true
      fileSemaphore.signal()
    }

    try {
      const id = uuid()

      // 非 root 读 /data/data：原来是「shell 用户 touch 到 /data/local/tmp →
      // run-as 应用身份 cp 过去」，可应用对 shell:shell 0771 的 tmp 目录没有写权限，
      // cp 必然失败；而 shell() 不返回退出码，失败被当成成功，最后落一个 0 字节文件。
      // 改成 exec-out 让 run-as 直接把内容流到本地，设备上不落盘。
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
        const r = await spawnAdbBuffer(
          [
            '-s',
            deviceId,
            'exec-out',
            `run-as ${shellQuotePath(pkg)} cat ${shellQuotePath(rel)}`,
          ],
          120000
        )
        if (r.timedOut) throw new Error('拉取超时')
        if (r.code !== 0)
          throw new Error('拉取失败：没有权限读取该文件（设备未 root）')
        const expected = stat.size || 0
        if (expected > 0 && r.buffer.length !== expected) {
          throw new Error(
            `文件不完整：期望 ${expected} 字节，实际 ${r.buffer.length} 字节`
          )
        }
        await fs.writeFile(dest, r.buffer)
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
        const clearnup = (err?: any) => {
          if (settled) return
          settled = true
          release()
          if (err) {
            // 失败时把写流和 adbkit 的 sync 传输一起收掉，否则 sync 连接会一直挂在 adb server 上
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
          window.sendTo('main', 'finishTransfer', id, !err)
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        }
        writable = fs.createWriteStream(dest)
        // 磁盘满/无权限时 WriteStream 会发 error，没有监听就是主进程未捕获异常
        writable.on('error', (err) => clearnup(err))
        writable.on('finish', () => clearnup())
        transfer.on(
          'progress',
          throttle(({ bytesTransferred }) => {
            window.sendTo('main', 'updateTransfer', id, bytesTransferred)
          }, 500)
        )
        transfer.on('error', (err) => clearnup(err))
        transfer.pipe(writable)
      })
    } catch (e) {
      release()
      throw e
    }
  }
}

const openFile: IpcOpenFile = async function (deviceId, p) {
  const dest = path.join(os.tmpdir(), path.basename(p))
  await pullFile(deviceId, p, dest)
  electronShell.openPath(dest)
}

const deleteFile: IpcDeleteFile = async function (deviceId, path) {
  // checked：rm 失败（只读挂载/权限不足）必须报错，不能让 UI 显示删除成功
  await fileShell(deviceId, 'rm', path, undefined, true, 120000)
  resetFileIndex(deviceId)
}

const deleteDir: IpcDeleteDir = async function (deviceId, path) {
  await fileShell(deviceId, 'rm -rf', path, undefined, true, 600000)
  resetFileIndex(deviceId)
}

const createDir: IpcCreateDir = async function (deviceId, path) {
  await fileShell(deviceId, 'mkdir -p', path, undefined, true, 60000)
  resetFileIndex(deviceId)
}

const pushFile: IpcPushFile = async function (
  deviceId: string,
  src: string,
  dest: string
) {
  const stat = await fs.stat(src)

  if (stat.isDirectory()) {
    await createDir(deviceId, dest)
    const files = await fs.readdir(src)
    const pushes: Promise<void>[] = []
    for (let i = 0, len = files.length; i < len; i++) {
      const name = files[i]
      pushes.push(pushFile(deviceId, path.join(src, name), dest + '/' + name))
    }
    await Promise.all(pushes)
  } else {
    await waitFileSemaphore()
    let released = false
    const release = () => {
      if (released) return
      released = true
      fileSemaphore.signal()
    }

    let tmpFilePath = ''
    try {
      if (startWith(dest, '/data/data/')) {
        if (!(await isRooted(deviceId))) {
          tmpFilePath = '/data/local/tmp/' + uuid()
        }
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
        const done = (err?: any) => {
          if (settled) return
          settled = true
          release()
          window.sendTo('main', 'finishTransfer', id, !err)
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        }
        const cleanup = (err?: any) => {
          if (settled) return
          // 失败时不要往 /data/data 里拷半个文件，直接删掉临时文件
          if (err || !tmpFilePath) {
            if (tmpFilePath) deleteFile(deviceId, tmpFilePath).catch(() => {})
            return done(err)
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
            window.sendTo('main', 'updateTransfer', id, bytesTransferred)
          }, 500)
        )
        transfer.on('error', (err) => cleanup(err))
      })
    } catch (e) {
      release()
      throw e
    }
    resetFileIndex(deviceId)
  }
}

const moveFile: IpcMoveFile = async function (deviceId, src, dest) {
  // mv 会静默覆盖同名文件。重命名只该改名字，不该顺手删掉一个文件：
  // 上层界面只看到当前分页，目标可能在未加载的下一页里，必须在设备侧再拦一次。
  if (await devicePathExists(deviceId, dest)) {
    throw new Error('目标已存在同名文件')
  }
  // checked：mv 失败（只读挂载/权限）必须报错，不能显示重命名成功
  await fileShell(deviceId, 'mv', src, dest, true, 120000)
  resetFileIndex(deviceId)
}

function joinDevicePath(dir: string, name: string) {
  if (!dir || dir === '/') return '/' + name
  return dir.replace(/\/+$/, '') + '/' + name
}

async function devicePathExists(deviceId: string, path: string) {
  const out = await shell(
    deviceId,
    `[ -e ${shellQuotePath(path)} ] && echo 1 || echo 0`
  )
  return String(out).trim() === '1'
}

// 复制/剪切粘贴：目标重名时自动加 " (1)"，逐个处理，单个失败不影响其余
const pasteFiles: IpcPasteFiles = async function (
  deviceId,
  sources,
  dest,
  cut
) {
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

const readDir: IpcReadDir = async function (deviceId, path) {
  if (startWith(path, '/data/') && !startWith(path, '/data/local/tmp/')) {
    if (!(await isRooted(deviceId))) {
      return readDataDir(deviceId, path)
    }
  }

  const device = await client.getDevice(deviceId)
  const files: any[] = await device.readdir(path)

  const ret: any[] = []
  for (let i = 0, len = files.length; i < len; i++) {
    const file = files[i]
    const item: IFile = {
      name: file.name,
      directory: !file.isFile(),
      mtime: new Date(file.mtimeMs),
      mode: file.mode,
    }

    if (!item.directory) {
      item.size = file.size
      const ext = splitPath(file.name).ext
      item.mime = mime(ext.slice(1))
    }

    ret.push(item)
  }

  return ret
}

function shellQuotePath(p: string) {
  return "'" + p.replace(/'/g, "'\\''") + "'"
}

// Android 6.0 及更早的 ls 是 toolbox：不认 -L（直接 abort，整页为空），
// 7.0 起换成 toybox 才支持。每条命令都试错太慢，按设备探测一次并缓存。
const lsFollowCache = new Map<string, Promise<boolean>>()
function lsFollowsSymlink(deviceId: string): Promise<boolean> {
  let probe = lsFollowCache.get(deviceId)
  if (!probe) {
    probe = shell(
      deviceId,
      `ls -laL / >/dev/null 2>&1 && echo aya_ls_follow || echo aya_ls_plain`
    )
      .then((out) => contain(out, 'aya_ls_follow'))
      .catch(() => false)
    lsFollowCache.set(deviceId, probe)
  }
  return probe
}

// 老系统（toolbox ls）不再解析 shell 输出：格式、软链、权限全是坑，
// 直接用 adb 同步协议列目录，代价是一次把所有条目取回来
async function readDirSorted(deviceId: string, path: string): Promise<IFile[]> {
  const dir = path.length > 1 ? path.replace(/\/+$/, '') : path
  const all = await readDir(deviceId, dir)
  return all.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

// 设备上不一定有 awk：用两次 ls + grep 拼出「目录在前、文件在后」的顺序；
// 大目录里文件夹若按字母序排在上千个文件之后，首页就会「看不到文件夹」
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

// 搜索是递归的：存储盘用设备端 find，结果里的 name 是相对当前目录的路径，
// 双击/右键直接拼 path 就能打开。
// /media、/usb、/udisk 也要算：不同厂商的挂载点不统一，有的机器外接盘只出现在
// /media 下，只认 /sdcard、/storage、/mnt 就会「明明有文件却搜不到」。
const RECURSIVE_ROOTS = [
  '/sdcard',
  '/storage',
  '/mnt',
  '/media',
  '/usb',
  '/udisk',
  '/data/media',
]
function canSearchRecursive(path: string) {
  for (let i = 0; i < RECURSIVE_ROOTS.length; i++) {
    if (startWith(path, RECURSIVE_ROOTS[i])) return true
  }
  return false
}

// Android 4.4 之类的 toolbox find 不认 -iname/-maxdepth：探测一次，
// 不支持就退回「只搜当前目录」
const findCache = new Map<string, Promise<boolean>>()
function supportsRecursiveFind(deviceId: string): Promise<boolean> {
  let probe = findCache.get(deviceId)
  if (!probe) {
    probe = shell(
      deviceId,
      `find . -maxdepth 0 -iname aya >/dev/null 2>&1 && echo aya_find_ok || echo aya_find_no`
    )
      .then((out) => contain(out, 'aya_find_ok'))
      .catch(() => false)
    findCache.set(deviceId, probe)
  }
  return probe
}

// 全盘搜索要覆盖的根。不同设备挂载点差异很大：/storage、/media、/mnt/media_rw、
// /mnt/usb、/usb、/udisk…… 只写死一两个根必然漏盘。
// 先读 /proc/mounts 收集所有真实存储挂载点（厂商自定义路径也能覆盖），
// 再补一组常见根（/media 可能只是根分区上的普通目录，不会出现在 mount 里）；
// 最后探测哪些真实存在且可读。
// /sdcard 只是 /storage/emulated/0 的别名，/storage 存在时跳过，
// 否则同一个文件会以两个绝对路径出现、去重去不掉。
const BASE_SEARCH_ROOTS = [
  '/storage',
  '/media',
  '/mnt',
  '/sdcard',
  '/usb',
  '/udisk',
  '/data/media',
]

// 这些 fstype 才是「用户文件盘」；tmpfs/proc/overlay 之类不搜
const STORAGE_FS = new Set([
  'ext2',
  'ext3',
  'ext4',
  'f2fs',
  'vfat',
  'exfat',
  'ntfs',
  'ntfs3',
  'fuseblk',
  'texfat',
  'msdos',
  'iso9660',
  'udf',
  'sdcardfs',
  'fuse',
  'esdfs',
])

// Android 会在 /mnt 下挂一堆同一份存储的运行时视图，逐个搜只会重复和拖慢
const SKIP_MOUNTS = [
  '/mnt/runtime/',
  '/mnt/user/',
  '/mnt/installer',
  '/mnt/androidwritable',
  '/mnt/pass_through',
  '/mnt/asec',
  '/mnt/obb',
  '/mnt/secure',
  '/mnt/expand',
  '/storage/self',
  '/data/media/obb',
  '/data/media/android_secure',
  // /data 下都是应用数据：整盘扫又慢又不是用户文件（用户文件在 /data/media）
  '/data/user',
  '/data/app',
  '/data/data',
  '/data/system',
  '/data/vendor',
  '/data/misc',
  '/data/adb',
  '/data/anr',
  '/data/tombstones',
  '/data/dalvik-cache',
  '/data/local',
  '/data_mirror',
]
// 系统分区不是用户的文件盘，扫它们又慢又没结果
const SYSTEM_MOUNT = /^\/(system|system_ext|vendor|vendor_dlkm|product|odm|odm_dlkm|apex|cache|metadata|persist|efs|firmware|boot|init|dev|proc|sys|acct|config)(\/|$)/

function isStorageMount(mountPoint: string, fsType: string) {
  if (!STORAGE_FS.has(fsType)) return false
  if (mountPoint === '/' || mountPoint === '/data') return false
  // /data 除了 /data/media（用户文件）以外全是应用数据
  if (startWith(mountPoint, '/data') && !startWith(mountPoint, '/data/media')) {
    return false
  }
  if (SYSTEM_MOUNT.test(mountPoint)) return false
  for (const skip of SKIP_MOUNTS) {
    if (startWith(mountPoint, skip)) return false
  }
  if (
    mountPoint.indexOf('/Android/data') >= 0 ||
    mountPoint.indexOf('/Android/obb') >= 0
  ) {
    return false
  }
  return true
}

// 全盘搜索的根：scan 用来遍历（可能是内核直挂路径），display 是给用户看的路径。
// /storage/uuid（fuse）遍历 20 万个文件要 80 秒，对应的 /mnt/media_rw/uuid（ext4）只要 6 秒。
interface ISearchRoot {
  scan: string
  display: string
}

async function computeSearchRoots(deviceId: string): Promise<ISearchRoot[]> {
  const roots = new Set<string>()
  const allMounts = new Set<string>()

  // /proc/mounts：厂商把盘挂在哪都能发现
  try {
    const mounts = await shell(deviceId, 'cat /proc/mounts 2>/dev/null')
    for (const line of String(mounts).split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 3) continue
      const mountPoint = parts[1].replace(/\\040/g, ' ')
      if (!startWith(mountPoint, '/')) continue
      allMounts.add(mountPoint)
      if (isStorageMount(mountPoint, parts[2])) roots.add(mountPoint)
    }
  } catch {
    // 读不到就只用下面的兜底根
  }

  // 常见根兜底 + 存在性/可读性探测。
  // /storage、/mnt 只是容器：已经发现它们下面的真实挂载点时就不再整根扫，
  // 否则 /storage/self 这类软链会被 find -L 跟着再走一遍，同一个文件出两条结果。
  const mountList = Array.from(roots)
  const hasStorageMount = mountList.some((p) => startWith(p, '/storage/'))
  const hasMntMount = mountList.some((p) => startWith(p, '/mnt/'))
  const bases = BASE_SEARCH_ROOTS.filter((p) => {
    if (p === '/storage') return !hasStorageMount
    if (p === '/mnt') return !hasMntMount
    if (p === '/sdcard') return !hasStorageMount
    return true
  })
  try {
    const list = bases.map(shellQuotePath).join(' ')
    const out = await shell(
      deviceId,
      `for p in ${list}; do [ -d "$p" ] && [ -r "$p" ] && [ -x "$p" ] && echo "$p"; done`
    )
    for (const line of String(out).split('\n')) {
      const p = line.trim()
      if (p) roots.add(p)
    }
  } catch {
    // ignore
  }

  // 再把根目录下所有真实目录纳入：厂商自定义路径（/media、/hdf、/record、/opt…）
  // 不一定是挂载点，也不在常见列表里。只排除伪文件系统、系统分区和 /data
  // （/data 是应用数据，整盘扫太慢，用户文件在 /data/media，已单独覆盖）。
  const SKIP_TOP = new Set([
    '/proc',
    '/sys',
    '/dev',
    '/acct',
    '/config',
    '/d',
    '/etc',
    '/bin',
    '/res',
    '/oem',
    '/system',
    '/system_ext',
    '/vendor',
    '/vendor_dlkm',
    '/product',
    '/odm',
    '/odm_dlkm',
    '/apex',
    '/data',
    '/data_mirror',
    '/cache',
    '/metadata',
    '/persist',
    '/efs',
    '/firmware',
    '/boot',
    '/init',
    '/sbin',
    '/lost+found',
    '/tmp',
    '/var',
    '/linkerconfig',
    '/debug_ramdisk',
    '/storage',
    '/mnt',
    '/sdcard',
  ])
  try {
    const out = await shell(
      deviceId,
      'for d in /*; do [ -d "$d" ] && echo "$d"; done'
    )
    for (const line of String(out).split('\n')) {
      const p = line.trim()
      if (p && !SKIP_TOP.has(p)) roots.add(p)
    }
  } catch {
    // ignore
  }

  if (!roots.size) {
    return [
      { scan: '/storage', display: '/storage' },
      { scan: '/mnt', display: '/mnt' },
    ]
  }

  // 优先用直挂路径遍历：/storage/<卷> 是 fuse 视图，遍历 20 万文件要 80 秒，
  // 同一个卷的 /mnt/media_rw/<卷> 是 ext4 直挂，只要 6 秒；显示路径仍用 /storage
  const scanToDisplay = new Map<string, string>()
  const aliasCandidates: Array<[string, string]> = []
  for (const p of Array.from(roots)) {
    if (p === '/storage/emulated') {
      aliasCandidates.push(['/data/media', '/storage/emulated'])
    } else if (startWith(p, '/storage/') && p !== '/storage') {
      const id = p.slice('/storage/'.length)
      if (id && id.indexOf('/') < 0) {
        const direct = '/mnt/media_rw/' + id
        if (allMounts.has(direct)) aliasCandidates.push([direct, p])
      }
    }
  }
  if (aliasCandidates.length) {
    try {
      const list = aliasCandidates.map(([scan]) => shellQuotePath(scan)).join(' ')
      const out = await shell(
        deviceId,
        `for p in ${list}; do [ -r "$p" ] && [ -x "$p" ] && echo "$p"; done`
      )
      const readable = new Set(
        String(out)
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      )
      for (const [scan, display] of aliasCandidates) {
        if (!readable.has(scan)) continue
        roots.delete(display)
        roots.add(scan)
        scanToDisplay.set(scan, display)
      }
    } catch {
      // 探测失败就用原来的 fuse 路径
    }
  }

  // /media 这类常见是 /mnt/media_rw/<卷> 或 /storage/<卷> 的软链：如果目标根已经
  // 在列表里，只留真实根，否则同一个文件会同时以 /media/... 和 /storage/... 出现
  if (roots.size > 1) {
    try {
      const list = Array.from(roots).map(shellQuotePath).join(' ')
      const out = await shell(
        deviceId,
        `for p in ${list}; do r=$(readlink -f "$p" 2>/dev/null); [ -n "$r" ] && [ "$r" != "$p" ] && echo "$p|$r"; done`
      )
      for (const line of String(out).split('\n')) {
        const parts = line.trim().split('|')
        const link = parts[0]
        const real = parts[1]
        if (!link || !real || !roots.has(link)) continue
        const covered = Array.from(roots).some(
          (p) =>
            p !== link &&
            (p === real || startWith(real, p.replace(/\/+$/, '') + '/'))
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
  // /sdcard、/mnt/sdcard 都是 /storage/emulated/0 的别名：有 storage 视图时丢掉，
  // 否则同一个文件会以 /mnt/sdcard/... 和 /storage/emulated/0/... 出现两条
  const hasEmulated = list.some(
    (r) => r.display === '/storage/emulated' || startWith(r.display, '/storage/emulated/')
  )
  if (hasEmulated) {
    list = list.filter((root) => {
      const d = root.display
      return !(
        d === '/sdcard' ||
        startWith(d, '/sdcard/') ||
        d === '/mnt/sdcard' ||
        startWith(d, '/mnt/sdcard/')
      )
    })
  }
  // 子根已被父根覆盖时去掉子根（/mnt/media_rw 在 /mnt 下）
  return list.filter(
    (root, i) =>
      !list.some(
        (parent, j) =>
          j !== i &&
          parent.scan !== root.scan &&
          startWith(root.scan, parent.scan.replace(/\/+$/, '') + '/')
      )
  )
}

// 挂载点不会每分钟变：缓存 30 秒，避免每敲一个字都重跑 4 条探测命令
const rootsCache = new Map<string, { ts: number; roots: ISearchRoot[] }>()
const ROOTS_TTL = 30000

async function getSearchRoots(
  deviceId: string,
  currentPath?: string
): Promise<ISearchRoot[]> {
  let cached = rootsCache.get(deviceId)
  if (!cached || Date.now() - cached.ts > ROOTS_TTL) {
    cached = { ts: Date.now(), roots: await computeSearchRoots(deviceId) }
    rootsCache.set(deviceId, cached)
  }
  const roots = cached.roots.slice()
  // 当前目录不在任何根里（比如 /data/local/tmp）：也算一个根，
  // 否则「全盘」反而搜不到眼前这个目录
  if (
    currentPath &&
    currentPath !== '/' &&
    currentPath.indexOf('\0') < 0 &&
    !roots.some(
      (r) =>
        currentPath === r.scan ||
        startWith(currentPath, r.scan.replace(/\/+$/, '') + '/')
    )
  ) {
    roots.push({ scan: currentPath, display: currentPath })
  }
  return roots
}

// 老设备的 find 不一定支持 `-exec ... {} +`（Android 4.x toolbox 就不认），
// 直接用它搜索会一行结果都没有。按设备探测一次：优先 +，其次 ;，
// 都不行就退回只列文件名（不带大小/时间），至少能搜到。
type FindExecMode = 'plus' | 'semi' | 'plain'
const findExecCache = new Map<string, Promise<FindExecMode>>()

// `find` 默认不跟软链：/media/hdf 这类子目录如果是软链，find . 会直接跳过，
// 表现就是扫了 30 秒一个结果都没有。按设备探测 -L 是否可用。
const findFollowCache = new Map<string, Promise<boolean>>()
function supportsFindFollow(deviceId: string): Promise<boolean> {
  let probe = findFollowCache.get(deviceId)
  if (!probe) {
    probe = shell(
      deviceId,
      'find -L / -maxdepth 0 >/dev/null 2>&1 && echo aya_follow_ok || echo aya_follow_no'
    )
      .then((out) => contain(out, 'aya_follow_ok'))
      .catch(() => false)
    findFollowCache.set(deviceId, probe)
  }
  return probe
}

function getFindExecMode(deviceId: string): Promise<FindExecMode> {
  let probe = findExecCache.get(deviceId)
  if (!probe) {
    probe = (async () => {
      const check = async (tail: string) => {
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
      if (await check('+')) return 'plus'
      if (await check(';')) return 'semi'
      return 'plain'
    })()
    findExecCache.set(deviceId, probe)
  }
  return probe
}

// 只按文件名搜（不依赖 ls/-exec）：老 find 上仍能出结果。
// 大小/时间拿不到，mtime 用当前时间占位；是不是目录再单独问一次 find -type d。
async function searchRootByNames(
  deviceId: string,
  root: string,
  safeKw: string,
  follow: string,
  seen: Set<string>,
  found: IFile[],
  killers?: Array<() => void>,
  displayRoot?: string
): Promise<number> {
  const prefix = displayRoot || root
  const q = shellQuotePath(root)
  const raw: string[] = []
  const r = await spawnAdbLines(
    [
      '-s',
      deviceId,
      'shell',
      `cd ${q} && find ${follow}. -iname '*${safeKw}*' -print 2>/dev/null | head -n 1000`,
    ],
    180000,
    (line) => {
      if (line.trim()) raw.push(line)
    },
    killers ? (kill) => killers.push(kill) : undefined
  )
  if (r.timedOut) return 0
  const names = raw
    .map((line) => line.trim())
    .filter((line) => startWith(line, './') || startWith(line, '/'))
    .map((line) => (startWith(line, '/') ? line : `${prefix}/${line.slice(2)}`))
  if (!names.length) return 0

  const dirs = new Set<string>()
  try {
    const d: string[] = []
    await spawnAdbLines(
      [
        '-s',
        deviceId,
        'shell',
        `cd ${q} && find ${follow}. -iname '*${safeKw}*' -type d -print 2>/dev/null | head -n 1000`,
      ],
      60000,
      (line) => {
        if (line.trim()) d.push(line)
      },
      killers ? (kill) => killers.push(kill) : undefined
    )
    for (const line of d) {
      const p = line.trim()
      if (!p) continue
      dirs.add(startWith(p, '/') ? p : `${prefix}/${p.slice(2)}`)
    }
  } catch {
    // 拿不到目录标记就当文件处理，至少名字能搜到
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
    if (!directory) {
      file.mime = mime(splitPath(name).ext.slice(1))
    }
    found.push(file)
    added++
  }
  return added
}

// 全盘搜索是整盘 find，同一台设备只保留最新一次：用户还在继续敲关键字时，
// 上一次的 find 必须被终止，否则设备上会同时跑好几个遍历整盘的进程，越搜越慢。
const activeSearches = new Map<string, () => void>()

function parseSearchLines(lines: string[]): IFile[] {
  const files: IFile[] = []
  for (let i = 0, len = lines.length; i < len; i++) {
    const parsed: any = parseLsLine(lines[i])
    if (!parsed) continue
    // find 输出的是 "./a/b" 这种相对路径，去掉前缀直接用作显示名
    let name = parsed.name
    if (startWith(name, './')) name = name.slice(2)
    if (!name) continue
    if (!parsed.directory) {
      parsed.mime = mime(splitPath(name).ext.slice(1))
    }
    parsed.name = name
    files.push(parsed)
  }
  return files
}

// 拼「cd 根 && find」命令：先 cd 进根（根本身是软链也能进），
// -exec 的形态按设备能力选；都不支持就只列文件名。
function findCommand(
  root: string,
  safeKw: string,
  mode: FindExecMode,
  follow: string,
  limit: number
) {
  const q = shellQuotePath(root)
  const base = `cd ${q} && find ${follow}. -iname '*${safeKw}*'`
  if (mode === 'plus') {
    return `${base} -exec ls -ld {} + 2>/dev/null | head -n ${limit}`
  }
  if (mode === 'semi') {
    return `${base} -exec ls -ld {} \\; 2>/dev/null | head -n ${limit}`
  }
  return `${base} -print 2>/dev/null | head -n ${limit}`
}

// ---------- 全盘搜索索引 ----------
// Android 没有 Everything 那种系统级文件表：第一次整盘遍历时把路径建成索引，
// 之后同一台设备的全盘搜索只查内存（毫秒级）；30 分钟后或文件操作后重建。
const INDEX_TTL = 30 * 60 * 1000
const INDEX_MAX_ENTRIES = 300000
interface IFileIndex {
  entries: string[] // "d\t/path" | "f\t/path"
  // 目录集合：索引只存路径不带类型，父路径出现过就说明是目录
  dirs: Set<string>
  ts: number
}

function buildDirSet(entries: string[]) {
  const dirs = new Set<string>()
  for (const entry of entries) {
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const p = entry.slice(tab + 1)
    const slash = p.lastIndexOf('/')
    if (slash > 0) dirs.add(p.slice(0, slash))
  }
  return dirs
}
const fileIndexes = new Map<string, IFileIndex>()

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
    const idx = { entries, dirs: buildDirSet(entries), ts: fs.statSync(file).mtimeMs }
    fileIndexes.set(deviceId, idx)
    return idx
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

// 全量结果缓存：翻页时不用每次重扫 20 万条索引；10 秒内同设备同关键字直接复用
type IIndexHit = { path: string; directory: boolean; score: number }
let indexSearchCache: {
  deviceId: string
  kw: string
  hits: IIndexHit[]
  ts: number
} | null = null

// 只收集轻量命中（不做 IFile/Date/mime 分配）：26k 命中时对象分配是大头，
// 真正要返回给 UI 的那一页才构造 IFile。
function searchFileIndex(
  deviceId: string,
  idx: IFileIndex,
  kw: string
): IIndexHit[] {
  if (
    indexSearchCache &&
    indexSearchCache.deviceId === deviceId &&
    indexSearchCache.kw === kw &&
    Date.now() - indexSearchCache.ts < 10000
  ) {
    return indexSearchCache.hits
  }
  const lower = kw.toLowerCase()
  const hits: IIndexHit[] = []
  const entries = idx.entries
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
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
      directory: entry[0] === 'd' || idx.dirs.has(filePath),
      // 文件名开头命中优先，其次名字短的（更接近用户要找的东西）
      score: at * 10000 + name.length,
    })
  }
  hits.sort((a, b) => a.score - b.score)
  indexSearchCache = { deviceId, kw, hits, ts: Date.now() }
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

const statFormatCache = new Map<string, Promise<boolean>>()
function supportsStatFormat(deviceId: string): Promise<boolean> {
  let probe = statFormatCache.get(deviceId)
  if (!probe) {
    probe = shell(
      deviceId,
      `find / -maxdepth 0 -exec stat -c '%F|%s|%Y|%a|%n' {} + 2>/dev/null`
    )
      .then((out) => contain(out, 'directory|'))
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
  const sec = Number(parts[2])
  if (sec) file.mtime = new Date(sec * 1000)
  file.mode = parts[3]
}

// 索引里只有路径：命中后补元数据（整个结果页，分块 + 3 路并发）。
// 老设备没有 stat -c 时退回 ls -ld 解析。
async function enrichMetaChunk(
  deviceId: string,
  chunk: IFile[],
  useStat: boolean
) {
  const paths = chunk.map((file) => shellQuotePath(file.name)).join(' ')
  if (useStat) {
    const out = await shell(deviceId, `stat -c '%F|%s|%Y|%a|%n' ${paths} 2>/dev/null`)
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
  // stat 不支持：用 ls -ld，按完整路径或 basename 对回结果
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
// 重复搜索时整页都不再走设备端 stat（首次搜索仍然只补当前页）。
const META_TTL = 10 * 60 * 1000
const META_MAX = 20000
const metaCache = new Map<
  string,
  { directory: boolean; size?: number; mtime: number; mode: string; ts: number }
>()

function metaKey(deviceId: string, path: string) {
  return deviceId + '\n' + path
}

function applyCachedMeta(deviceId: string, file: IFile) {
  const cached = metaCache.get(metaKey(deviceId, file.name))
  if (!cached || Date.now() - cached.ts > META_TTL) return false
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
    ts: Date.now(),
  })
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

// 多台设备同时首次全盘搜索会同时整盘 find：设备 IO 和主进程内存都翻倍。
// 建索引串行排队，已有索引的查询不受影响（走内存）。
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
  const flush = (force = false) => {
    if (!pending.length) return
    const now = Date.now()
    // 渲染层每接一批都会重建一次表格行：120ms 太密，整盘搜索时会把主线程压住
    if (!force && now - lastEmit < 600) return
    lastEmit = now
    emit(pending)
    pending = []
  }
  const add = (
    abs: string,
    directory: boolean,
    size?: number,
    mtime?: Date,
    mode?: string
  ) => {
    if (seen.has(abs)) return
    seen.add(abs)
    if (entries.length < INDEX_MAX_ENTRIES) {
      entries.push(`${directory ? 'd' : 'f'}\t${abs}`)
    }
    const slash = abs.lastIndexOf('/')
    const name = abs.slice(slash + 1)
    if (!name || !name.toLowerCase().includes(lower)) return
    const file: IFile = {
      name: abs,
      directory,
      mtime: mtime || new Date(),
      mode: mode || '',
    }
    if (size !== undefined) file.size = size
    if (!directory) file.mime = mime(splitPath(name).ext.slice(1))
    pending.push(file)
    found++
    flush()
  }

  // 多个根并行扫（最多 3 路），比原来的串行 for 快几倍
  const queue = roots.slice()
  const workerCount = Math.min(3, Math.max(1, queue.length))
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length && !aborted()) {
      const root = queue.shift()!
      const q = shellQuotePath(root.scan)
      onProgress(root.display, found)
      // 建索引只列路径，不逐文件 stat：U 盘/fuse 上 stat 一个文件要 1ms，
      // 6 万个文件就是一分多钟。大小/时间等命中后再批量补。
      const cmd = `cd ${q} && find -L . -print 2>/dev/null`
      try {
        await spawnAdbLines(
          ['-s', deviceId, 'shell', cmd],
          300000,
          (line) => {
            if (!line.trim()) return
            const p = line.trim()
            if (!(startWith(p, './') || startWith(p, '/'))) return
            // 扫描路径可能是 /mnt/media_rw（快），显示路径用 /storage（用户熟悉）
            add(startWith(p, '/') ? p : `${root.display}/${p.slice(2)}`, false)
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
    const idx = { entries, dirs: buildDirSet(entries), ts: Date.now() }
    fileIndexes.set(deviceId, idx)
    return idx
  } catch {
    return null
  }
}

async function searchAllDisksWithIndex(
  deviceId: string,
  currentPath: string,
  kw: string,
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
      window.sendTo('main', 'searchResults', { deviceId, kw, files })
    }
  }

  const cached = loadFileIndex(deviceId)
  if (cached && Date.now() - cached.ts < INDEX_TTL) {
    // 命中索引：只查内存，不再碰设备（补元数据一次批量 stat）
    const hits = searchFileIndex(deviceId, cached, kw)
    emitProgress('索引', hits.length)
    const files = hitsToFiles(hits.slice(offset, offset + limit))
    await statSearchHits(deviceId, files)
    return { files, total: hits.length }
  }

  const idx = await withIndexLock(() =>
    buildFileIndex(
      deviceId,
      currentPath,
      kw,
      emitFiles,
      emitProgress,
      killers,
      aborted
    )
  )
  if (idx) {
    const hits = searchFileIndex(deviceId, idx, kw)
    const files = hitsToFiles(hits.slice(offset, offset + limit))
    await statSearchHits(deviceId, files)
    return { files, total: hits.length }
  }
  // 建索引失败（老设备没有 stat/-exec +）：交给原来的整盘 find 兜底
  return null
}

// 兜底：不支持 stat 批量格式的老设备，仍按原来的 find 逐根扫（会慢一些）
async function liveSearchAllDisks(
  deviceId: string,
  currentPath: string,
  safeKw: string,
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
        const cmd = findCommand(root.scan, safeKw, mode, follow, 1000)
        await spawnAdbLines(
          ['-s', deviceId, 'shell', cmd],
          180000,
          (line) => {
            lines++
            const files = parseSearchLines([line])
            if (files.length) parsed++
            for (const file of files) {
              const name = startWith(file.name, '/')
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
        if (lines > 0 && parsed === 0) {
          await searchRootByNames(
            deviceId,
            root.scan,
            safeKw,
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
          safeKw,
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

// 搜索：存储盘递归（覆盖子目录），其它路径只搜当前目录；
// 老系统没有 toybox ls 时退回 adb 同步协议
const searchDir: IpcSearchDir = async function (
  deviceId,
  path,
  keyword,
  allDisks,
  offset = 0,
  limit = 1000
) {
  const kw = keyword.trim()
  if (!kw) return { files: [], total: 0 }

  const safeKw = kw.replace(/'/g, "'\\''")

  // 新搜索开始：先终止同一台设备上还在跑的上一轮 find。
  // 每次搜索都注册 kill 句柄（不只是全盘）：默认搜索也可能在大目录里跑很久，
  // 用户继续敲关键字时不能把上一次的 find 留在设备上。
  const previousSearch = activeSearches.get(deviceId)
  if (previousSearch) previousSearch()
  const killers: Array<() => void> = []
  let cancelled = false
  const killer = () => {
    cancelled = true
    for (const kill of killers) kill()
  }
  activeSearches.set(deviceId, killer)

  // 直接粘贴完整路径（/media/hdf/202412/60000120.ys）：精确命中就只返回它；
  // 没命中就把文件名当关键字，在所在目录里递归找
  if (startWith(kw, '/') && kw !== '/') {
    const slash = kw.lastIndexOf('/')
    const dir = slash === 0 ? '/' : kw.slice(0, slash + 1)
    const base = kw.slice(slash + 1)
    if (base) {
      try {
        const r = await spawnAdb(
          ['-s', deviceId, 'shell', `ls -ld ${shellQuotePath(kw)} 2>/dev/null`],
          30000
        )
        const exact = parseSearchLines(String(r.stdout || '').split('\n'))
        if (exact.length) {
          exact[0].name = kw
          return { files: exact, total: 1 }
        }
      } catch {
        // 路径不存在/无权限：继续按目录 + 文件名找
      }
      const baseKw = base.replace(/'/g, "'\\''")
      const follow = (await supportsFindFollow(deviceId)) ? '-L ' : ''
      const mode = await getFindExecMode(deviceId)
      const found: IFile[] = []
      const seen = new Set<string>()
      if (mode === 'plain') {
        await searchRootByNames(deviceId, dir, baseKw, follow, seen, found, killers)
      } else {
        const cmd = findCommand(dir, baseKw, mode, follow, 500)
        await spawnAdbLines(
          ['-s', deviceId, 'shell', cmd],
          120000,
          (line) => {
            for (const file of parseSearchLines([line])) {
              if (!startWith(file.name, '/')) file.name = dir + file.name
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

  // 全盘：先看这台设备有没有现成索引（30 分钟内），有就直接查内存；
  // 没有就一边整盘遍历一边建索引，并把命中的结果边扫边推给界面。
  if (allDisks) {
    const started = Date.now()
    const page = await searchAllDisksWithIndex(
      deviceId,
      path,
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
              path,
              safeKw,
              killers,
              () => cancelled
            ),
            offset,
            limit
          )
        : page
    if (activeSearches.get(deviceId) === killer) activeSearches.delete(deviceId)
    if (cancelled) return { files: [], total: 0 }
    window.sendTo('main', 'searchProgress', {
      deviceId,
      root: '完成',
      found: result.total,
      elapsedMs: Date.now() - started,
    })
    return result
  }

  const searchRoot = path
  if (canSearchRecursive(path) && (await supportsRecursiveFind(deviceId))) {
    const follow = (await supportsFindFollow(deviceId)) ? '-L ' : ''
    const mode = await getFindExecMode(deviceId)
    if (mode === 'plain') {
      const files: IFile[] = []
      const seen = new Set<string>()
      await searchRootByNames(deviceId, searchRoot, safeKw, follow, seen, files, killers)
      if (cancelled) return { files: [], total: 0 }
      return { files, total: files.length }
    }
    const cmd = findCommand(searchRoot, safeKw, mode, follow, 500)
    const files: IFile[] = []
    const seen = new Set<string>()
    const r = await spawnAdbLines(
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
    if (r.timedOut) throw new Error('搜索超时：结果不完整，请缩小范围')
    return { files, total: files.length }
  }

  const syncMode =
    (startWith(path, '/data/') && !startWith(path, '/data/local/tmp/')) ||
    !(await lsFollowsSymlink(deviceId))
  if (syncMode) {
    const all = await readDirSorted(deviceId, path)
    const lower = kw.toLowerCase()
    const hit = filter(all, (f) => contain(f.name.toLowerCase(), lower))
    return { files: hit, total: hit.length }
  }

  const q = shellQuotePath(path)
  const cmd = `${dirsFirst(q)} | grep -iF -- '${safeKw}' | head -n 3000`
  const r = await spawnAdb(['-s', deviceId, 'shell', cmd], 60000)
  const files = parseSearchLines(String(r.stdout || '').split('\n'))
  return { files, total: files.length }
}

async function readDataDir(deviceId: string, path: string) {
  if (startWith(path, '/data/app/')) {
    return readDataAppDir(deviceId, path)
  } else if (startWith(path, '/data/data/')) {
    return readDataDataDir(deviceId, path)
  }

  const stat = await statFile(deviceId, '/data')

  if (path === '/data/local/') {
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

  return map(['data', 'app', 'local'], (name) => {
    return {
      name,
      directory: true,
      mtime: stat.mtime,
      mode: stat.mode,
      size: stat.size,
    }
  })
}

async function readDataAppDir(deviceId: string, path: string) {
  const packages = await shell(deviceId, 'pm list packages -f')
  const prefix = `package:${path}`
  const lines = filter(
    packages.split('\n'),
    (line) => trim(line) !== '' && contain(line, prefix)
  )
  const paths = map(lines, (line) => line.slice(prefix.length).split('/'))
  const stat = await statFile(deviceId, '/data')
  const ret: any[] = []
  for (let i = 0, len = paths.length; i < len; i++) {
    const segments = paths[i]
    if (segments.length > 1) {
      ret.push({
        name: segments[0],
        directory: true,
        mtime: stat.mtime,
        mode: stat.mode,
        size: stat.size,
      })
    } else {
      if (contain(segments[0], '.apk')) {
        const name = segments[0].split('.apk')[0] + '.apk'
        const stat = await statFile(deviceId, path + name)
        ret.push({
          name,
          directory: false,
          mtime: stat.mtime,
          mode: stat.mode,
          size: stat.size,
        })
      }
    }
  }

  return ret
}

async function readDataDataDir(deviceId: string, path: string) {
  const stat = await statFile(deviceId, '/data')
  if (path === '/data/data/') {
    const packages = await getPackages(deviceId)
    return map(packages, (pkg) => {
      return {
        name: pkg,
        directory: true,
        mtime: stat.mtime,
        mode: stat.mode,
        size: stat.size,
      }
    })
  }

  const ls = await fileShell(deviceId, `ls -al`, path)
  if (!contain(ls, 'not debuggable')) {
    const ret: any[] = []
    each(ls.split('\n'), (line) => {
      const item = parseLsLine(line)
      if (item) {
        ret.push(item)
      }
    })
    return ret
  }

  return []
}

async function fileShell(
  deviceId: string,
  cmd: string,
  path: string,
  dest?: string,
  checked = false,
  timeoutMs = 15000
) {
  const exec = checked ? shellChecked : shell
  if (
    startWith(path, '/data/data/') ||
    (dest && startWith(dest, '/data/data/'))
  ) {
    if (!(await isRooted(deviceId))) {
      let segments: string[] = []
      if (dest && startWith(dest, '/data/data/')) {
        segments = dest.replace('/data/data/', '').split('/')
      } else {
        segments = path.replace('/data/data/', '').split('/')
      }
      const pkg = segments[0]
      // 路径来自设备返回的文件名，可能含引号/$/反引号：必须转义，否则等于在设备端执行任意命令
      return exec(
        deviceId,
        `run-as ${shellQuotePath(pkg)} ${cmd} ${shellQuotePath(
          path
        )}${dest ? ' ' + shellQuotePath(dest) : ''}`,
        timeoutMs
      )
    }
  }

  return exec(
    deviceId,
    `${cmd} ${shellQuotePath(path)}${dest ? ' ' + shellQuotePath(dest) : ''}`,
    timeoutMs
  )
}

const statFile: IpcStatFile = async function (deviceId, path) {
  if (startWith(path, '/data/data/')) {
    if (!(await isRooted(deviceId))) {
      const ls = await fileShell(deviceId, 'ls -ld', path)
      const item = parseLsLine(trim(ls))
      if (!item) {
        throw new Error(`Failed to stat file: ${path}`)
      }
      return {
        size: item.size,
        mtime: item.mtime,
        directory: item.directory,
        mode: item.mode,
      }
    }
  }

  const device = await client.getDevice(deviceId)
  const stat = await device.stat(path)

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
