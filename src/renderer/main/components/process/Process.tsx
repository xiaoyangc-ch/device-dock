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
import map from 'licia/map'
import { fallbackIcon } from '../../lib/appIcon'
import contain from 'licia/contain'
import find from 'licia/find'
import DataGrid from 'luna-data-grid'
import { useWindowResize } from 'share/renderer/lib/hooks'

const PKG_RE = /^[\w.]+/

export default observer(function Process() {
  const [processes, setProcesses] = useState<any[]>([])
  const packagesRef = useRef<string[]>([])
  const packageInfosRef = useRef<any[]>([])
  const dataGridRef = useRef<DataGrid>(null)
  const [selected, setSelected] = useState<any>(null)
  const [filter, setFilter] = useState('')

  const { device } = store

  const getPackageInfos = useCallback(
    singleton(async function () {
      if (!device) {
        return
      }
      try {
        packagesRef.current = await main.getPackages(device.id)
        packageInfosRef.current = await main.getPackageInfos(
          device.id,
          packagesRef.current
        )
      } catch {
        // 设备掉线时不要变成未处理拒绝（轮询循环里没人接这个 promise）
      }
    }),
    [device?.id, device?.type]
  )

  const getProcesses = useCallback(
    singleton(async function () {
      if (device) {
        if (isEmpty(packageInfosRef.current)) {
          // 首次进页面必须等包名/图标就绪，否则第一屏全是 cmdline 原始名
          await getPackageInfos()
        }
        const allProcesses = await main.getProcesses(device.id)
        let processes = map(allProcesses, (process: any) => {
          // 正则只在每个进程上跑一次：原来放在 find 回调里，
          // 266 进程 × 700 包 = 每次刷新十几万次正则
          const match = process.name.match(PKG_RE)
          const pkgName = match ? match[0] : ''
          const info = pkgName
            ? find(packageInfosRef.current, (info) => info.packageName === pkgName)
            : undefined

          if (info) {
            const icon = info.icon || fallbackIcon(info.label, info.packageName)
            // 进程名/应用名来自设备，直接拼 HTML 会被注入
            const nameEl = document.createElement('span')
            const img = document.createElement('img')
            img.src = icon
            nameEl.append(
              img,
              document.createTextNode(
                process.name.replace(info.packageName, info.label)
              )
            )
            return {
              ...process,
              packageName: info.packageName,
              label: info.label,
              name: nameEl,
            }
          } else {
            return process
          }
        })
        if (!isEmpty(packagesRef.current) && store.process.onlyPackage) {
          processes = processes.filter((process) => {
            if (process.packageName) {
              return true
            }

            // 这里的 pkgName 不在 map 作用域内，重新匹一次（每进程一次，成本可忽略）
            const match = process.name.match(PKG_RE)
            return match ? contain(packagesRef.current, match[0]) : false
          })
        }
        setProcesses(processes)
      }
    }),
    // 换设备必须重建轮询闭包：deps 为空时一直轮询旧设备
    [device?.id, device?.type]
  )

  // 面板保活时切设备也必须重启轮询：deps 只写 [] 会一直拉第一台设备。
  useEffect(() => {
    let destroyed = false
    let timer: ReturnType<typeof setTimeout>

    async function refresh() {
      try {
        // 窗口不可见时没必要每 5 秒拉 260 个进程；恢复到可见后立即刷新一次
        if (store.panel === 'process' && !document.hidden) {
          await getProcesses()
        }
      } catch {
        // 设备掉线/重启 adb 时 getProcesses 会 reject：
        // 不抓住的话下面的 setTimeout 永远不会执行，进程列表就永久冻住
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
    if (!selected || !has(selected, 'packageName')) {
      return
    }
    const result = await LunaModal.confirm(
      t('stopPackageConfirm', { name: selected.label })
    )
    if (result) {
      await main.stopPackage(device!.id, selected.packageName)
      await getProcesses()
    }
  }

  return (
    <Page>
      <PageToolbar>
        <ToolInput
          value={filter}
          placeholder={t('filter')}
          onChange={(val) => setFilter(val)}
          width={180}
        />
        <ToolCheckbox
          checked={store.process.onlyPackage}
          label={t('onlyPackage')}
          onChange={(val) => {
            store.process.set('onlyPackage', val)
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
          className={Style.processes}
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

const columns = [
  {
    id: 'name',
    title: t('processName'),
    sortable: true,
    weight: 30,
  },
  {
    id: '%cpu',
    title: '% CPU',
    sortable: true,
    weight: 10,
  },
  {
    id: 'time+',
    title: t('cpuTime'),
    sortable: true,
    weight: 10,
  },
  {
    id: 'res',
    title: t('memory'),
    sortable: true,
    comparator: (a: string, b: string) => fileSize(a) - fileSize(b),
    weight: 10,
  },
  {
    id: 'pid',
    title: 'PID',
    sortable: true,
    weight: 10,
  },
  {
    id: 'user',
    title: t('user'),
    sortable: true,
    weight: 10,
  },
]
