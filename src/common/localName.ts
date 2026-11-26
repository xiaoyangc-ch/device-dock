const INVALID_WINDOWS_CHARS = /[<>:"/\\|?*]/g
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const MAX_NAME_UNITS = 180

function truncateUtf16(value: string, maxUnits: number) {
  let output = ''
  let units = 0
  for (const char of Array.from(value)) {
    if (units + char.length > maxUnits) break
    output += char
    units += char.length
  }
  return output
}

function splitSafeExtension(name: string) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || name.length - dot > 24) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot) }
}

/**
 * 设备文件名来自 POSIX，可以包含反斜杠、冒号和 Windows 保留名称。
 * 下载到本机前必须把它降为一个安全路径段，不能依赖当前平台的 path.basename。
 */
export function safeLocalFileName(input: string, fallback = 'file') {
  const raw = String(input ?? '')
  let name = Array.from(raw)
    .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .replace(INVALID_WINDOWS_CHARS, '_')
    .replace(/^[ ]+/g, '_')
    .replace(/[. ]+$/g, (tail) => '_'.repeat(tail.length))

  if (!raw || raw === '.' || raw === '..' || !name) name = fallback

  if (name.length > MAX_NAME_UNITS) {
    const { base, ext } = splitSafeExtension(name)
    const fittedBase = truncateUtf16(base, MAX_NAME_UNITS - ext.length)
    name = fittedBase + ext
  }

  name = name.replace(/[. ]+$/g, (tail) => '_'.repeat(tail.length))
  if (WINDOWS_RESERVED.test(name)) name = '_' + name
  return name || fallback
}

/** 同目录重名时追加序号，并保证追加后的整段文件名仍不超 Windows 上限。 */
export function localFileNameVariant(
  input: string,
  index: number,
  fallback = 'file',
) {
  const safe = safeLocalFileName(input, fallback)
  const numericIndex = Number.isFinite(index) ? Math.max(1, Math.trunc(index)) : 1
  const suffix = ` (${numericIndex})`
  const { base, ext } = splitSafeExtension(safe)
  const fittedBase = truncateUtf16(
    base,
    Math.max(1, MAX_NAME_UNITS - suffix.length - ext.length),
  )
  return safeLocalFileName(`${fittedBase}${suffix}${ext}`, fallback)
}
