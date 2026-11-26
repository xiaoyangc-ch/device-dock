/**
 * 应用页：列表/图标两种视图，支持搜索、拖放安装、导出 APK、启停/卸载/清数据。
 *
 * 两个性能点：
 * - 包信息按 100 个一组顺序取；单条设备 socket 在 dex 端本身也是串行处理；
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
import { iconEntry } from './applicationModel'
import { useApplicationPackages } from './useApplicationPackages'

function sizeCmp(a: string, b: string) {
  // 显示是 "123 MB" 字符串，排序必须按字节比
  return fileSize(a) - fileSize(b)
}

function formatTimestamp(timestamp: number) {
  return timestamp > 0
    ? dateFormat(new Date(timestamp), 'yyyy-mm-dd HH:MM:ss')
    : '--'
}

const columns = [
  { id: 'label', title: t('name'), sortable: true, weight: 20 },
  { id: 'packageName', title: t('package'), sortable: true, weight: 25 },
  { id: 'versionName', title: t('version'), sortable: true, weight: 10 },
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
  const [packageInfo, setPackageInfo] = useState<IPackageInfo | null>(null)
  const [filter, setFilter] = useState('')
  // 与文件页一致：单击只选中，双击才是打开；详情走工具栏/右键
  const [selectedPackage, setSelectedPackage] = useState('')
  const [dropHighlight, setDropHighlight] = useState(false)
  const [openAnimating, setOpenAnimating] = useState(false)
  const [openEffectStyle, setOpenEffectStyle] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  })

  const dataGridRef = useRef<DataGrid>(null)
  const dragging = useRef(0)
  const iconTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const { device } = store
  const { isLoading, packageInfos, refresh, updatePackageIcon } =
    useApplicationPackages(device?.id, device?.type)
  const icons = useMemo(() => packageInfos.map(iconEntry), [packageInfos])

  useWindowResize(() => dataGridRef.current?.fit())
  useEffect(() => () => clearTimeout(iconTimer.current), [])

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
        packageInfos.some(
          (item) => item.packageName === packageName && item.icon,
        )
      ) {
        return
      }

      const icon = await main
        .getPackageIcon(dev.id, packageName)
        .catch(() => '')
      if (!icon) return

      updatePackageIcon(packageName, icon)
    }, 600)
  }

  function showInfo(packageName: string) {
    const found = packageInfos.find((info) => info.packageName === packageName)
    if (!found) return

    setPackageInfo(found)
    store.openModal('packageInfo')
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
          try {
            const version = info.versionName ? `-${info.versionName}` : ''
            const { canceled, filePath } = await main.showSaveDialog({
              defaultPath: `${info.packageName}${version}.apk`,
            })
            if (canceled) return

            const apkPath =
              info.apkPath ||
              (await main.getPackageApkPath(current.id, info.packageName))
            if (!apkPath) throw new Error(t('apkPathUnavailable'))

            // 保存框已经确认过覆盖，pullFile 默认不覆盖会让二次导出失败
            await main.pullFile(current.id, apkPath, filePath, {
              overwrite: true,
            })
            notify(t('apkExported', { path: filePath }), {
              icon: 'success',
              duration: 5000,
            })
          } catch (e: any) {
            notify(t('apkExportFailed') + (e?.message || e), {
              icon: 'error',
            })
          }
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
            confirmText('stopPackageConfirm', info),
          )
          if (ok) await main.stopPackage(current.id, info.packageName)
        },
      },
      { type: 'separator' },
      {
        label: t('disablePackage'),
        click: async () => {
          const ok = await LunaModal.confirm(
            confirmText('disablePackageConfirm', info),
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
            confirmText('clearDataConfirm', info),
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
            confirmText('uninstallConfirm', info),
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
            versionName: info.versionName || '--',
            minSdkVersion: info.minSdkVersion ?? '--',
            targetSdkVersion: info.targetSdkVersion ?? '--',
            storageUsage:
              info.appSize + info.dataSize + info.cacheSize > 0
                ? fileSize(info.appSize + info.dataSize + info.cacheSize)
                : '--',
            appSize: info.appSize > 0 ? fileSize(info.appSize) : '--',
            dataSize: info.dataSize > 0 ? fileSize(info.dataSize) : '--',
            cacheSize: info.cacheSize > 0 ? fileSize(info.cacheSize) : '--',
            enabled: info.enabled ? t('enabled') : t('disabled'),
            firstInstallTime: formatTimestamp(info.firstInstallTime),
            lastUpdateTime: formatTimestamp(info.lastUpdateTime),
          }))
        : [],
    [packageInfos, store.application.listView],
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
                  ? {
                      ...col,
                      width: item.width,
                      visible: item.visible !== false,
                    }
                  : null
              })
              .filter(Boolean)
            for (const col of columns) {
              if (!saved.some((item: any) => item.id === col.id))
                merged.push(col)
            }
            dataGrid.setOption('columns', merged)
          }}
        />
      ) : (
        <LunaIconList
          icons={icons}
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
        <ToolText>
          {isLoading && isEmpty(packageInfos)
            ? t('loading')
            : t('totalPackage', { total: packageInfos.length })}
        </ToolText>
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
              Math.round(store.application.itemSize * 1.2),
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
              Math.round(store.application.itemSize * 0.8),
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
          visible={store.activeModal === 'packageInfo'}
          onClose={() => store.closeModal('packageInfo')}
        />
      )}
    </Page>
  )
})
