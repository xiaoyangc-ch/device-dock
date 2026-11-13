/**
 * 硬盘检测：DiskToolkit CLI 扫全部磁盘的 SMART，选中某块盘再生成详细报告。
 */
import { observer } from 'mobx-react-lite'
import LunaDataGrid from 'luna-data-grid/react'
import DataGrid from 'luna-data-grid'
import { useRef, useState } from 'react'
import { useResizeSensor } from 'share/renderer/lib/hooks'
import store from '../../store'
import { t } from 'common/util'
import Style from './Disk.module.scss'
import PageToolbar, {
  Page,
  ToolButton,
  ToolSpace,
  ToolText,
} from '../layout/PageToolbar'

const CLI_TAG = '[ShineDiskToolkit]'

function fmtSize(bytes: number) {
  if (!bytes) return '-'

  const tb = bytes / 1024 / 1024 / 1024 / 1024
  if (tb >= 1) return tb.toFixed(2) + ' TB'

  const gb = bytes / 1024 / 1024 / 1024
  if (gb >= 1) return gb.toFixed(1) + ' GB'

  return (bytes / 1024 / 1024).toFixed(0) + ' MB'
}

function statusText(passed: boolean | null) {
  return passed === true ? 'ok' : passed === false ? 'bad' : 'unknown'
}

const columns = [
  { id: 'id', title: t('diskColName'), sortable: true, weight: 8 },
  { id: 'model', title: t('diskColModel'), sortable: true, weight: 22 },
  { id: 'cap', title: t('diskColCapacity'), sortable: true, weight: 10 },
  { id: 'temp', title: t('diskColTemp'), sortable: true, weight: 8 },
  { id: 'hours', title: t('diskColHours'), sortable: true, weight: 12 },
  { id: 'cycles', title: t('diskColCycles'), sortable: true, weight: 10 },
  {
    id: 'status',
    title: t('diskColStatus'),
    sortable: true,
    weight: 8,
    comparator: (a: any, b: any) =>
      String(a?.textContent || '').localeCompare(String(b?.textContent || '')),
  },
  { id: 'serial', title: t('diskColSerial'), sortable: true, weight: 14 },
]

export default observer(function Disk() {
  const { device } = store
  const [rows, setRows] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<any>(null)
  const [report, setReport] = useState(() => t('diskTip'))

  const gridRef = useRef<DataGrid>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // 连点两行时先发的请求可能后到：只认最后一次，避免选中 B 显示 A 的报告
  const detailSeq = useRef(0)

  useResizeSensor(containerRef, () => {
    gridRef.current?.fit()
  })

  async function scanAll() {
    if (!device) {
      setReport(t('diskNoDevice'))
      return
    }

    setBusy(true)
    setRows([])
    setSelected(null)
    setReport(t('diskScanning'))

    try {
      const result = await main.diskScanAll(device.id)
      if (!result.ok || !result.disks) {
        setReport(result.out || t('diskFailed'))
      } else {
        const list = result.disks
          .map((d: any) => ({
            id: d.id,
            model:
              d.model || (d.system ? t('diskSystemDisk') : t('diskStatusUnknown')),
            cap: fmtSize(d.capacity),
            temp:
              d.temp === null || d.temp === undefined ? '-' : d.temp + '°C',
            hours: d.hours ? t('diskHoursUnit', { count: d.hours }) : '-',
            cycles: d.cycles ? String(d.cycles) : '-',
            // luna-data-grid 只对真实 DOM 节点 appendChild，React 元素会被
            // String() 成 "[object Object]"；这里直接给 DOM 节点，
            // 同时排序也能用到 span 的 innerText
            status: (() => {
              const el = document.createElement('span')
              el.className =
                d.passed === true
                  ? Style.statusOk
                  : d.passed === false
                    ? Style.statusBad
                    : Style.statusUnknown
              el.textContent =
                d.passed === true
                  ? t('diskStatusOk')
                  : d.passed === false
                    ? t('diskStatusBad')
                    : t('diskStatusUnknown')
              return el
            })(),
            serial: d.serial || '-',
            // 状态列是 JSX，排序要按纯文本
            statusText: statusText(d.passed),
          }))
          .sort((a: any, b: any) =>
            String(a.id).localeCompare(String(b.id), 'en', { numeric: true })
          )

        setRows(list)

        const bad = list.filter((item: any) => item.statusText === 'bad').length
        const unknown = list.filter(
          (item: any) => item.statusText === 'unknown'
        ).length

        setReport(
          t('diskDone', {
            total: list.length,
            ok: list.length - bad - unknown,
          }) +
            (bad ? t('diskBad', { count: bad }) : '') +
            (unknown ? t('diskUnknown', { count: unknown }) : '') +
            t('diskSelectHint')
        )
        gridRef.current?.fit()
      }
    } catch (e: any) {
      setReport(t('diskError', { msg: e?.message || e }))
    }

    setBusy(false)
  }

  async function detail(row?: any) {
    const target = row || selected
    if (!device || !target) return

    const seq = ++detailSeq.current
    setBusy(true)
    setReport(t('diskGenerating', { id: target.id }))

    try {
      const result = await main.diskRun(device.id, [
        'report',
        target.id,
        '--locale',
        'zh-CN',
      ])
      if (seq !== detailSeq.current) return

      // CLI 会在输出里打自己的日志行，报告里去掉
      const clean = (result.out || '')
        .split('\n')
        .filter((line) => !line.startsWith(CLI_TAG))
        .join('\n')
        .trim()
        // 门店机型的品牌前缀对用户没意义
        .replace(/KTV\s*点歌机硬盘/g, '硬盘')

      setReport(clean || t('diskNoOutput'))
    } catch (e: any) {
      if (seq !== detailSeq.current) return
      setReport(t('diskError', { msg: e?.message || e }))
    }

    if (seq === detailSeq.current) setBusy(false)
  }

  return (
    <Page>
      <PageToolbar>
        <ToolButton
          label={t('diskStart')}
          primary
          onClick={scanAll}
          disabled={!device || busy}
        />
        <ToolButton
          icon="icon-editor"
          title={t('diskRegenerate')}
          disabled={!device || busy || !selected}
          onClick={() => detail()}
        />
        <ToolSpace />
        <ToolText>
          {busy
            ? t('diskDetecting')
            : rows.length
              ? t('diskTotal', { count: rows.length })
              : ''}
        </ToolText>
      </PageToolbar>
      <div className={Style.diskBody} ref={containerRef}>
        <LunaDataGrid
          onSelect={(node: any) => {
            setSelected(node.data)
            detail(node.data)
          }}
          onDeselect={() => setSelected(null)}
          className={Style.grid}
          data={rows}
          columns={columns}
          selectable={true}
          uniqueId="id"
          onCreate={(dataGrid) => {
            gridRef.current = dataGrid
            dataGrid.fit()
          }}
        />
        {!rows.length && (
          <div className={Style.empty}>
            <span className="icon-storage" />
            <div className={Style.emptyTitle}>
              {busy ? t('diskDetectingDisks') : t('diskEmptyTitle')}
            </div>
            <div className={Style.emptyHint}>
              {busy ? t('diskScanHint') : t('diskEmptyHint')}
            </div>
          </div>
        )}
        <div className={Style.reportWrap}>
          <div className={Style.reportHead}>{t('diskReport')}</div>
          <pre className={Style.report}>{report}</pre>
        </div>
      </div>
    </Page>
  )
})
