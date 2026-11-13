/**
 * 应用页：列表/图标两种视图，支持搜索、拖放安装、导出 APK、启停/卸载/清数据。
 *
 * 两个性能点：
 * - 包信息按 50 个一组、4 路并发向设备端的 dex 取（600 包的机器原来是十几秒）；
 * - 分块结果按 250ms 节流上屏，边到边显示，全部完成后顺序与分组一致。
 */
import LunaIconList from 'luna-icon-list/react'
import LunaDataGrid from 'luna-data-grid/react'
import isEmpty from 'licia/isEmpty'
import isNull from 'licia/isNull'
import Style from './Application.module.scss'
import { observer } from 'mobx-react-lite'
import { useEffect, useMemo, useRef, useState } from 'react'
import store from '../../store'
import { PannelLoading } from '../common/loading'
import { installPackages } from '../../../lib/util'
import { notify, isFileDrop } from 'share/renderer/lib/util'
import { t } from 'common/util'
import className from 'licia/className'
import endWith from 'licia/endWith'
import chunk from 'licia/chunk'
import LunaModal from 'luna-modal'
import PackageInfoModal from './PackageInfoModal'
import { IPackageInfo } from 'common/types'
import { fallbackIcon } from '../../lib/appIcon'
import contextMenu from 'share/renderer/lib/contextMenu'
import dateFormat from 'licia/dateFormat'
import DataGrid from 'luna-data-grid'
import { useWindowResize } from 'share/renderer/lib/hooks'
import fileSize from 'licia/fileSize'
import jsonClone from 'licia/jsonClone'
import PageToolbar, {
  Page,
  ToolButton,
  ToolCheckbox,
  ToolInput,
  ToolSeparator,
  ToolSpace,
  ToolText,
} from '../layout/PageToolbar'

const CHUNK_SIZE = 50
const CONCURRENCY = 4
const PAINT_INTERVAL = 250

function iconEntry(info: IPackageInfo) {
  const style: any = { borderRadius: '20%' }
  if (!info.enabled) style.filter = 'grayscale(100%)'

  return {
    info,
    src: info.icon || fallbackIcon(info.label, info.packageName),
    name: info.label,
    style,
  }
}

/** dex 起不来时（老 ART、目录缺失）至少把包名和默认图标列出来，别让整页空白。 */
function placeholderInfo(packageName: string, system: boolean): IPackageInfo {
  return {
    packageName,
    label: packageName,
    icon: '',
    enabled: true,
    versionName: '',
    apkPath: '',
    apkSize: 0,
    system,
    firstInstallTime: 0,
    lastUpdateTime: 0,
    dataSize: 0,
    cacheSize: 0,
    appSize: 0,
    signatures: [],
  }
}

function sizeCmp(a: string, b: string) {
  // 显示是 "123 MB" 字符串，排序必须按字节比
  return fileSize(a) - fileSize(b)
}

const columns = [
  { id: 'label', title: t('name'), sortable: true, weight: 20 },
  { id: 'packageName', title: t('package'), sortable: true, weight: 25 },
  { id: 'versionName', title: t('version'), sortable: true, weight: 10 },
  { id: 'minSdkVersion', title: t('minSdkVersion'), sortable: true, weight: 10 },
  {
    id: 'targetSdkVersion',
    title: t('targetSdkVersion'),
    sortable: true,
    visible: false,
    weight: 10,
  },
  {
    id: 'storageUsage',
    title: t('storageUsage'),
    sortable: true,
    comparator: sizeCmp,
    weight: 10,
  },
  {
    id: 'appSize',
    title: t('appSize'),
    sortable: true,
    comparator: sizeCmp,
    visible: false,
    weight: 10,
  },
  {
    id: 'dataSize',
    title: t('dataSize'),
    sortable: true,
    comparator: sizeCmp,
    visible: false,
    weight: 10,
  },
  {
    id: 'cacheSize',
    title: t('cacheSize'),
    sortable: true,
    comparator: sizeCmp,
    visible: false,
    weight: 10,
  },
  { id: 'enabled', title: t('status'), sortable: true, weight: 10 },
  {
    id: 'firstInstallTime',
    title: t('firstInstallTime'),
    sortable: true,
    visible: false,
    weight: 15,
  },
  {
    id: 'lastUpdateTime',
    title: t('lastUpdateTime'),
    sortable: true,
    visible: false,
    weight: 15,
  },
]

