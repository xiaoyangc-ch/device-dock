import LunaDataGrid from 'luna-data-grid/react'
import DataGrid, { DataGridNode } from 'luna-data-grid'
import { useEffect, useMemo, useRef } from 'react'
import { useResizeSensor } from 'share/renderer/lib/hooks'
import { t } from 'common/util'
import { IFile } from 'luna-file-list'
import Style from './FileGrid.module.scss'
import fileSize from 'licia/fileSize'
import dateFormat from 'licia/dateFormat'
import isUndef from 'licia/isUndef'
import { iconOf, modeOf, typeOf } from './fileUtil'

interface IFileGridProps {
  files: IFile[]
  filter: string
  pathOf: (file: IFile) => string
  onSelect: (files: IFile[]) => void
  onDeselect: () => void
  onOpen: (file: IFile) => void
  onContextMenu: (e: MouseEvent, files: IFile[]) => void
  onCopy: () => void
  onCut: () => void
  onPaste: () => void
}

const columns = [
  { id: 'name', title: t('name'), weight: 38, sortable: true },
  { id: 'size', title: t('size'), weight: 12 },
  { id: 'type', title: t('type'), weight: 12, sortable: true },
  { id: 'mtime', title: t('dateModified'), weight: 25, sortable: true },
  { id: 'mode', title: t('permissions'), weight: 13, sortable: true },
]

function nameCell(file: IFile) {
  const el = document.createElement('span')
  el.className = Style.nameCell
  const mime = file.mime || ''
  // 设备返回的缩略图只有图片有意义；其它类型是浅灰的通用图标，
  // 在深色主题下就是一块白方，统一改用 Lucide 线性图标。
  if (file.thumbnail && mime.startsWith('image/')) {
    const img = document.createElement('img')
    img.className = Style.nameIcon
    img.src = file.thumbnail
    el.appendChild(img)
  } else {
    const icon = document.createElement('span')
    icon.className = `${Style.nameIcon} ${iconOf(file)}`
    el.appendChild(icon)
  }
  const label = document.createElement('span')
  label.className = Style.nameText
  label.textContent = file.name
  el.appendChild(label)
  return el
}

export default function FileGrid(props: IFileGridProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<DataGrid | null>(null)
  const fileMap = useRef(new Map<string, IFile>())

  const data = useMemo(() => {
    const map = new Map<string, IFile>()
    const rows = props.files.map((file) => {
      const id = props.pathOf(file)
      map.set(id, file)
      return {
        id,
        name: nameCell(file),
        size: file.directory
          ? '—'
          : !isUndef(file.size)
            ? fileSize(file.size)
            : '--',
        type: typeOf(file, t('directory')) || t('file'),
        mtime: dateFormat(file.mtime, 'yyyy-mm-dd HH:MM:ss'),
        mode: modeOf(file),
      }
    })
    fileMap.current = map
    return rows
  }, [props.files])

  // 列宽和可见行数都依赖容器尺寸：挂载后补一次 fit，尺寸变化时再 fit。
  // 少了这步会出现「名称列只剩几像素、只画一行」的半渲染状态。
  useResizeSensor(wrapRef, () => gridRef.current?.fit())
  useEffect(() => {
    const timer = setTimeout(() => gridRef.current?.fit(), 50)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    gridRef.current?.fit()
  }, [data.length])

  // Windows 习惯：Ctrl/Cmd+A 全选、C 复制、X 剪切、V 粘贴
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      // 页签只是 visibility:hidden，监听器仍在：文件页没显示时不能抢 Ctrl+C/V
      const wrap = wrapRef.current
      if (!wrap || getComputedStyle(wrap).visibility === 'hidden') return
      const active = document.activeElement as HTMLElement | null
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable)
      ) {
        return
      }
      const key = e.key.toLowerCase()
      if (key === 'c') {
        e.preventDefault()
        props.onCopy()
        return
      }
      if (key === 'x') {
        e.preventDefault()
        props.onCut()
        return
      }
      if (key === 'v') {
        e.preventDefault()
        props.onPaste()
        return
      }
      if (key !== 'a') return
      const grid: any = gridRef.current
      if (!grid) return
      const nodes: any[] = (grid.displayNodes || grid.nodes || []).filter(
        (node: any) => node.selectable
      )
      if (!nodes.length) return
      e.preventDefault()
      grid.setSelectedNodes(nodes)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onCopy, props.onCut, props.onPaste])

  const toFiles = (nodes: DataGridNode | DataGridNode[]) => {
    const arr = Array.isArray(nodes) ? nodes : [nodes]
    return arr
      .map((node) => fileMap.current.get(String(node.data.id)))
      .filter((file): file is IFile => !!file)
  }

  return (
    <div ref={wrapRef} className={Style.wrap}>
      <LunaDataGrid
        className={Style.grid}
        columns={columns as any}
        data={data}
        filter={props.filter}
        selectable={true}
        multiSelections={true}
        uniqueId="id"
        onCreate={(grid) => {
          gridRef.current = grid
          grid.fit()
        }}
        onSelect={(nodes) => props.onSelect(toFiles(nodes))}
        onDeselect={() => props.onDeselect()}
        onDoubleClick={(_e, nodes) => {
          const files = toFiles(nodes)
          if (files.length) props.onOpen(files[0])
        }}
        onContextMenu={(e, nodes) =>
          props.onContextMenu(e as unknown as MouseEvent, toFiles(nodes))
        }
      />
    </div>
  )
}
