// 设备端 `ls -l` 输出解析。两种格式都要认：
//
// toybox（Android 7+）：-rw-r--r-- 1 root root 123 2026-11-10 18:31 name
// toolbox（Android 6-）：-rw-r--r-- root     root     123 2026-11-10 18:31 name
//
// toolbox 少了硬链接计数，目录和软链也没有 size 列，用一条单独的正则兜底；
// 6.0 上把 toybox 的正则套过去会整行解析失败，表现就是文件列表空白。

export interface ILsEntry {
  name: string
  directory: boolean
  mtime: Date
  mode: string
  size: number
}

// 权限串可能是 d/l/c/b/p/s 开头，末尾还可能带 ACL(+) / SELinux(.) / 扩展属性(@)
const regToybox =
  /^([dlbcps-][rwxsStT-]{9}[+.@]?)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d,]+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/

const regToolbox =
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

// 第三种常见格式：busybox / 厂商定制 ls 用「Nov 11 16:30」或「Nov 11  2025」
// 而不是 YYYY-MM-DD。Kylin 这类固件上严格正则全部失配，表现就是搜索结果
// 只剩文件名，权限、大小都是「--」。这里不再依赖整行正则：
// 先按权限串切出头部，再找日期位置，日期前一个字段就是 size。
function parseLooseLine(line: string): ILsEntry | null {
  const head = line.match(/^([dlbcps-][rwxsStT-]{9}[+.@]?)\s+(.+)$/)
  if (!head) return null
  const mode = head[1]
  const tokens = head[2].split(/\s+/)
  const now = new Date()

  let dateIdx = -1
  let nameStart = -1
  let mtime: Date | null = null

  for (let i = 0; i < tokens.length - 1; i++) {
    const ymd = tokens[i].match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (ymd) {
      const hm = (tokens[i + 1] || '').match(/^(\d{1,2}):(\d{2})$/)
      if (hm) {
        mtime = new Date(+ymd[1], +ymd[2] - 1, +ymd[3], +hm[1], +hm[2])
        dateIdx = i
        nameStart = i + 2
        break
      }
    }

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
      dateIdx = i
      nameStart = i + 3
      break
    }
    if (/^\d{4}$/.test(third)) {
      mtime = new Date(+third, month, day)
      dateIdx = i
      nameStart = i + 3
      break
    }
  }

  if (dateIdx < 1 || nameStart < 0 || !mtime) return null

  let size = 0
  const sizeToken = tokens[dateIdx - 1].replace(/,/g, '')
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
  line = line.trim()

  let mode: string
  let name: string
  let date: string
  let time: string
  let size = 0

  const toybox = line.match(regToybox)
  if (toybox) {
    mode = toybox[1]
    name = toybox[8]
    date = toybox[6]
    time = toybox[7]
    size = parseInt(toybox[5].replace(/,/g, ''), 10)
  } else {
    const toolbox = line.match(regToolbox)
    if (!toolbox) {
      return parseLooseLine(line)
    }
    mode = toolbox[1]
    name = toolbox[7]
    date = toolbox[5]
    time = toolbox[6]
    if (toolbox[4]) {
      size = parseInt(toolbox[4].replace(/,/g, ''), 10)
    }
  }

  // 软链接会带 " -> target"，名字只取 -> 之前的部分
  if (mode[0] === 'l') {
    const arrow = name.indexOf(' -> ')
    if (arrow > 0) {
      name = name.slice(0, arrow)
    }
  }
  if (name === '.' || name === '..') {
    return null
  }

  return {
    name,
    directory: mode[0] === 'd',
    mtime: new Date(`${date} ${time}`),
    mode,
    size,
  }
}
