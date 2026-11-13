/**
 * 设备端 `ls -l` 输出解析。要认三种格式：
 *
 * 1. toybox（Android 7+）：
 *    -rw-r--r-- 1 root root 123 2026-11-10 18:31 name
 * 2. toolbox（Android 6-，没有硬链接计数，目录/软链也没有 size）：
 *    -rw-r--r-- root root 123 2026-11-10 18:31 name
 * 3. busybox / 厂商定制（Kylin 等，用月名而不是 YYYY-MM-DD）：
 *    -rw-r--r-- 1 root root 123 Nov 11 16:30 name
 *    -rw-r--r-- 1 root root 123 Nov 11  2025 name
 *
 * 6.0 上套 toybox 的正则会整行失配，表现就是文件列表空白；
 * 所以先试严格正则，再退到「按权限串切头 + 找日期」的宽松解析。
 */

export interface ILsEntry {
  name: string
  directory: boolean
  mtime: Date
  mode: string
  size: number
}

// 权限串可能是 d/l/c/b/p/s 开头，末尾带 ACL(+) / SELinux(.) / xattr(@)
const TOYBOX_RE =
  /^([dlbcps-][rwxsStT-]{9}[+.@]?)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d,]+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/

const TOOLBOX_RE =
  /^([dlbcps-][rwxsStT-]{9})\s+(\S+)\s+(\S+)\s+(?:([\d,]+)\s+)?(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
}

/**
 * 宽松解析：不依赖整行正则。
 * 先按权限串切出头部，再找日期位置；日期前一个字段就是 size。
 */
function parseLoose(line: string): ILsEntry | null {
  const head = line.match(/^([dlbcps-][rwxsStT-]{9}[+.@]?)\s+(.+)$/)
  if (!head) return null

  const mode = head[1]
  const tokens = head[2].split(/\s+/)
  const now = new Date()

  let dateIndex = -1
  let nameStart = -1
  let mtime: Date | null = null

  for (let i = 0; i < tokens.length - 1; i++) {
    // YYYY-MM-DD HH:mm
    const ymd = tokens[i].match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (ymd) {
      const hm = (tokens[i + 1] || '').match(/^(\d{1,2}):(\d{2})$/)
      if (hm) {
        mtime = new Date(+ymd[1], +ymd[2] - 1, +ymd[3], +hm[1], +hm[2])
        dateIndex = i
        nameStart = i + 2
        break
      }
    }

    // Mon DD HH:mm / Mon DD YYYY
    const month = MONTHS[tokens[i]]
    if (month === undefined) continue
    const day = parseInt(tokens[i + 1], 10)
    const third = tokens[i + 2] || ''
    if (!day) continue

    const hm = third.match(/^(\d{1,2}):(\d{2})$/)
    if (hm) {
      mtime = new Date(now.getFullYear(), month, day, +hm[1], +hm[2])
      // 跨年：现在 1 月看到「Dec 31」应算去年
      if (mtime.getTime() > now.getTime() + 24 * 3600 * 1000) {
        mtime.setFullYear(mtime.getFullYear() - 1)
      }
      dateIndex = i
      nameStart = i + 3
      break
    }

    if (/^\d{4}$/.test(third)) {
      mtime = new Date(+third, month, day)
      dateIndex = i
      nameStart = i + 3
      break
    }
  }

  if (dateIndex < 1 || nameStart < 0 || !mtime) return null

  let size = 0
  const sizeToken = tokens[dateIndex - 1].replace(/,/g, '')
  if (/^\d+$/.test(sizeToken)) size = parseInt(sizeToken, 10)

  let name = tokens.slice(nameStart).join(' ')
  if (!name) return null

  if (mode[0] === 'l') {
    const arrow = name.indexOf(' -> ')
    if (arrow > 0) name = name.slice(0, arrow)
  }
  if (name === '.' || name === '..') return null

  return { name, directory: mode[0] === 'd', mtime, mode, size }
}

export function parseLsLine(line: string): ILsEntry | null {
  const text = line.trim()

  let mode: string
  let name: string
  let date: string
  let time: string
  let size = 0

  const toybox = text.match(TOYBOX_RE)
  if (toybox) {
    mode = toybox[1]
    name = toybox[8]
    date = toybox[6]
    time = toybox[7]
    size = parseInt(toybox[5].replace(/,/g, ''), 10)
  } else {
    const toolbox = text.match(TOOLBOX_RE)
    if (!toolbox) return parseLoose(text)

    mode = toolbox[1]
    name = toolbox[7]
    date = toolbox[5]
    time = toolbox[6]
    if (toolbox[4]) size = parseInt(toolbox[4].replace(/,/g, ''), 10)
  }

  // 软链接带 " -> target"，名字只取箭头前
  if (mode[0] === 'l') {
    const arrow = name.indexOf(' -> ')
    if (arrow > 0) name = name.slice(0, arrow)
  }
  if (name === '.' || name === '..') return null

  return {
    name,
    directory: mode[0] === 'd',
    mtime: new Date(`${date} ${time}`),
    mode,
    size,
  }
}
