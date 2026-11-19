/**
 * 设备侧操作的安全护栏。
 *
 * 抽成无依赖的纯函数：一是有单测覆盖（这两条都是「错了就删库 / 被注入」的路径），
 * 二是 file.ts / package.ts 都能直接复用，不用各自再写一遍。
 */

/** rm -rf 不可逆：设备盘根、内部存储根、系统分区一律拒绝。 */
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

/**
 * 设备路径规范化：拒绝很可能是命令拼接错误产生的相对路径、NUL 和 `..`。
 * 删除场景宁可拒绝可疑路径，也不把 `a/../` 当成普通子目录。
 */
export function normalizeDevicePath(devicePath: string) {
  if (!devicePath || devicePath.includes('\0')) {
    throw new Error('非法设备路径')
  }
  if (!devicePath.startsWith('/')) {
    throw new Error(`设备路径必须为绝对路径：${devicePath}`)
  }

  const parts: string[] = []
  for (const part of devicePath.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      throw new Error(`设备路径不能包含 ..：${devicePath}`)
    }
    parts.push(part)
  }
  return '/' + parts.join('/')
}

/**
 * 删除守卫同时接受运行时挂载点。
 * `/storage/<UUID>`、`/mnt/media_rw/<卷>` 等动态路径不能依赖固定名单。
 */
export function assertDeletable(
  devicePath: string,
  protectedMounts: Iterable<string> = []
) {
  const nor = normalizeDevicePath(devicePath)
  if (PROTECTED_DELETE.has(nor)) {
    throw new Error(`拒绝删除受保护路径：${devicePath}`)
  }
  for (const mount of protectedMounts) {
    let mountPath = ''
    try {
      mountPath = normalizeDevicePath(mount)
    } catch {
      continue
    }
    if (nor === mountPath) {
      throw new Error(`拒绝删除挂载点：${devicePath}`)
    }
  }
  // 只删顶层的 /xxx 也拦掉：那基本都是挂载点或系统目录
  if (nor.split('/').filter(Boolean).length < 2) {
    throw new Error(`拒绝删除顶层目录：${devicePath}`)
  }
  return nor
}

/**
 * 包名会直接拼进设备端 shell 命令：设备返回异常包名（含 ; $() 空格）时
 * 这些命令会执行任意语句。
 */
export function assertPackageName(pkg: string) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.]*$/.test(pkg) || pkg.length > 255) {
    throw new Error(`非法包名：${pkg}`)
  }
}