export default observer(function Application() {
  const [isLoading, setIsLoading] = useState(false)
  const [packageInfo, setPackageInfo] = useState<IPackageInfo | null>(null)
  const [packageInfos, setPackageInfos] = useState<IPackageInfo[]>([])
  const [filter, setFilter] = useState('')
  // 与文件页一致：单击只选中，双击才是打开；详情走工具栏/右键
  const [selectedPackage, setSelectedPackage] = useState('')
  const [dropHighlight, setDropHighlight] = useState(false)
  const [infoModalVisible, setInfoModalVisible] = useState(false)
  const [openAnimating, setOpenAnimating] = useState(false)
  const [openEffectStyle, setOpenEffectStyle] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  })

  const dataGridRef = useRef<DataGrid>(null)
  const dragging = useRef(0)
  const iconsRef = useRef<any[]>([])
  const iconTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 设备切得快时旧请求可能后到：每次刷新递增序号，回包不是最新就丢弃
  const loadSeq = useRef(0)

  const { device } = store

  useEffect(() => {
    refresh()
  }, [device?.id, device?.type])
  useWindowResize(() => dataGridRef.current?.fit())
  useEffect(() => () => clearTimeout(iconTimer.current), [])

  async function refresh(packageName?: string) {
    if (!device) return
    const deviceId = device.id

    if (!packageName) {
      // ---------- 全量刷新 ----------
      const seq = ++loadSeq.current
      setPackageInfos([])
      setIsLoading(true)

      try {
        const packages = await main.getPackages(
          deviceId,
          store.application.sysPackage
        )
        if (seq !== loadSeq.current) return

        const chunks = chunk(packages, CHUNK_SIZE)
        const parts: any[][] = new Array(chunks.length)
        let next = 0
        let done = 0
        let lastPaint = 0

        // 每块都 setState 会让 600 包反复重建几百行 DOM，节流到 250ms
        const paint = (force: boolean) => {
          if (seq !== loadSeq.current) return

          const now = Date.now()
          if (force || now - lastPaint >= PAINT_INTERVAL) {
            lastPaint = now
            setPackageInfos(parts.filter(Boolean).flat())
          }
        }

        const worker = async () => {
          for (;;) {
            const index = next++
            if (index >= chunks.length) return

            // dex 挂了也别整页空白：退回「包名 + 默认图标」，至少能操作
            parts[index] = await main
              .getPackageInfos(deviceId, chunks[index])
              .catch(() =>
                chunks[index].map((name) =>
                  placeholderInfo(name, store.application.sysPackage)
                )
              )

            done++
            paint(done === chunks.length)
          }
        }

        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker)
        )
        if (seq !== loadSeq.current) return

        const all = parts.filter(Boolean).flat()
        setPackageInfos(all)
        // 图标数组整轮只建一次：原来每个分块都重算全部包，600 包时是 O(n²)
        iconsRef.current = all.map(iconEntry)
      } catch (e: any) {
        // 设备掉线/超时：不提示的话界面一片空白，分不清「真没装应用」
        notify(t('appListFailed') + (e?.message || e), { icon: 'error' })
      } finally {
        if (seq === loadSeq.current) setIsLoading(false)
      }
      return
    }

    // ---------- 单包刷新（启停/清数据后） ----------
    const seq = loadSeq.current
    try {
      const infos = await main.getPackageInfos(deviceId, [packageName])
      if (seq !== loadSeq.current || store.device?.id !== deviceId) return

      const info = infos[0]
      // 包在查询间隙被卸载时 infos 为空，不能拿 undefined 去读 enabled
      if (!info) return

      // 全量刷新可能在这期间替换了列表：函数式更新，别拿旧闭包数组覆盖新结果
      setPackageInfos((prev) => {
        const index = prev.findIndex((item) => item.packageName === packageName)
        if (index === -1) return prev

        const next = prev.slice()
        next[index] = info
        return next
      })
      iconsRef.current = iconsRef.current.map((icon) =>
        icon.info.packageName === packageName ? iconEntry(info) : icon
      )
    } catch {
      // 设备掉线/超时：静默保留旧数据，下次刷新再试
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDropHighlight(false)

    const apkPaths: string[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const filePath = preload.getPathForFile(file)
      if (endWith(filePath, '.apk')) apkPaths.push(filePath)
    }
    await install(apkPaths)
  }

  async function install(apkPaths?: string[]) {
    if (!device) {
      notify(t('deviceNotConnected'), { icon: 'error' })
      return
    }

    const installed = await installPackages(device.id, apkPaths)
    if (installed) refresh()
  }

  /** 选中/双击时再去设备上拉一次真实图标：滚一遍列表不会把每个 APK 都 pull 下来。 */
  function loadIcon(packageName: string) {
    clearTimeout(iconTimer.current)
    if (!packageName) return

    iconTimer.current = setTimeout(async () => {
      const dev = store.device
      if (!dev) return

      if (
        iconsRef.current.some(
          (item) => item.info.packageName === packageName && item.info.icon
        )
      ) {
        return
      }

      const icon = await main.getPackageIcon(dev.id, packageName).catch(() => '')
      if (!icon) return

      setPackageInfos((list) =>
        list.map((info) =>
          info.packageName === packageName ? { ...info, icon } : info
        )
      )
      iconsRef.current = iconsRef.current.map((item) =>
        item.info.packageName === packageName
          ? iconEntry({ ...item.info, icon })
          : item
      )
    }, 600)
  }

  function showInfo(packageName: string) {
    const found = packageInfos.find(
      (info) => info.packageName === packageName
    )
    if (!found) return

    setPackageInfo(found)
    setInfoModalVisible(true)
  }

  function confirmText(key: string, info: IPackageInfo) {
    const text = t(key, { name: info.label })
    // 系统应用被停用可能影响设备功能：确认框要说清楚
    return info.system ? t('sysPackageTip') + ' ' + text : text
  }

  async function open(packageName: string) {
    try {
      await main.startPackage(store.device!.id, packageName)
    } catch {
      notify(t('startPackageErr'), { icon: 'error' })
    }
  }

  function onContextMenu(e: PointerEvent, info: IPackageInfo) {
    const current = store.device!

    const template: any[] = [
      {
        label: t('packageInfo'),
        click() {
          showInfo(info.packageName)
        },
      },
      {
        label: t('exportApk'),
        click: async () => {
          const { canceled, filePath } = await main.showSaveDialog({
            defaultPath: `${info.packageName}-${info.versionName}.apk`,
          })
          if (canceled) return

          await main.pullFile(current.id, info.apkPath, filePath)
          notify(t('apkExported', { path: filePath }), {
            icon: 'success',
            duration: 5000,
          })
        },
      },
      { type: 'separator' },
      {
        label: t('open'),
        click: () => open(info.packageName),
      },
      {
        label: t('stop'),
        click: async () => {
          const ok = await LunaModal.confirm(
            confirmText('stopPackageConfirm', info)
          )
          if (ok) await main.stopPackage(current.id, info.packageName)
        },
      },
      { type: 'separator' },
      {
        label: t('disablePackage'),
        click: async () => {
          const ok = await LunaModal.confirm(
            confirmText('disablePackageConfirm', info)
          )
          if (!ok) return

          await main.disablePackage(current.id, info.packageName)
          refresh(info.packageName)
        },
      },
      {
        label: t('enablePackage'),
        click: async () => {
          await main.enablePackage(current.id, info.packageName)
          refresh(info.packageName)
        },
      },
      { type: 'separator' },
      {
        label: t('clearData'),
        click: async () => {
          const ok = await LunaModal.confirm(
            confirmText('clearDataConfirm', info)
          )
          if (!ok) return

          await main.clearPackage(current.id, info.packageName)
          notify(t('dataCleared'), { icon: 'success' })
          // pm clear 是异步生效的：等 1 秒再刷新，否则读到旧占用
          setTimeout(() => refresh(info.packageName), 1000)
        },
      },
      {
        label: t('uninstall'),
        click: async () => {
          const ok = await LunaModal.confirm(
            confirmText('uninstallConfirm', info)
          )
          if (!ok) return

          await main.uninstallPackage(current.id, info.packageName)
          refresh()
        },
      },
    ]

    contextMenu(e, template)
  }

  // 每帧重建几百行（每行还要新 DOM 节点）会把筛选输入拖卡：
  // 只有 packageInfos / 视图模式变化时才重算
  const gridData = useMemo(
    () =>
      store.application.listView
        ? packageInfos.map((info) => ({
            info,
            // 名称列要带图标：列渲染是纯文本，只能自己拼一个 span
            label: (() => {
              const span = document.createElement('span')
              const img = document.createElement('img')
              img.src = info.icon || fallbackIcon(info.label, info.packageName)
              span.append(img, document.createTextNode(info.label))
              return span
            })(),
            packageName: info.packageName,
            versionName: info.versionName,
            minSdkVersion: info.minSdkVersion,
            targetSdkVersion: info.targetSdkVersion,
            storageUsage: fileSize(
              info.appSize + info.dataSize + info.cacheSize
            ),
            appSize: fileSize(info.appSize),
            dataSize: fileSize(info.dataSize),
            cacheSize: fileSize(info.cacheSize),
            enabled: info.enabled ? t('enabled') : t('disabled'),
            firstInstallTime: dateFormat(
              new Date(info.firstInstallTime),
              'yyyy-mm-dd HH:MM:ss'
            ),
            lastUpdateTime: dateFormat(
              new Date(info.lastUpdateTime),
              'yyyy-mm-dd HH:MM:ss'
            ),
          }))
        : [],
    [packageInfos, store.application.listView]
  )

  const applications = (
    <div
      className={Style.appView}
      style={{
        overflowY: store.application.listView ? 'hidden' : 'auto',
      }}
      onDrop={onDrop}
      onDragEnter={() => {
        dragging.current++
      }}
      onDragLeave={() => {
        dragging.current--
        if (dragging.current === 0) setDropHighlight(false)
      }}
      onDragOver={(e) => {
        if (!isFileDrop(e)) return
        e.preventDefault()
        setDropHighlight(true)
      }}
    >
      {store.application.listView ? (
        <LunaDataGrid
          onColumnChange={async () => {
            const current = dataGridRef.current!.getOption('columns')
            store.application.set('dataGridColumns', jsonClone(current))
          }}
          onSelect={(node: any) => {
            const picked = Array.isArray(node) ? node[0] : node
            setSelectedPackage(picked?.data?.packageName || '')
            loadIcon(picked?.data?.packageName || '')
          }}
          onDoubleClick={(_e: any, node) => {
            open((node as any).data.packageName)
          }}
          onContextMenu={(e: any, node) => {
            onContextMenu(e, (node as any).data.info)
          }}
          headerContextMenu={true}
          filter={filter}
          columns={columns}
          data={gridData}
          selectable={true}
          uniqueId="packageName"
          onCreate={(dataGrid) => {
            dataGridRef.current = dataGrid
            dataGrid.fit()

            // 只回填宽度/显示/顺序：整份 columns 塞回去会丢掉 comparator
            // （jsonClone 不保留函数），重启后按容量排序会退化成字符串比较
            const saved: any[] = store.application.dataGridColumns || []
            if (!saved.length) return

            const byId = new Map(columns.map((col) => [col.id, col]))
            const merged: any[] = saved
              .map((item: any) => {
                const col = byId.get(item.id)
                return col
                  ? { ...col, width: item.width, visible: item.visible !== false }
                  : null
              })
              .filter(Boolean)
            for (const col of columns) {
              if (!saved.some((item: any) => item.id === col.id)) merged.push(col)
            }
            dataGrid.setOption('columns', merged)
          }}
        />
      ) : (
        <LunaIconList
          icons={iconsRef.current}
          size={store.application.itemSize}
          filter={filter}
          onClick={(e: any, icon) => {
            const info = (icon.data as any).info
            showInfo(info.packageName)
            loadIcon(info.packageName)
          }}
          onDoubleClick={(e: any, icon) => {
            const info = (icon.data as any).info
            const container: HTMLElement = icon.container
            const rect = container.getBoundingClientRect()
            // 双击图标时从图标位置放大一次：给「打开了」一个视觉落点
            setOpenEffectStyle({
              left: rect.left,
              top: rect.top - 60,
              width: rect.width,
              height: rect.width,
            })
            open(info.packageName)
            setOpenAnimating(true)
          }}
          onContextMenu={(e: any, icon) => {
            onContextMenu(e, (icon.data as any).info)
          }}
        />
      )}
      <div
        className={className({
          [Style.appOpenRipple]: true,
          [Style.appOpenRippleRun]: openAnimating,
        })}
        style={openEffectStyle}
        onAnimationEnd={() => setOpenAnimating(false)}
      />
    </div>
  )

  return (
    <Page>
      <PageToolbar>
        <ToolInput
          value={filter}
          width={180}
          placeholder={t('filter')}
          onChange={setFilter}
        />
        <ToolCheckbox
          checked={store.application.sysPackage}
          label={t('sysPackage')}
          disabled={isLoading}
          onChange={(value) => {
            store.application.set('sysPackage', value)
            refresh()
          }}
        />
        <ToolSeparator />
        <ToolText>{t('totalPackage', { total: packageInfos.length })}</ToolText>
        <ToolSpace />
        <ToolButton
          icon="icon-add"
          title={t('install')}
          onClick={() => install()}
          disabled={!device}
        />
        <ToolSeparator />
        <ToolButton
          icon="icon-zoom-in"
          title={t('zoomIn')}
          disabled={
            store.application.listView ||
            store.application.itemSize > 256 ||
            isEmpty(packageInfos)
          }
          onClick={() =>
            store.application.set(
              'itemSize',
              Math.round(store.application.itemSize * 1.2)
            )
          }
        />
        <ToolButton
          icon="icon-zoom-out"
          title={t('zoomOut')}
          disabled={
            store.application.listView ||
            store.application.itemSize < 32 ||
            isEmpty(packageInfos)
          }
          onClick={() =>
            store.application.set(
              'itemSize',
              Math.round(store.application.itemSize * 0.8)
            )
          }
        />
        <ToolSeparator />
        <ToolButton
          icon="icon-grid"
          title={t('iconView')}
          active={!store.application.listView}
          onClick={() => {
            if (store.application.listView) {
              store.application.set('listView', false)
            }
          }}
        />
        <ToolButton
          icon="icon-list"
          title={t('listView')}
          active={store.application.listView}
          onClick={() => {
            if (!store.application.listView) {
              store.application.set('listView', true)
            }
          }}
        />
        <ToolSeparator />
        <ToolButton
          icon="icon-info"
          title={t('packageInfo')}
          disabled={!selectedPackage}
          onClick={() => showInfo(selectedPackage)}
        />
        <ToolButton
          icon="icon-refresh"
          title={t('refresh')}
          disabled={isLoading || !device}
          onClick={() => refresh()}
        />
      </PageToolbar>
      <div
        className={className(Style.appPane, {
          [Style.appDropActive]: dropHighlight,
        })}
      >
        {isLoading && isEmpty(packageInfos) ? <PannelLoading /> : applications}
      </div>
      {!isNull(packageInfo) && (
        <PackageInfoModal
          packageInfo={packageInfo}
          visible={infoModalVisible}
          onClose={() => setInfoModalVisible(false)}
        />
      )}
    </Page>
  )
})
