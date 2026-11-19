import splitPath from 'licia/splitPath'
import mime from 'licia/mime'
import { IFile } from 'common/types'

export const INDEX_MAX_ENTRIES = 300000
export const INDEX_HEADER = '#devicedock-index-v2'

const EXPECTED_FIND_ERROR =
  /permission denied|operation not permitted|no such file|not a directory|too many levels of symbolic links|input\/output error|read-only file system/i

/** 用户存储里遇到受保护目录是常态，不能因此永久禁用整盘索引。 */
export function isExpectedFindError(stderr: string) {
  const lines = String(stderr)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length > 0 && lines.every((line) => EXPECTED_FIND_ERROR.test(line))
}

export interface IFileIndex {
  /** "f\t/path" */
  entries: string[]
  /** 父路径出现过就说明是目录 */
  dirs: Set<string>
  at: number
}

export interface IIndexHit {
  path: string
  directory: boolean
  score: number
}

export function buildDirSet(entries: string[]) {
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

/**
 * 只收集轻量命中；每 2 万条让出事件循环，避免大索引搜索冻结主进程。
 */
export async function searchIndex(
  index: IFileIndex,
  keyword: string
): Promise<IIndexHit[]> {
  const lower = keyword.toLowerCase()
  const hits: IIndexHit[] = []

  for (let i = 0; i < index.entries.length; i++) {
    if (i > 0 && i % 20_000 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const entry = index.entries[i]
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
      score: at * 10000 + name.length,
    })
  }

  hits.sort((a, b) => a.score - b.score)
  return hits
}

export function hitsToFiles(hits: IIndexHit[]): IFile[] {
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

export function slicePage(files: IFile[], offset: number, limit: number) {
  return {
    files: files.slice(offset, offset + limit),
    total: files.length,
  }
}
