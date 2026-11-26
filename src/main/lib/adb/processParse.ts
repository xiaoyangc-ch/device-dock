import { IProcess } from 'common/types'

export type TopColumn = {
  key: string
  /** args 列吃掉行尾剩余内容（进程名里可能有空格） */
  rest?: boolean
}

function normalizeColumn(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower === 'cpu%') return '%cpu'
  if (lower === 'uid') return 'user'
  if (lower === 'rss') return 'res'
  return lower
}

/**
 * 从 top 输出里找表头 + 数据行。
 * 新版 toybox 支持 `top -o`，表头就是参数里的列；老版本只认默认列，
 * 需要按实际表头映射（CPU%/UID/RSS 等写法不一样）。
 */
export function parseTop(output: string, columns: TopColumn[]): IProcess[] {
  const lines = output.split('\n')
  let start = -1
  let active = columns

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!/^PID\b/.test(line)) continue
    start = i + 1
    const header = line.split(/\s+/).map(normalizeColumn)
    if (header.join(',') !== columns.map((c) => c.key).join(',')) {
      active = header.map((key, index) => ({
        key,
        rest: index === header.length - 1,
      }))
    }
    break
  }
  if (start < 0) return []

  const rows: IProcess[] = []
  for (const raw of lines.slice(start)) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    const row: Record<string, string> = {}
    active.forEach((column, index) => {
      row[column.key] = column.rest
        ? parts.slice(index).join(' ')
        : parts[index] || ''
    })
    rows.push(row as unknown as IProcess)
  }
  return rows
}
