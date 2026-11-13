import { observer } from 'mobx-react-lite'
import LunaFileList from 'luna-file-list/react'

const PAGE_SIZE = 1000
import { Fragment, useEffect, useRef, useState } from 'react'
import Style from './File.module.scss'
import PageStyle from './FilePage.module.scss'
import store from '../../store'
import { t } from 'common/util'
import { notify, isFileDrop } from 'share/renderer/lib/util'
import { installPackages } from '../../../lib/util'
import { IFile } from 'luna-file-list'
import className from 'licia/className'
import isEmpty from 'licia/isEmpty'
import splitPath from 'licia/splitPath'
import fileSize from 'licia/fileSize'
import contextMenu from 'share/renderer/lib/contextMenu'
import LunaModal from 'luna-modal'
import endWith from 'licia/endWith'
import normalizePath from 'licia/normalizePath'
import startWith from 'licia/startWith'
import Transfer from './Transfer'
import FileGrid from './FileGrid'
import FileInspector from './FileInspector'
import { getOverview } from '../../lib/overview'

export default observer(function File() {
  const [fileList, setFileList] = useState<IFile[]>([])
  const [path, setPath] = useState('')
  const [customPath, setCustomPath] = useState('')
  const [filter, setFilter] = useState('')
  // 全盘搜索：默认关闭。默认只搜当前目录（在存储盘里会递归子目录），
  // 需要整台设备找时再点「全盘」——整盘 find 在录像盘上要几十秒，不能默认拖慢搜索
  const [searchAll, setSearchAll] = useState(false)
  // 全盘搜索进度（主进程每 500ms 推一次）：显示当前扫到哪个根、已找到多少、用了多久
  const [searchProgress, setSearchProgress] = useState<{
    root: string
    found: number
    elapsedMs: number
  } | null>(null)
  const [dropHighlight, setDropHighlight] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  // 面包屑/前进后退可能被连续点击：state 更新是异步的，必须用 ref 读最新值，
  // 否则两次快速「返回」都基于同一个旧索引，只能退一步
  const historyRef = useRef<string[]>([])
  const historyIdxRef = useRef(-1)
  const [selected, setSelected] = useState<IFile | undefined>()
  const [selectedUrl, setSelectedUrl] = useState<string>('')
  // 列表视图的多选：Ctrl/Cmd 点选、Shift 连选，右键批量操作
  const [selectedFiles, setSelectedFiles] = useState<IFile[]>([])
  // 设备内剪贴板：复制/剪切的文件列表，粘贴到当前目录
  const clipboardRef = useRef<{
    deviceId: string
    cut: boolean
    paths: string[]
  } | null>(null)
  // 取消选择没有公开 API：换 key 重挂列表，顺带清掉高亮
  const [gridKey, setGridKey] = useState(0)
  const draggingRef = useRef(0)

  const { device, file } = store

  const iconCache = useRef(new Map<string, string>()).current
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadingMoreSearch, setLoadingMoreSearch] = useState(false)
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)
  // 已通过 searchDir 分页取回的条数：streaming 的 searchResults 会额外插入列表，
  // 不能拿 fileList.length 当 offset，否则会跳过索引里的条目
  const searchLoadedRef = useRef(0)
  // 搜索回调里要读最新值：事件监听只注册一次，不能闭包在首帧
  const filterRef = useRef(filter)
  filterRef.current = filter
  const absPathRef = useRef<(file: IFile) => string>(() => '')
  const navSeq = useRef(0)
  const selectSeq = useRef(0)
  const listWrapRef = useRef<HTMLDivElement>(null)
  const loadLock = useRef(false)
  // 已从设备读取的条数（不是 fileList.length：去重后长度小于偏移，分页会原地打转）
  const loadedRef = useRef(0)
  const dirCache = useRef(
    new Map<string, { files: IFile[]; total: number; ts: number }>()
  ).current
  // 路径编辑：双击面包屑进入，回车跳转、Esc 取消；替换原来的 LunaPathBar
  const [editingPath, setEditingPath] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  const pathInputRef = useRef<HTMLInputElement>(null)
  const [storageFree, setStorageFree] = useState('')

  // 换设备要回到根目录并重新列目录：否则会把上一台设备的文件列表留在界面上；
  // 历史也要一起清掉，否则「返回」会跳回上一台设备的路径
  useEffect(() => {
    updateHistory(['/'], 0)
    getFiles('/')
  }, [device ? device.id : ''])

  useEffect(() => {
    if (editingPath) {
      pathInputRef.current?.focus()
      pathInputRef.current?.select()
    }
  }, [editingPath])

  // 状态栏的可用空间：不额外走 shell，复用概览接口，换设备时刷新一次
  useEffect(() => {
    setStorageFree('')
    if (!device) return
    let alive = true
    getOverview(device.id)
      .then((overview) => {
        if (!alive) return
        const used = Number(overview.storageUsed || 0)
        const total = Number(overview.storageTotal || 0)
        if (total > 0) setStorageFree(fileSize(Math.max(0, total - used)))
      })
      .catch(() => {
        // 概览失败不影响文件列表
      })
    return () => {
      alive = false
    }
  }, [device ? device.id : ''])

  async function getFiles(path: string, force = false) {
    if (!device) return
    // 每次导航递增：连点两个目录时，先发后到的旧结果不能覆盖当前目录
    const seq = ++navSeq.current
    // 15 秒内回退/再进同一目录直接用缓存，不再走一次远程列目录
    const cacheKey = device.id + ':' + path
    const cached = dirCache.get(cacheKey)
    if (!force && cached && Date.now() - cached.ts < 15000) {
      // 命中缓存也必须结束 loading：上一轮可能是另一个目录、还在转圈，
      // 它的 finally 因为 seq 已变而不会执行，否则文件页永远停在 spinner
      setLoading(false)
      setSearching(false)
      setLoadingMoreSearch(false)
      loadedRef.current = cached.files.length
      setPath(path)
      setCustomPath(path)
      setFilter('')
      setTotal(cached.total)
      setFileList(cached.files)
      return
    }
    setLoading(true)
    setSearching(false)
    setLoadingMoreSearch(false)
    setSearchProgress(null)
    setFileList([])
    setTotal(0)
    loadedRef.current = 0
    try {
      const page = await main.readDirPage(device.id, path, 0, PAGE_SIZE)
      if (seq !== navSeq.current) return
      loadedRef.current = page.files.length

      setPath(path)
      setCustomPath(path)
      setFilter('')
      setTotal(page.total)
      const enriched = await withIcons(page.files)
      if (seq !== navSeq.current) return
      setFileList(enriched)
      cacheDir(cacheKey, enriched, page.total)
    } catch {
      // 设备掉线时 readDirPage 会 reject：不 catch 就是未处理异常 + 永远转圈
      if (seq === navSeq.current) {
        setFileList([])
        setTotal(0)
      }
    } finally {
      if (seq === navSeq.current) setLoading(false)
    }
  }

  function cacheDir(cacheKey: string, files: IFile[], total: number) {
    // 30 个目录 × 3000 条会把几十万个对象（含 data URL 图标）常驻在渲染进程
    if (dirCache.size > 12) {
      const oldest = dirCache.keys().next().value
      if (oldest !== undefined) dirCache.delete(oldest)
    }
    // 只缓存首屏一页，回退时先出列表，继续滚动会重新按偏移加载
    const cached = files.length > 1000 ? files.slice(0, 1000) : files
    dirCache.set(cacheKey, { files: cached, total, ts: Date.now() })
  }

  // 图标：按扩展名去重 + 内存缓存 + 并行（大目录不再串行 IPC）
  async function withIcons(list: IFile[]): Promise<IFile[]> {
    const needIcon = new Set<string>()
    for (let i = 0, len = list.length; i < len; i++) {
      const file = list[i]
      if (file.directory || file.thumbnail) continue
      const ext = splitPath(file.name).ext
      const type = file.mime
      if (
        !type ||
        (!startWith(type, 'image') &&
          !startWith(type, 'text') &&
          !startWith(type, 'video') &&
          !startWith(type, 'audio'))
      ) {
        if (!iconCache.has(ext)) needIcon.add(ext)
      }
    }
    if (!needIcon.size) return list
    await Promise.all(
      Array.from(needIcon).map(async (ext) => {
        try {
          iconCache.set(ext, await main.getFileIcon(ext))
        } catch {
          // ignore
        }
      })
    )
    return list.map((file) => {
      if (file.directory || file.thumbnail) return file
      const icon = iconCache.get(splitPath(file.name).ext)
      return icon ? { ...file, thumbnail: icon } : file
    })
  }

  async function loadMore() {
    if (!device || loadingMore || loadLock.current) return
    if (loadedRef.current >= total) return
    loadLock.current = true
    setLoadingMore(true)
    const seq = navSeq.current
    const offset = loadedRef.current
    try {
      const page = await main.readDirPage(device.id, path, offset, PAGE_SIZE)
      // 加载期间用户已经切到别的目录：这一页属于旧目录，直接丢弃
      if (seq !== navSeq.current) return
      setTotal(page.total)
      loadedRef.current = offset + page.files.length
      // 分页期间目录若有增删，偏移会错位，出现同名重复行：按名字去重
      const seen = new Set(fileList.map((f) => f.name))
      const fresh = page.files.filter((f) => !seen.has(f.name))
      // 只给新一页补图标：对已加载的几百行重新 map 一遍纯属浪费
      const merged = fileList.concat(await withIcons(fresh))
      if (seq !== navSeq.current) return
      setFileList(merged)
      cacheDir(device.id + ':' + path, merged, page.total)
    } catch {
      // 设备掉线/超时：保留已加载内容，不要把 loadingMore 卡住
    } finally {
      loadLock.current = false
      setLoadingMore(false)
    }
  }

  // 搜索结果翻页：索引里有全量结果，按需再取 1000 条
  async function loadMoreSearch() {
    if (!device || loadingMoreSearch) return
    const kw = filter.trim()
    if (!kw) return
    if (searchLoadedRef.current >= total) return
    const seq = searchSeq.current
    const offset = searchLoadedRef.current
    setLoadingMoreSearch(true)
    try {
      const res = await main.searchDir(
        device.id,
        path,
        kw,
        searchAll,
        offset,
        PAGE_SIZE
      )
      if (seq !== searchSeq.current) return
      const enriched = await withIcons(res.files)
      if (seq !== searchSeq.current) return
      searchLoadedRef.current += res.files.length
      setFileList((prev) => {
        const seen = new Set(prev.map((f) => absPath(f)))
        const add = enriched.filter((f) => !seen.has(absPath(f)))
        return add.length ? prev.concat(add) : prev
      })
      setTotal(res.total)
    } catch {
      // 设备掉线：保留已显示的结果
    } finally {
      if (seq === searchSeq.current) setLoadingMoreSearch(false)
    }
  }

  // 滚动到底自动加载下一页（scroll 不冒泡，必须用原生 capture 监听）
  useEffect(() => {
    const wrap = listWrapRef.current
    if (!wrap) return
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement
      if (!el || !el.scrollHeight) return
      if (filter.trim() || loading || loadingMore) return
      if (loadedRef.current >= total) return
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
        loadMore()
      }
    }
    wrap.addEventListener('scroll', onScroll, true)
    return () => wrap.removeEventListener('scroll', onScroll, true)
  }, [filter, loading, loadingMore, fileList, total, path, device])

  // 过滤框：非空时走设备端搜索（覆盖整个目录，不只是已加载的这一页）
  useEffect(() => {
    if (!device) return
    const offProgress = main.on('searchProgress', (progress: any) => {
      if (progress && progress.deviceId && progress.deviceId !== device.id) return
      setSearchProgress(progress)
    })
    // 主进程建索引时边扫边推命中结果：先到先显示，不用等整盘扫完
    const offResults = main.on('searchResults', (payload: any) => {
      if (payload && payload.deviceId && payload.deviceId !== device.id) return
      const files: IFile[] = (payload && payload.files) || []
      if (!files.length) return
      if (!payload.kw || payload.kw !== filterRef.current.trim()) return
      setFileList((prev) => {
        const seen = new Set(prev.map((f) => absPathRef.current(f)))
        const add = files.filter((f) => {
          const p = absPathRef.current(f)
          if (seen.has(p)) return false
          seen.add(p)
          return true
        })
        return add.length ? prev.concat(add) : prev
      })
    })
    return () => {
      offProgress()
      offResults()
    }
  }, [device?.id])

  useEffect(() => {
    if (!device) return
    const kw = filter.trim()
    if (!kw) {
      setSearching(false)
      setSearchProgress(null)
      return
    }
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(async () => {
      const seq = ++searchSeq.current
      searchLoadedRef.current = 0
      setSearching(true)
      // 上一轮「加载更多」可能还在飞：seq 一变它的 finally 就不会复位，
      // 不在这里清掉，按钮会永远停在「加载中…」
      setLoadingMoreSearch(false)
      setSearchProgress(null)
      try {
        const res = await main.searchDir(device.id, path, kw, searchAll)
        if (seq !== searchSeq.current) return
        setTotal(res.total)
        searchLoadedRef.current = res.files.length
        setFileList(await withIcons(res.files))
        if (!res.total && !searchAll) {
          // 别让人以为搜索坏了：告诉他还有全盘这一档
          notify(t('fileSearchAllNotFound'), { icon: 'info' })
        }
      } catch {
        // 设备掉线/超时：搜索失败不能变成未处理异常，也不能留着旧结果冒充新目录
        if (seq === searchSeq.current) {
          setFileList([])
          setTotal(0)
        }
      } finally {
        if (seq === searchSeq.current) {
          setSearching(false)
          setSearchProgress(null)
        }
      }
    }, 300)
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      // 导航/改关键词后让上一轮设备端搜索作废，否则旧目录结果会覆盖新目录
      searchSeq.current++
    }
  }, [filter, path, searchAll])

  // 目录/关键字/设备一变，旧的多选就没有意义了：清掉，避免删到不在列表里的文件
  useEffect(() => {
    setSelectedFiles([])
    setSelected(undefined)
    setSelectedUrl('')
  }, [path, filter, device ? device.id : ''])

  function fileExist(name: string, parent: string) {
    const target = parent + name
    return fileList.some((file) => absPath(file) === target)
  }

  async function createFolder() {
    if (!device) return
    const name = await LunaModal.prompt(t('newFolderName'))
    if (!name) return
    try {
      await main.createDir(device.id, path + name)
      getFiles(path, true)
    } catch (e: any) {
      notify((e && e.message) || String(e), { icon: 'error' })
    }
  }

  async function renameFile(item: IFile) {
    if (!device) return
    const name = await LunaModal.prompt(
      t(item.directory ? 'newFolderName' : 'newFileName'),
      baseName(item)
    )
    if (!name || name === baseName(item)) return
    const parent = parentOf(item)
    const target = parent + name
    // 当前页查一次只是快速路径；目标可能还没分页加载出来，必须再问设备，
    // 否则 mv 会直接覆盖同名文件（文件就没了）
    if (fileExist(name, parent)) {
      notify(t('fileExistErr', { name }), { icon: 'error' })
      return
    }
    try {
      await main.statFile(device.id, target)
      notify(t('fileExistErr', { name }), { icon: 'error' })
      return
    } catch {
      // stat 失败 = 目标不存在，可以安全重命名
    }
    try {
      await main.moveFile(device.id, absPath(item), target)
      getFiles(path, true)
    } catch (e: any) {
      notify((e && e.message) || String(e), { icon: 'error' })
    }
  }

  // 历史索引的单一写入口：state 与 ref 永远同步
  function updateHistory(next: string[], index: number) {
    historyRef.current = next
    historyIdxRef.current = index
    setHistory(next)
    setHistoryIdx(index)
  }

  async function back() {
    const index = historyIdxRef.current
    if (index <= 0) {
      return
    }
    const target = historyRef.current[index - 1]
    // 先移动索引再加载：连点两次「返回」能各退一步，先发后到的旧结果由 navSeq 丢弃
    updateHistory(historyRef.current, index - 1)
    await getFiles(target)
  }

  async function forward() {
    const index = historyIdxRef.current
    if (index >= historyRef.current.length - 1) {
      return
    }
    const target = historyRef.current[index + 1]
    updateHistory(historyRef.current, index + 1)
    await getFiles(target)
  }

  async function go(p: string) {
    // 与 back/forward 一致：先记历史再加载，连续导航时顺序才和点击一致
    const index = historyIdxRef.current
    updateHistory([...historyRef.current.slice(0, index + 1), p], index + 1)
    await getFiles(p)
  }

  async function up() {
    await go(path.split('/').slice(0, -2).join('/') + '/')
  }

  // 全盘搜索结果里 name 是绝对路径（/sdcard/...），普通结果是相对当前目录的名字；
  // 递归搜索的结果还可能带子目录（202412/a.ys）。统一先拼成绝对路径再取父目录/文件名。
  const absPath = (file: IFile) =>
    startWith(file.name, '/') ? file.name : path + file.name
  absPathRef.current = absPath
  const parentOf = (file: IFile) => {
    const abs = absPath(file)
    return abs.slice(0, abs.lastIndexOf('/') + 1)
  }
  const baseName = (file: IFile) => {
    const abs = absPath(file)
    return abs.slice(abs.lastIndexOf('/') + 1)
  }

  async function open(item: IFile) {
    if (!device) {
      return
    }

    if (item.directory) {
      go(absPath(item) + '/')
      return
    }

    // 索引结果只有路径、没有元数据：先 stat 一次，目录才会正确进入而不是当文件打开
    if (item.mode === '') {
      try {
        const stat = await main.statFile(device.id, absPath(item))
        if (stat.directory) {
          go(absPath(item) + '/')
          return
        }
      } catch {
        // stat 失败就按文件继续
      }
    }

    try {
      if (item.mime) {
        const url = await main.getFileUrl(device.id, absPath(item))
        if (item.mime === 'application/pdf') {
          main.openWindow(url, 'pdf', {
            minHeight: 640,
            minWidth: 450,
            width: 450,
            height: 640,
          })
          return
        } else if (startWith(item.mime, 'video')) {
          main.showVideo(url)
          return
        }
      }

      notify(t('fileDownloading', { path: absPath(item) }), { icon: 'info' })
      await main.openFile(device.id, absPath(item))
    } catch (e: any) {
      // 设备掉线/文件被删：右键菜单里点开时的异常不能悄悄消失
      notify((e && e.message) || String(e), { icon: 'error' })
    }
  }

  // 预览：连点两个文件时先发的请求可能后返回，只认最后一次
  async function preview(item: IFile) {
    const seq = ++selectSeq.current
    if (!device) return
    setSelected(item)
    try {
      const url = await main.getFileUrl(device.id, absPath(item))
      if (seq === selectSeq.current) setSelectedUrl(url)
    } catch {
      if (seq === selectSeq.current) setSelectedUrl('')
    }
  }

  function clearSelection() {
    setSelectedFiles([])
    setSelected(undefined)
    setSelectedUrl('')
    setGridKey((k) => k + 1)
  }

  async function downloadFiles(files: IFile[]) {
    if (!device || !files.length) return
    const targets = files.filter((f) => !f.directory)
    if (!targets.length) {
      notify(t('fileFoldersOnly'), { icon: 'info' })
      return
    }
    let dir = ''
    if (targets.length > 1 && file.lastDownloadDir) {
      // 批量下载只问一次目录：第二次直接用上次的，避免一个个选
      dir = file.lastDownloadDir
      notify(t('fileBatchToLast', { dir }), { icon: 'info' })
    } else {
      const { canceled, filePaths } = await main.showOpenDialog({
        properties: ['openDirectory'],
      })
      if (canceled || !filePaths.length) return
      dir = filePaths[0]
      file.set('lastDownloadDir', dir)
    }
    let ok = 0
    const usedDests = new Set<string>()
    for (const item of targets) {
      const base = baseName(item)
      let dest = dir + '/' + base
      // 同一批里两个文件同名（不同源目录）时，后一个自动加 (1)，不要静默覆盖
      let n = 1
      while (usedDests.has(dest)) {
        const dot = base.lastIndexOf('.')
        const name =
          dot > 0
            ? `${base.slice(0, dot)} (${n})${base.slice(dot)}`
            : `${base} (${n})`
        dest = dir + '/' + name
        n++
      }
      usedDests.add(dest)
      notify(t('fileDownloading', { path: absPath(item) }), { icon: 'info' })
      try {
        await main.pullFile(device.id, absPath(item), dest)
        ok++
      } catch {
        // 单个失败继续下一个：批量下载不能因为一个 0 字节文件全停
      }
    }
    if (ok === targets.length) {
      notify(t('fileDownloaded', { count: ok, dir }), {
        icon: 'success',
        duration: 5000,
      })
    } else {
      notify(t('fileDownloadPartial', { ok, total: targets.length }), {
        icon: 'error',
      })
    }
  }

  async function installFile(item: IFile) {
    if (!device) return
    await installPackages(device.id, [absPath(item)])
  }

  function copySelection(cut: boolean, files = selectedFiles) {
    if (!device || !files.length) return
    clipboardRef.current = {
      deviceId: device.id,
      cut,
      paths: files.map((f) => absPath(f)),
    }
    notify(
      t(cut ? 'fileCutItems' : 'fileCopiedItems', { count: files.length }),
      { icon: 'success' }
    )
  }

  async function pasteFromClipboard() {
    const clipboard = clipboardRef.current
    if (!device) return
    if (!clipboard) {
      notify(t('filePasteEmpty'), { icon: 'info' })
      return
    }
    if (clipboard.deviceId !== device.id) {
      notify(t('fileClipboardOther'), { icon: 'error' })
      return
    }
    const dest = path || '/'
    try {
      const r = await main.pasteFiles(
        device.id,
        clipboard.paths,
        dest,
        clipboard.cut
      )
      if (r.copied) {
        notify(t('filePasteItems', { count: r.copied, dest }), {
          icon: 'success',
        })
      }
      if (r.failed.length) {
        notify(
          t('filePasteFailedItems', {
            count: r.failed.length,
            name: r.failed[0].name,
            error: r.failed[0].error,
          }),
          { icon: 'error' }
        )
      }
      if (clipboard.cut && r.copied) clipboardRef.current = null
      clearSelection()
      getFiles(path, true)
    } catch (e: any) {
      notify(t('filePasteFail') + (e && e.message ? e.message : e), {
        icon: 'error',
      })
    }
  }

  async function deleteFiles(files: IFile[]) {
    if (!device || !files.length) return
    const result =
      files.length > 1
        ? await LunaModal.confirm(
            t('fileDeleteMultiConfirm', { count: files.length })
          )
        : await LunaModal.confirm(
            t('deleteFileConfirm', { name: files[0].name })
          )
    if (!result) return
    let ok = 0
    for (const item of files) {
      try {
        if (item.directory) {
          await main.deleteDir(device.id, absPath(item))
        } else {
          await main.deleteFile(device.id, absPath(item))
        }
        ok++
      } catch {
        // 没权限的项跳过，最后统一报数量
      }
    }
    if (ok < files.length) {
      notify(t('fileDeletedPartial', { ok, total: files.length }), {
        icon: 'error',
      })
    }
    clearSelection()
    getFiles(path, true)
  }

  function onContextMenu(e: MouseEvent, item?: IFile) {
    showContextMenu(e, item ? [item] : [])
  }

  function onGridContextMenu(e: MouseEvent, files: IFile[]) {
    showContextMenu(e, files)
  }

  function showContextMenu(e: MouseEvent, files: IFile[]) {
    if (!device) {
      return
    }

    const item = files[0]
    const clip = clipboardRef.current
    if (files.length > 1) {
      const template: any[] = [
        ...(clip
          ? [
              {
                label: t('filePasteMenu', { count: clip.paths.length }),
                click: pasteFromClipboard,
              },
              { type: 'separator' },
            ]
          : []),
        {
          label: t('fileCopyMenu', { count: files.length }),
          click: () => copySelection(false, files),
        },
        {
          label: t('fileCutMenu', { count: files.length }),
          click: () => copySelection(true, files),
        },
        { type: 'separator' },
        {
          label: t('fileDownloadSelectedMenu', { count: files.length }),
          click: () => downloadFiles(files),
        },
        {
          label: t('fileDeleteSelectedMenu', { count: files.length }),
          click: () => deleteFiles(files),
        },
        {
          type: 'separator',
        },
        {
          label: t('cancelSelection'),
          click: clearSelection,
        },
      ]
      contextMenu(e, template)
      return
    }

    if (item) {
      const template: any[] = [
        ...(clip
          ? [
              {
                label: t('filePasteMenu', { count: clip.paths.length }),
                click: pasteFromClipboard,
              },
              { type: 'separator' },
            ]
          : []),
        {
          label: t('copy'),
          click: () => copySelection(false, [item]),
        },
        {
          label: t('cut'),
          click: () => copySelection(true, [item]),
        },
        { type: 'separator' },
        {
          label: t('open'),
          click: () => open(item),
        },
        {
          label: t('download'),
          click: () => downloadFiles([item]),
        },
        {
          type: 'separator',
        },
        {
          label: t('delete'),
          click: () => deleteFiles([item]),
        },
        {
          label: t('rename'),
          click: () => renameFile(item),
        },
      ]
      contextMenu(e, template)
    } else {
      const template: any[] = [
        ...(clip
          ? [
              {
                label: t('filePasteMenu', { count: clip.paths.length }),
                click: pasteFromClipboard,
              },
              { type: 'separator' },
            ]
          : []),
        {
          label: t('upload'),
          click: uploadFiles,
        },
        {
          label: t('newFolder'),
          click: () => createFolder(),
        },
        {
          type: 'separator',
        },
        {
          label: t('fileRebuildIndex'),
          click: async () => {
            if (!device) return
            await main.resetFileIndex(device.id)
            notify(t('fileIndexCleared'), { icon: 'success' })
          },
        },
        {
          label: t('refresh'),
          click: () => getFiles(path, true),
        },
      ]
      contextMenu(e, template)
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDropHighlight(false)
    const files = e.dataTransfer.files
    const paths: string[] = []
    for (let i = 0, len = files.length; i < len; i++) {
      paths.push(preload.getPathForFile(files[i]))
    }
    // 拖进来的不是文件（纯文本/链接）时 dataTransfer.files 为空：
    // 不能拿空数组去刷新列表，看起来就像「什么都没发生」
    if (paths.length) await uploadFiles(paths)
  }

  async function uploadFiles(files?: string[]) {
    if (!device) {
      return
    }

    if (!files) {
      const { filePaths } = await main.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
      })
      if (isEmpty(filePaths)) {
        return
      }
      files = filePaths
    }

    const list = files!
    const deviceId = device.id
    // pushFile 会直接覆盖设备上的同名文件：先查出来，让用户决定一次，
    // 而不是默默用本机文件顶掉设备上的文件
    const conflicts = new Set<string>()
    const check = async (src: string) => {
      const { name } = splitPath(src)
      try {
        await main.statFile(deviceId, path + name)
        conflicts.add(src)
      } catch (e: any) {
        // 只有明确“文件不存在”才认为可以直传；超时/权限等错误按存在处理，
        // 弹一次覆盖确认，避免把同名文件静默冲掉
        const msg = String((e && e.message) || e)
        if (!/ENOENT|no such file/i.test(msg)) conflicts.add(src)
      }
    }
    for (let i = 0; i < list.length; i += 4) {
      await Promise.all(list.slice(i, i + 4).map(check))
    }
    if (conflicts.size) {
      const overwrite = await LunaModal.confirm(
        t('uploadOverwriteConfirm', { count: conflicts.size })
      )
      if (!overwrite) {
        files = list.filter((src) => !conflicts.has(src))
        if (!files.length) {
          notify(t('uploadSkipped', { count: conflicts.size }), { icon: 'info' })
          return
        }
      }
    }

    let ok = 0
    for (let i = 0, len = files.length; i < len; i++) {
      const src = files[i]
      const { name } = splitPath(src)
      notify(t('fileUploading', { path: src }), { icon: 'info' })
      try {
        await main.pushFile(deviceId, src, path + name)
        ok++
      } catch {
        notify(t('uploadFileErr'), { icon: 'error' })
      }
    }
    if (ok > 1) {
      notify(t('uploadDone', { count: ok }), { icon: 'success' })
    }

    await getFiles(path, true)
  }

  async function goCustomPath(p: string) {
    if (!device) return
    if (!endWith(p, '/')) {
      p = p + '/'
    }
    p = normalizePath(p)
    if (p === customPath) {
      return
    }

    setCustomPath(p)

    try {
      const stat = await main.statFile(device.id, p)
      if (stat.directory) {
        go(p)
      } else {
        setCustomPath(customPath)
      }
    } catch {
      setCustomPath(customPath)
      notify(t('folderNotExistErr'), { icon: 'error' })
    }
  }

  const pathParts = customPath.split('/').filter(Boolean)
  const activeTransfers = file.transfers.filter((item) => !item.done).length

  function startEditPath() {
    if (!device) return
    setPathDraft(customPath || '/')
    setEditingPath(true)
  }

  async function commitPath() {
    let next = pathDraft.trim()
    setEditingPath(false)
    if (!next || next === customPath) return
    if (!next.startsWith('/')) next = '/' + next
    await goCustomPath(next)
  }

  return (
    <div className={PageStyle.page}>
      <header className={PageStyle.head}>
        <div className={PageStyle.title}>{t('file')}</div>
        <div className={PageStyle.sub}>{device ? device.name : ''}</div>
        <div className={PageStyle.actions}>
          <button
            className={
              PageStyle.iconBtn + (file.showTransfer ? ' ' + PageStyle.on : '')
            }
            title={t('transfer')}
            onClick={() => file.set('showTransfer', !file.showTransfer)}
          >
            <span
              className={className('icon-bidirection', {
                [Style.blink]: activeTransfers > 0,
              })}
            />
            {activeTransfers > 0 && (
              <span className={PageStyle.badge}>{activeTransfers}</span>
            )}
          </button>
          <button
            className={PageStyle.iconBtn}
            title={t('refresh')}
            disabled={!device}
            onClick={() => getFiles(path, true)}
          >
            <span className="icon-refresh" />
          </button>
          <button
            className={PageStyle.btn}
            disabled={!device}
            onClick={() => createFolder()}
          >
            <span className="icon-add" />
            {t('newFolder')}
          </button>
          <button
            className={PageStyle.btn + ' ' + PageStyle.primary}
            disabled={!device}
            onClick={() => uploadFiles()}
          >
            <span className="icon-upload" />
            {t('upload')}
          </button>
        </div>
      </header>

      <div className={PageStyle.pathbar}>
        <div className={PageStyle.navBtns}>
          <button
            className={PageStyle.iconBtn}
            title={t('back')}
            disabled={historyIdx <= 0}
            onClick={back}
          >
            <span className="icon-arrow-left" />
          </button>
          <button
            className={PageStyle.iconBtn}
            title={t('forward')}
            disabled={historyIdx >= history.length - 1}
            onClick={forward}
          >
            <span className="icon-arrow-right" />
          </button>
          <button
            className={PageStyle.iconBtn}
            title={t('up')}
            disabled={path === '/' || !device}
            onClick={up}
          >
            <span className="icon-arrow-up" />
          </button>
        </div>

        {editingPath ? (
          <input
            ref={pathInputRef}
            className={PageStyle.pathInput}
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onBlur={() => {
              if (editingPath) setEditingPath(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitPath()
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                setEditingPath(false)
                e.currentTarget.blur()
              }
            }}
          />
        ) : (
          <div className={PageStyle.crumbs}>
            <button
              className={
                PageStyle.crumb +
                (pathParts.length ? '' : ' ' + PageStyle.current)
              }
              onClick={() => go('/')}
            >
              {t('rootDir')}
            </button>
            {pathParts.map((part, index) => (
              <Fragment key={index + ':' + part}>
                <span className={PageStyle.crumbSep}>
                  <span className="icon-chevron-right" />
                </span>
                <button
                  className={
                    PageStyle.crumb +
                    (index === pathParts.length - 1
                      ? ' ' + PageStyle.current
                      : '')
                  }
                  onClick={() =>
                    go('/' + pathParts.slice(0, index + 1).join('/') + '/')
                  }
                >
                  {part}
                </button>
              </Fragment>
            ))}
            <button
              className={PageStyle.crumbEdit}
              title={t('editPath')}
              disabled={!device}
              onClick={startEditPath}
            >
              <span className="icon-editor" />
            </button>
          </div>
        )}

        <div className={PageStyle.searchBox}>
          <span className={PageStyle.searchIcon + ' icon-search'} />
          <input
            className={PageStyle.searchInput}
            value={filter}
            placeholder={t('search')}
            onChange={(e) => {
              const val = e.target.value
              setFilter(val)
              if (!val.trim()) {
                // 清空过滤 → 取消未完成的搜索，重新加载当前目录第一页
                searchSeq.current++
                getFiles(path)
              }
            }}
            onKeyDown={async (e) => {
              if (!(e.ctrlKey || e.metaKey)) return
              const key = e.key.toLowerCase()
              if (key === 'v') {
                e.preventDefault()
                const input = e.currentTarget
                try {
                  const text = await navigator.clipboard.readText()
                  if (!text) return
                  const start = input.selectionStart ?? input.value.length
                  const end = input.selectionEnd ?? start
                  const clean = text.replace(/\r?\n/g, ' ')
                  setFilter(
                    input.value.slice(0, start) + clean + input.value.slice(end)
                  )
                  requestAnimationFrame(() => {
                    const pos = start + clean.length
                    input.setSelectionRange(pos, pos)
                  })
                } catch {
                  // 读不到剪贴板（远程桌面没开剪贴板共享/权限被拒）时保持原样
                }
              } else if (key === 'a') {
                e.preventDefault()
                e.currentTarget.select()
              }
            }}
          />
        </div>

        <button
          className={
            PageStyle.toggle + (searchAll ? ' ' + PageStyle.on : '')
          }
          onClick={() => setSearchAll(!searchAll)}
        >
          {t('allDisks')}
        </button>

        <div className={PageStyle.seg}>
          <button
            className={file.listView ? PageStyle.on : ''}
            title={t('listView')}
            onClick={() => {
              if (!file.listView) file.set('listView', true)
            }}
          >
            <span className="icon-list" />
          </button>
          <button
            className={!file.listView ? PageStyle.on : ''}
            title={t('iconView')}
            onClick={() => {
              if (file.listView) file.set('listView', false)
            }}
          >
            <span className="icon-grid" />
          </button>
        </div>

        <button
          className={
            PageStyle.iconBtn + (file.showPreview ? ' ' + PageStyle.on : '')
          }
          title={t('preview')}
          onClick={() => file.set('showPreview', !file.showPreview)}
        >
          <span className="icon-eye" />
        </button>
      </div>

      <div className={PageStyle.body}>
        <div
          className={
            PageStyle.listPane + (dropHighlight ? ' ' + PageStyle.drop : '')
          }
          onDrop={onDrop}
          onDragEnter={() => {
            draggingRef.current++
          }}
          onDragLeave={() => {
            draggingRef.current--
            if (draggingRef.current === 0) {
              setDropHighlight(false)
            }
          }}
          onDragOver={(e) => {
            if (!isFileDrop(e)) return
            e.preventDefault()
            if (device) setDropHighlight(true)
          }}
        >
          <div className={PageStyle.listWrap} ref={listWrapRef}>
            {file.listView ? (
              <FileGrid
                key={gridKey}
                files={fileList}
                filter={filter}
                pathOf={absPath}
                onSelect={(files) => {
                  setSelectedFiles(files)
                  if (files.length === 1) {
                    // 目录没有可预览的 URL：只选中，别发一次注定失败的 getFileUrl
                    if (files[0].directory) {
                      setSelected(files[0])
                      setSelectedUrl('')
                    } else {
                      preview(files[0])
                    }
                  } else {
                    setSelected(undefined)
                    setSelectedUrl('')
                  }
                }}
                onDeselect={() => {
                  setSelectedFiles([])
                  setSelectedUrl('')
                  setSelected(undefined)
                }}
                onOpen={open}
                onContextMenu={onGridContextMenu}
                onCopy={() => copySelection(false)}
                onCut={() => copySelection(true)}
                onPaste={pasteFromClipboard}
              />
            ) : (
              <LunaFileList
                className={PageStyle.fileList}
                files={fileList}
                filter={filter}
                columns={['name', 'size', 'type', 'mtime', 'mode']}
                listView={false}
                onDoubleClick={(_e: MouseEvent, item: IFile) => open(item)}
                onContextMenu={onContextMenu}
                onSelect={(item: IFile) => {
                  setSelectedFiles([item])
                  preview(item)
                }}
                onDeselect={() => {
                  setSelectedFiles([])
                  setSelectedUrl('')
                  setSelected(undefined)
                }}
              />
            )}

            {!device || (!loading && !searching && !fileList.length) ? (
              <div className={PageStyle.empty}>
                <span className={PageStyle.emptyIcon + ' icon-folder'} />
                <div>
                  {!device
                    ? t('connectToView')
                    : filter.trim()
                      ? t('noMatch')
                      : t('emptyFolder')}
                </div>
                {!device ? (
                  <div className={PageStyle.emptyHint}>{t('connectHint')}</div>
                ) : (
                  <div className={PageStyle.emptyHint}>{t('dropHint')}</div>
                )}
              </div>
            ) : null}
          </div>

          {loading ||
          searching ||
          filter.trim() ||
          fileList.length < total ? (
            <div className={PageStyle.loadMore}>
              {searching ? (
                <span>
                  {searchProgress ? (
                    <span>
                      {t('searching')} {searchProgress.root} ·{' '}
                      {t('foundCount', { count: searchProgress.found })} ·{' '}
                      <span className={PageStyle.timer}>
                        {t('seconds', {
                          n: Math.round(searchProgress.elapsedMs / 1000),
                        })}
                      </span>
                    </span>
                  ) : (
                    t('searchingDots')
                  )}
                </span>
              ) : filter.trim() ? (
                <span>
                  {t('searchResult', {
                    total,
                    scope: searchAll ? t('allStorage') : t('currentDir'),
                  })}
                  {searchLoadedRef.current < total && (
                    <button
                      onClick={loadMoreSearch}
                      disabled={loadingMoreSearch}
                    >
                      {loadingMoreSearch
                        ? t('loading')
                        : t('loadMore', {
                            shown: fileList.length,
                            total,
                          })}
                    </button>
                  )}
                </span>
              ) : loading ? (
                <span>{t('reading')}</span>
              ) : (
                <button onClick={loadMore} disabled={loadingMore}>
                  {loadingMore
                    ? t('loading')
                    : t('loadMore', { shown: fileList.length, total })}
                </button>
              )}
            </div>
          ) : null}
        </div>

        <FileInspector
          files={selectedFiles}
          file={selected}
          url={selectedUrl}
          showPreview={file.showPreview}
          pathOf={absPath}
          onOpen={open}
          onDownload={downloadFiles}
          onInstall={installFile}
          onRename={renameFile}
          onDelete={deleteFiles}
          onClose={clearSelection}
        />
      </div>

      {file.showTransfer && (
        <div className={PageStyle.transferPane}>
          <div className={PageStyle.transferHead}>
            {t('transfer')}
            <span className={PageStyle.transferCount}>
              {file.transfers.length}
            </span>
            <button
              className={PageStyle.transferClose}
              title={t('close')}
              onClick={() => file.set('showTransfer', false)}
            >
              <span className="icon-x" />
            </button>
          </div>
          <div className={PageStyle.transferBody}>
            <Transfer />
          </div>
        </div>
      )}

      <div className={PageStyle.statusbar}>
        <span>{t('totalItems', { total })}</span>
        <span>{t('selectedCount', { count: selectedFiles.length })}</span>
        {filter.trim() && (
          <span>{t('searchFor', { kw: filter.trim() })}</span>
        )}
        <span className={PageStyle.statusRight}>
          <span>
            {device
              ? t('internalStorageFree', { size: storageFree || '--' })
              : t('deviceNotConnected')}
          </span>
        </span>
      </div>
    </div>
  )
})
