import type { IFile } from 'luna-file-list'
import splitPath from 'licia/splitPath'
import startWith from 'licia/startWith'
import isStr from 'licia/isStr'

// 这些集合在每个文件行上都会查一次（搜索上千行），放模块级避免反复建数组
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])
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
  if (startWith(mime, 'video') || VIDEO_EXT.has(ext)) return 'icon-video-recorder'
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

export function modeOf(file: IFile) {
  if (!file.mode) return '--'
  if (isStr(file.mode) && /[-rwx]/i.test(file.mode)) return file.mode
  const n = isStr(file.mode) ? parseInt(file.mode, 8) : Number(file.mode)
  if (!Number.isFinite(n)) return String(file.mode)
  const chars = ['r', 'w', 'x']
  let mode = file.directory ? 'd' : '-'
  for (let bit = 8; bit >= 0; bit--) {
    mode += n & (1 << bit) ? chars[2 - (bit % 3)] : '-'
  }
  return mode
}
