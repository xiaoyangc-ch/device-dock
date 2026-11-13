import { observer } from 'mobx-react-lite'
import LunaDataGrid from 'luna-data-grid/react'
import DataGrid from 'luna-data-grid'
import { t } from '../../../common/i18n'
import store from '../store'
import Style from './ProcessManager.module.scss'
import { useRef } from 'react'
import { useResizeSensor } from '../../lib/hooks'
import fileSize from 'licia/fileSize'

const columns = [
  {
    id: 'name',
    title: t('processName'),
    weight: 40,
    sortable: true,
  },
  {
    id: 'type',
    title: t('type'),
    weight: 15,
    sortable: true,
  },
  {
    id: 'memory',
    title: t('memory'),
    // 显示是 "123 MB" 字符串，排序必须按字节比，否则 9MB 会排在 100MB 后面
    comparator: (a: string, b: string) => fileSize(a) - fileSize(b),
    weight: 15,
    sortable: true,
  },
  {
    id: 'cpu',
    title: '% CPU',
    weight: 15,
    sortable: true,
  },
  {
    id: 'pid',
    title: 'PID',
    weight: 15,
    sortable: true,
  },
]

export default observer(function ProcessManager() {
  const dataGridRef = useRef<DataGrid>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useResizeSensor(containerRef, () => dataGridRef.current?.fit())

  const rows = store.processes.map((process) => ({
    name: process.name,
    pid: process.pid,
    // 主进程报的是 KB
    memory: fileSize(process.memory * 1024),
    cpu: process.cpu.toFixed(1),
    type: process.type,
    webContentsId: process.webContentsId,
  }))

  return (
    <div className={Style.processTableWrap} ref={containerRef}>
      <LunaDataGrid
        className={Style.processTable}
        onSelect={(node) => store.select((node as any).data)}
        onDeselect={() => store.select(null)}
        filter={store.filter}
        columns={columns}
        selectable={true}
        data={rows}
        uniqueId="pid"
        onCreate={(dataGrid) => {
          dataGridRef.current = dataGrid
          dataGrid.fit()
        }}
      />
    </div>
  )
})
