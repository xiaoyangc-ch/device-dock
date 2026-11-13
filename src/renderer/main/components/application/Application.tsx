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
import find from 'licia/find'
import chunk from 'licia/chunk'
import map from 'licia/map'
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

// devicedock.dex 起不来时（老 ART、目录缺失等）至少把包名和默认图标列出来，
// 别让整页空白；名称/版本点进详情再补
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

export default observer(function Application() {
  const [isLoading, setIsLoading] = useState(false)
  const [packageInfo, setPackageInfo] = useState<IPackageInfo | null>(null)
  const [packageInfos, setPackageInfos] = useState<IPackageInfo[]>([])
  const [filter, setFilter] = useState('')
  // 与文件页一致：单击只选中，双击才是打开；详情走工具栏/右键
  const [selectedPackage, setSelectedPackage] = useState('')
  const [dropHighlight, setDropHighlight] = useState(false)
  const dataGridRef = useRef<DataGrid>(null)
  const [packageInfoModalVisible, setPackageInfoModalVisible] = useState(false)
  const [isOpenEffectAnimating, setIsOpenEffectAnimating] = useState(false)
  const [openEffectStyle, setOpenEffectStyle] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  })
  const draggingRef = useRef(0)
  const iconsRef = useRef<any[]>([])
  // 设备切得快时，旧设备的 getPackages 可能晚回来覆盖新设备列表。
  // 每次刷新递增序号，回包时不是最新请求就直接丢弃。
  const loadSeq = useRef(0)

  const { device } = store

  useEffect(() => {
    refresh()
  }, [device?.id, device?.type])
  useWindowResize(() => dataGridRef.current?.fit())

  async function refresh(packageName?: string) {
    if (!device) return
    const deviceId = device.id
    if (!packageName) {
      const seq = ++loadSeq.current
      setPackageInfos([])
      setIsLoading(true)
      try {
        const packages = await main.getPackages(
          deviceId,
          store.application.sysPackage
        )
        if (seq !== loadSeq.current) return
        const chunks = chunk(packages, 50)
        // 设备端 dex 能并行处理多个请求：实测 95 个包 4 路并发 94ms，
        // 串行两批 420ms。600 包的门店机原来是十几秒，这里并发 4 路。
        const parts: any[][] = new Array(chunks.length)
        let next = 0
        let done = 0
        let lastPaint = 0
        const paint = (force: boolean) => {
          if (seq !== loadSeq.current) return
          const now = Date.now()
          // 每块都 setState 会让 600 包反复重建几百行 DOM，节流到 250ms
          if (force || now - lastPaint >= 250) {
            lastPaint = now
            setPackageInfos(parts.filter(Boolean).flat())
          }
        }
        const worker = async () => {
          for (;;) {
            const i = next++
            if (i >= chunks.length) return
            // dex 挂了也别整页空白：退回「包名 + 默认图标」，至少能操作
            parts[i] = await main
              .getPackageInfos(deviceId, chunks[i])
              .catch(() =>
                map(chunks[i], (name) =>
                  placeholderInfo(name, store.application.sysPackage)
                )
              )
            done++
            // 边到边显示；全部完成后顺序仍与 chunks 一致
            paint(done === chunks.length)
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(4, chunks.length) }, worker)
        )
        if (seq !== loadSeq.current) return
        const packageInfos = parts.filter(Boolean).flat()
        setPackageInfos(packageInfos)
        // 图标数组整轮建一次即可：原来每个分块都重算全部包，600 包时是 O(n²)
        iconsRef.current = map(packageInfos, iconEntry)
      } catch (e: any) {
        // 设备掉线/超时：不提示的话界面就是一片空白，和「这台设备真没装应用」分不出来
        notify(t('appListFailed') + (e && e.message ? e.message : e), {
          icon: 'error',
        })
      } finally {
        if (seq === loadSeq.current) setIsLoading(false)
      }
    } else {
      const seq = loadSeq.current
      try {
        const infos = await main.getPackageInfos(deviceId, [packageName])
        if (seq !== loadSeq.current || store.device?.id !== deviceId) return
        const info = infos[0]
        // 包在查询间隙被卸载时 infos 为空，不能拿 undefined 去读 enabled
        if (!info) return
        // 全量刷新可能在这期间替换了列表：函数式更新，别拿旧闭包数组覆盖新结果
        setPackageInfos((prev) => {
          const idx = prev.findIndex(
            (item) => item.packageName === packageName
          )
          if (idx === -1) return prev
          const next = prev.slice()
          next[idx] = info
          return next
        })
        iconsRef.current = iconsRef.current.map((icon) =>
          icon.info.packageName === packageName ? iconEntry(info) : icon
        )
      } catch {
        // 设备掉线/超时：静默保留旧数据，下次刷新再试
      }
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDropHighlight(false)
    const files = e.dataTransfer.files
    const apkPaths: string[] = []
    for (let i = 0, len = files.length; i < len; i++) {
      const path = preload.getPathForFile(files[i])
      if (!endWith(path, '.apk')) {
        continue
      }
      apkPaths.push(path)
    }
    await install(apkPaths)
  }

  async function install(apkPaths?: string[]) {
    if (!device) {
      notify(t('deviceNotConnected'), { icon: 'error' })
      return
    }
    const result = await installPackages(device.id, apkPaths)
    if (result) {
      refresh()
    }
  }

  // 选中应用后才去设备上拉一次真实图标；快速滚动列表不会每个都 pull APK
  const iconTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const loadIcon = (packageName: string) => {
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
      const icon = await main
        .getPackageIcon(dev.id, packageName)
        .catch(() => '')
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

  useEffect(() => () => clearTimeout(iconTimer.current), [])

  function showInfo(packageName: string) {
    const packageInfo = find(
      packageInfos,
      (info) => info.packageName === packageName
    )
    if (packageInfo) {
      setPackageInfo(packageInfo)
      setPackageInfoModalVisible(true)
    }
  }

  function confirmText(key: string, info: any) {
    const ret = t(key, { name: info.label })

    if (info.system) {
      return t('sysPackageTip') + ' ' + ret
    }

    return ret
  }

  async function open(packageName: string) {
    try {
      await main.startPackage(store.device!.id, packageName)
    } catch {
      notify(t('startPackageErr'), { icon: 'error' })
    }
  }

  function onContextMenu(e: PointerEvent, info: IPackageInfo) {
    const device = store.device!

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
          if (canceled) {
            return
          }
          await main.pullFile(device.id, info.apkPath, filePath)
          notify(t('apkExported', { path: filePath }), {
            icon: 'success',
            duration: 5000,
          })
        },
      },
      {
        type: 'separator',
      },
      {
        label: t('open'),
        click: () => open(info.packageName),
      },
      {
        label: t('stop'),
        click: async () => {
          const result = await LunaModal.confirm(
            confirmText('stopPackageConfirm', info)
          )
          if (result) {
            await main.stopPackage(device.id, info.packageName)
          }
        },
      },
      {
        type: 'separator',
      },
      {
        label: t('disablePackage'),
        click: async () => {
          const result = await LunaModal.confirm(
            confirmText('disablePackageConfirm', info)
          )
          if (result) {
            await main.disablePackage(device.id, info.packageName)
            refresh(info.packageName)
          }
        },
      },
      {
        label: t('enablePackage'),
        click: async () => {
          await main.enablePackage(device.id, info.packageName)
          refresh(info.packageName)
        },
      },
      {
        type: 'separator',
      },
      {
        label: t('clearData'),
        click: async () => {
          const result = await LunaModal.confirm(
            confirmText('clearDataConfirm', info)
          )
          if (result) {
            await main.clearPackage(device.id, info.packageName)
            notify(t('dataCleared'), { icon: 'success' })
            setTimeout(() => refresh(info.packageName), 1000)
          }
        },
      },
      {
        label: t('uninstall'),
        click: async () => {
          const result = await LunaModal.confirm(
            confirmText('uninstallConfirm', info)
          )
          if (result) {
            await main.uninstallPackage(device.id, info.packageName)
            refresh()
          }
        },
      },
    ]

    contextMenu(e, template)
  }

  // 每次重渲染都重建几百行数据（每行还要新建 DOM 节点）会把筛选输入拖卡，
  // 只有 packageInfos 真正变化（刷新/搜索）时才重算
  const gridData = useMemo(
    () =>
      store.application.listView
        ? map(packageInfos, (info: IPackageInfo) => ({
            info,
            label: (() => {
              const span = document.createElement('span')
              const img = document.createElement('img')
              img.src =
                info.icon || fallbackIcon(info.label, info.packageName)
              span.append(img, document.createTextNode(info.label))
              return span
            })(),
            packageName: info.packageName,
            versionName: info.versionName,
            minSdkVersion: info.minSdkVersion,
            targetSdkVersion: info.targetSdkVersion,
            storageUsage: fileSize(info.appSize + info.dataSize + info.cacheSize),
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
      className={Style.applications}
      style={{
        overflowY: store.application.listView ? 'hidden' : 'auto',
      }}
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
        if (!isFileDrop(e)) {
          return
        }
        e.preventDefault()
        setDropHighlight(true)
      }}
    >
      {store.application.listView ? (
        <LunaDataGrid
          onColumnChange={async () => {
            const columns = dataGridRef.current!.getOption('columns')
            store.application.set('dataGridColumns', jsonClone(columns))
          }}
          onSelect={(node: any) => {
            const n = Array.isArray(node) ? node[0] : node
            setSelectedPackage(n?.data?.packageName || '')
            loadIcon(n?.data?.packageName || '')
          }}
          onDoubleClick={(e: any, node) => {
            open(((node as any).data as any).packageName)
          }}
          onContextMenu={(e: any, node) => {
            onContextMenu(e, ((node as any).data as any).info)
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
            // 只回填宽度/显示/顺序：之前直接把存下来的整份 columns 塞回去，
            // jsonClone 会把 comparator 丢掉，重启后按容量排序退化成字符串比较
            const saved: any[] = store.application.dataGridColumns || []
            if (!saved.length) return
            const byId = new Map(columns.map((col) => [col.id, col]))
            const merged: any[] = saved
              .map((s: any) => {
                const col = byId.get(s.id)
                return col
                  ? { ...col, width: s.width, visible: s.visible !== false }
                  : null
              })
              .filter(Boolean)
            for (const col of columns) {
              if (!saved.some((s: any) => s.id === col.id)) merged.push(col)
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
            const clientRect = container.getBoundingClientRect()
            setOpenEffectStyle({
              left: clientRect.left,
              top: clientRect.top - 60,
              width: clientRect.width,
              height: clientRect.width,
            })
            open(info.packageName)
            setIsOpenEffectAnimating(true)
          }}
          onContextMenu={(e: any, icon) => {
            onContextMenu(e, (icon.data as any).info)
          }}
        />
      )}
      <div
        className={className({
          [Style.openEffect]: true,
          [Style.openEffectAnimation]: isOpenEffectAnimating,
        })}
        style={openEffectStyle}
        onAnimationEnd={() => setIsOpenEffectAnimating(false)}
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
          onChange={(val) => setFilter(val)}
        />
        <ToolCheckbox
          checked={store.application.sysPackage}
          label={t('sysPackage')}
          disabled={isLoading}
          onChange={(val) => {
            store.application.set('sysPackage', val)
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
          onClick={() => {
            const itemSize = Math.round(store.application.itemSize * 1.2)
            store.application.set('itemSize', itemSize)
          }}
        />
        <ToolButton
          icon="icon-zoom-out"
          title={t('zoomOut')}
          disabled={
            store.application.listView ||
            store.application.itemSize < 32 ||
            isEmpty(packageInfos)
          }
          onClick={() => {
            const itemSize = Math.round(store.application.itemSize * 0.8)
            store.application.set('itemSize', itemSize)
          }}
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
        className={className(Style.body, {
          [Style.highlight]: dropHighlight,
        })}
      >
        {isLoading && isEmpty(packageInfos) ? <PannelLoading /> : applications}
      </div>
      {!isNull(packageInfo) && (
        <PackageInfoModal
          packageInfo={packageInfo}
          visible={packageInfoModalVisible}
          onClose={() => setPackageInfoModalVisible(false)}
        />
      )}
    </Page>
  )
})

function sizeCmp(a: string, b: string) {
  return fileSize(a) - fileSize(b)
}

const columns = [
  {
    id: 'label',
    title: t('name'),
    sortable: true,
    weight: 20,
  },
  {
    id: 'packageName',
    title: t('package'),
    sortable: true,
    weight: 25,
  },
  {
    id: 'versionName',
    title: t('version'),
    sortable: true,
    weight: 10,
  },
  {
    id: 'minSdkVersion',
    title: t('minSdkVersion'),
    sortable: true,
    weight: 10,
  },
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
  {
    id: 'enabled',
    title: t('status'),
    sortable: true,
    weight: 10,
  },
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
