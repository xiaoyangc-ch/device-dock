/**
 * 文件行的类型/图标/权限显示。
 * 这些集合会在每个文件行上查一次（搜索上千行），放模块级避免反复建数组。
 */
import type { IFile } from 'luna-file-list'
import splitPath from 'licia/splitPath'
import startWith from 'licia/startWith'
import isStr from 'licia/isStr'
import { safeLocalFileName } from 'common/localName'

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv'])
const IMAGE_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
])
const TEXT_EXT = new Set([
  '.txt',
  '.log',
  '.json',
  '.xml',
  '.ini',
  '.conf',
  '.md',
  '.csv',
])

export function typeOf(file: IFile, directoryLabel = '文件夹') {
  if (file.directory) return directoryLabel

  const ext = splitPath(file.name).ext
  return ext ? ext.slice(1).toUpperCase() : ''
}

export function iconOf(file: IFile) {
  if (file.directory) return 'icon-folder'

  const ext = splitPath(file.name).ext.toLowerCase()
  const mime = file.mime || ''

  if (ext === '.apk') return 'icon-package'
  if (startWith(mime, 'video') || VIDEO_EXT.has(ext))
    return 'icon-video-recorder'
  if (startWith(mime, 'image') || IMAGE_EXT.has(ext)) return 'icon-image'
  if (startWith(mime, 'text') || TEXT_EXT.has(ext)) return 'icon-file-text'
  return 'icon-open-file'
}

export function isPreviewable(file: IFile) {
  const mime = file.mime || ''
  return (
    mime === 'application/pdf' ||
    startWith(mime, 'image/') ||
    startWith(mime, 'video/') ||
    startWith(mime, 'audio/') ||
    startWith(mime, 'text/')
  )
}

/**
 * 设备端权限有两种表示：`ls -l` 的 -rw-r--r--，以及 `stat -c %a` 的 644。
 * 统一显示成 ls 风格；拿不到位（--）就原样返回。
 */
export function modeOf(file: IFile) {
  if (!file.mode) return '--'
  if (isStr(file.mode) && /[-rwx]/i.test(file.mode)) return file.mode

  const numeric = isStr(file.mode) ? parseInt(file.mode, 8) : Number(file.mode)
  if (!Number.isFinite(numeric)) return String(file.mode)

  const chars = ['r', 'w', 'x']
  let mode = file.directory ? 'd' : '-'
  for (let bit = 8; bit >= 0; bit--) {
    mode += numeric & (1 << bit) ? chars[2 - (bit % 3)] : '-'
  }
  return mode
}

/** 新建/重命名只接受单个路径段，避免把普通改名变成跨目录移动。 */
export function isValidFileName(name: string) {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  )
}

/** `a.txt` → `a (1).txt`；无扩展名则追加在末尾。 */
export function conflictName(name: string, index: number) {
  const safe = safeLocalFileName(name)
  if (index <= 0) return safe
  const dot = safe.lastIndexOf('.')
  return dot > 0
    ? `${safe.slice(0, dot)} (${index})${safe.slice(dot)}`
    : `${safe} (${index})`
}
