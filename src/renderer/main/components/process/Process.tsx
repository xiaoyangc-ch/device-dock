/**
 * 进程页：5 秒轮询设备进程（窗口隐藏时 15 秒），把 cmdline 里的包名换成应用名 + 图标。
 */
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useRef, useState } from 'react'
import store from '../../store'
import LunaDataGrid from 'luna-data-grid/react'
import Style from './Process.module.scss'
import PageToolbar, {
  Page,
  PageBody,
  ToolButton,
  ToolCheckbox,
  ToolInput,
  ToolSeparator,
  ToolSpace,
  ToolText,
} from '../layout/PageToolbar'
import fileSize from 'licia/fileSize'
import has from 'licia/has'
import isEmpty from 'licia/isEmpty'
import { t } from 'common/util'
import LunaModal from 'luna-modal'
import singleton from 'licia/singleton'
import { fallbackIcon } from '../../lib/appIcon'
import DataGrid from 'luna-data-grid'
import { useWindowResize } from 'share/renderer/lib/hooks'

// cmdline 形如 com.android.systemui:remote：取前段当包名
const PKG_RE = /^[\w.]+/

const columns = [
  { id: 'name', title: t('processName'), sortable: true, weight: 30 },
  { id: '%cpu', title: '% CPU', sortable: true, weight: 10 },
  { id: 'time+', title: t('cpuTime'), sortable: true, weight: 10 },
  {
    id: 'res',
    title: t('memory'),
    sortable: true,
    comparator: (a: string, b: string) => fileSize(a) - fileSize(b),
    weight: 10,
  },
  { id: 'pid', title: 'PID', sortable: true, weight: 10 },
  { id: 'user', title: t('user'), sortable: true, weight: 10 },
]

export default observer(function Process() {
  const [processes, setProcesses] = useState<any[]>([])
  const [selected, setSelected] = useState<any>(null)
  const [filter, setFilter] = useState('')

  const packagesRef = useRef<string[]>([])
  const packageInfosRef = useRef<any[]>([])
  const dataGridRef = useRef<DataGrid>(null)

  const { device } = store

  const getPackageInfos = useCallback(
    singleton(async () => {
      if (!device) return

      try {
        packagesRef.current = await main.getPackages(device.id)
        packageInfosRef.current = await main.getPackageInfos(
          device.id,
          packagesRef.current
        )
      } catch {
        // 设备掉线时不能变成未处理拒绝（轮询循环里没人接这个 promise）
      }
    }),
    [device?.id, device?.type]
  )

  // 每 5 秒轮询一次：同一进程名/包名不变时复用上一轮的 DOM 节点，
  // 否则 260 行 × 6 列每轮全部重建（老设备上能明显看到卡顿）
  const rowCache = useRef(
    new Map<string, { packageName: string; nameEl: HTMLElement }>()
  )

  const getProcesses = useCallback(
    singleton(async () => {
      if (!device) return

      // 首次进页面必须等包名/图标就绪，否则第一屏全是 cmdline 原始名
      if (isEmpty(packageInfosRef.current)) {
        await getPackageInfos()
      }

      const all = await main.getProcesses(device.id)
      const infos = packageInfosRef.current
      const byPackage = new Map(infos.map((info) => [info.packageName, info]))

      const alive = new Set<string>()
      let list = all.map((item: any) => {
        // 正则每个进程只跑一次：放 find 回调里会变成 266 进程 × 700 包
        const matched = item.name.match(PKG_RE)
        const pkgName = matched ? matched[0] : ''
        const info = pkgName ? byPackage.get(pkgName) : undefined
        if (!info) return item

        const key = String(item.pid ?? item.name)
        alive.add(key)
        const cached = rowCache.current.get(key)
        if (cached && cached.packageName === info.packageName) {
          return {
            ...item,
            packageName: info.packageName,
            label: info.label,
            name: cached.nameEl,
          }
        }

        // 进程名/应用名来自设备，直接拼 HTML 会被注入：用 DOM API 拼
        const icon = info.icon || fallbackIcon(info.label, info.packageName)
        const nameEl = document.createElement('span')
        const img = document.createElement('img')
        img.src = icon
        nameEl.append(
          img,
          document.createTextNode(
            String(item.name).replace(info.packageName, info.label)
          )
        )

        rowCache.current.set(key, { packageName: info.packageName, nameEl })
        return {
          ...item,
          packageName: info.packageName,
          label: info.label,
          name: nameEl,
        }
      })
      // 掉线的进程从缓存里清掉，否则长时间开着会一直涨
      for (const key of rowCache.current.keys()) {
        if (!alive.has(key)) rowCache.current.delete(key)
      }

      // 「仅显示应用」：只留能对上已安装包的进程
      if (!isEmpty(packagesRef.current) && store.process.onlyPackage) {
        const installed = new Set(packagesRef.current)
        list = list.filter((item: any) => {
          if (item.packageName) return true

          const matched = item.name.match(PKG_RE)
          return matched ? installed.has(matched[0]) : false
        })
      }

      setProcesses(list)
    }),
    // 换设备必须重建闭包：deps 为空会一直轮询旧设备
    [device?.id, device?.type]
  )

  // 面板保活时切设备也要重启轮询：deps 只写 [] 会一直拉第一台
  useEffect(() => {
    let destroyed = false
    let timer: ReturnType<typeof setTimeout>

    async function refresh() {
      try {
        // 不在进程页或窗口隐藏时没必要每 5 秒拉 260 个进程
        if (store.panel === 'process' && !document.hidden) {
          await getProcesses()
        }
      } catch {
        // 设备掉线/重启 adb 时会 reject：不抓住的话下面的 setTimeout
        // 永远不会执行，列表就永久冻住
      }

      if (!destroyed) {
        timer = setTimeout(refresh, document.hidden ? 15000 : 5000)
      }
    }
    refresh()

    return () => {
      destroyed = true
      clearTimeout(timer)
    }
  }, [getProcesses])

  useWindowResize(() => dataGridRef.current?.fit())

  async function stop() {
    if (!selected || !has(selected, 'packageName')) return

    const confirmed = await LunaModal.confirm(
      t('stopPackageConfirm', { name: selected.label })
    )
    if (!confirmed) return

    await main.stopPackage(device!.id, selected.packageName)
    await getProcesses()
  }

  return (
    <Page>
      <PageToolbar>
        <ToolInput
          value={filter}
          placeholder={t('filter')}
          onChange={setFilter}
          width={180}
        />
        <ToolCheckbox
          checked={store.process.onlyPackage}
          label={t('onlyPackage')}
          onChange={(value) => {
            store.process.set('onlyPackage', value)
            getProcesses()
          }}
        />
        <ToolSeparator />
        <ToolText>{t('totalProcess', { total: processes.length })}</ToolText>
        <ToolSpace />
        <ToolButton
          disabled={selected === null || !has(selected, 'packageName')}
          icon="icon-delete"
          title={t('stop')}
          onClick={stop}
        />
      </PageToolbar>
      <PageBody>
        <LunaDataGrid
          onSelect={(node) => setSelected((node as any).data)}
          onDeselect={() => setSelected(null)}
          filter={filter}
          className={Style.deviceProcessTable}
          data={processes}
          columns={columns}
          selectable={true}
          uniqueId="pid"
          onCreate={(dataGrid) => {
            dataGridRef.current = dataGrid
            dataGrid.fit()
          }}
        />
      </PageBody>
    </Page>
  )
})
