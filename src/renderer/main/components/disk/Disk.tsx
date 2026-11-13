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

function fmtSize(bytes: number) {
  if (!bytes) return '-'
  const tb = bytes / 1024 / 1024 / 1024 / 1024
  if (tb >= 1) return tb.toFixed(2) + ' TB'
  const gb = bytes / 1024 / 1024 / 1024
  if (gb >= 1) return gb.toFixed(1) + ' GB'
  return (bytes / 1024 / 1024).toFixed(0) + ' MB'
}

export default observer(function Disk() {
  const { device } = store
  const [rows, setRows] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState<any>(null)
  const [report, setReport] = useState(() => t('diskTip'))
  const gridRef = useRef<DataGrid>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // 连点两行时，先发的检测请求可能后返回：只认最后一次，避免选中 B 却显示 A 的报告
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
    setSel(null)
    setReport(t('diskScanning'))
    try {
      const r = await main.diskScanAll(device.id)
      if (!r.ok || !r.disks) {
        setReport(r.out || t('diskFailed'))
      } else {
        const list = r.disks
          .map((d: any) => ({
            id: d.id,
            model: d.model || (d.system ? t('diskSystemDisk') : t('diskStatusUnknown')),
            cap: fmtSize(d.capacity),
            temp: d.temp === null || d.temp === undefined ? '-' : d.temp + '°C',
            hours: d.hours ? t('diskHoursUnit', { count: d.hours }) : '-',
            cycles: d.cycles ? String(d.cycles) : '-',
            status: (
              <span
                className={
                  d.passed === true
                    ? Style.statusOk
                    : d.passed === false
                      ? Style.statusBad
                      : Style.statusUnknown
                }
              >
                {d.passed === true
                  ? t('diskStatusOk')
                  : d.passed === false
                    ? t('diskStatusBad')
                    : t('diskStatusUnknown')}
              </span>
            ),
            statusText:
              d.passed === true
                ? 'ok'
                : d.passed === false
                  ? 'bad'
                  : 'unknown',
            serial: d.serial || '-',
          }))
          .sort((a: any, b: any) =>
            String(a.id).localeCompare(String(b.id), 'en', { numeric: true })
          )
        setRows(list)
        const bad = list.filter((x: any) => x.statusText === 'bad').length
        const unknown = list.filter((x: any) => x.statusText === 'unknown').length
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
      setReport(t('diskError', { msg: e && e.message ? e.message : e }))
    }
    setBusy(false)
  }

  async function detail(row?: any) {
    const target = row || sel
    if (!device || !target) return
    const seq = ++detailSeq.current
    setBusy(true)
    setReport(t('diskGenerating', { id: target.id }))
    try {
      const r = await main.diskRun(device.id, [
        'report',
        target.id,
        '--locale',
        'zh-CN',
      ])
      if (seq !== detailSeq.current) return
      const clean = (r.out || '')
        .split('\n')
        .filter((l) => !l.startsWith('[ShineDiskToolkit]'))
        .join('\n')
        .trim()
        .replace(/KTV\s*点歌机硬盘/g, '硬盘')
      setReport(clean || t('diskNoOutput'))
    } catch (e: any) {
      if (seq !== detailSeq.current) return
      setReport(t('diskError', { msg: e && e.message ? e.message : e }))
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
          disabled={!device || busy || !sel}
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
            setSel(node.data)
            detail(node.data)
          }}
          onDeselect={() => setSel(null)}
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

const columns = [
  {
    id: 'id',
    title: t('diskColName'),
    sortable: true,
    weight: 8,
  },
  {
    id: 'model',
    title: t('diskColModel'),
    sortable: true,
    weight: 22,
  },
  {
    id: 'cap',
    title: t('diskColCapacity'),
    sortable: true,
    weight: 10,
  },
  {
    id: 'temp',
    title: t('diskColTemp'),
    sortable: true,
    weight: 8,
  },
  {
    id: 'hours',
    title: t('diskColHours'),
    sortable: true,
    weight: 12,
  },
  {
    id: 'cycles',
    title: t('diskColCycles'),
    sortable: true,
    weight: 10,
  },
  {
    id: 'status',
    title: t('diskColStatus'),
    sortable: true,
    weight: 8,
    comparator: (a: any, b: any) =>
      String(a?.textContent || '').localeCompare(String(b?.textContent || '')),
  },
  {
    id: 'serial',
    title: t('diskColSerial'),
    sortable: true,
    weight: 14,
  },
]
