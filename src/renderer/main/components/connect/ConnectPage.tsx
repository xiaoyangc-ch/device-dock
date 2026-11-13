import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import LunaDataGrid from 'luna-data-grid/react'
import DataGrid from 'luna-data-grid'
import { useResizeSensor } from 'share/renderer/lib/hooks'
import toNum from 'licia/toNum'
import isStrBlank from 'licia/isStrBlank'
import isEmpty from 'licia/isEmpty'
import map from 'licia/map'
import { notify } from 'share/renderer/lib/util'
import { t } from 'common/util'
import CodePairModal from './CodePairModal'
import Style from './ConnectPage.module.scss'
import store from '../../store'
import { isRemoteDevice } from '../../lib/util'
import PageToolbar, {
  Page,
  ToolButton,
  ToolInput,
  ToolSeparator,
  ToolSpace,
} from '../layout/PageToolbar'

// 端口扫描进度是主进程按 150ms 节流推送的：模块级只订阅一次
let progressSink: ((text: string) => void) | null = null
let subscribed = false
function subscribeProgress() {
  if (subscribed) return
  subscribed = true
  main.on(
    'portScanProgress',
    (p: { phase: string; done: number; total: number }) => {
      if (!progressSink) return
      const percent = p.total
        ? Math.min(100, Math.round((p.done / p.total) * 100))
        : 0
      const label =
        p.phase === 'deep'
          ? t('connectPortAll')
          : p.phase === 'adb'
            ? t('connectPortAdb')
            : t('connectPortCommon')
      progressSink(`${label} ${percent}%`)
    }
  )
}

async function disconnect(deviceId: string) {
  const [host, port] = deviceId.split(':')
  try {
    if (port) {
      await main.disconnectDevice(host, toNum(port))
    } else {
      await main.disconnectDevice(host)
    }
  } catch (e: any) {
    notify(t('commonErr') + '：' + (e && e.message ? e.message : e), {
      icon: 'error',
    })
  }
}

export default observer(function ConnectPage() {
  const [ip, setIp] = useState('')
  const [port, setPort] = useState('')
  const [filter, setFilter] = useState('')
  // 列表选中行只影响工具栏操作对象：单击不再直接切当前设备（多设备运维很容易误切）
  const [selectedId, setSelectedId] = useState('')
  const [scanning, setScanning] = useState(false)
  const [portScanning, setPortScanning] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [progress, setProgress] = useState('')
  const [pairVisible, setPairVisible] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<DataGrid | null>(null)

  useEffect(() => {
    subscribeProgress()
    progressSink = setProgress
    return () => {
      progressSink = null
    }
  }, [])

  useResizeSensor(wrapRef, () => gridRef.current?.fit())

  async function connect() {
    if (portScanning) {
      // 扫描中再点一次 = 中断
      main.cancelPortScan()
      return
    }

    let host = ip.trim()
    let p = port.trim()
    // 兼容把 ip:port 整串粘进 IP 框
    const matched = host.match(/^(.+?):(\d+)$/)
    if (matched) {
      host = matched[1]
      if (!p) p = matched[2]
    }
    if (!host) return

    if (p) {
      setConnecting(true)
      try {
        await main.connectDevice(host, toNum(p))
        main.sendToWindow('main', 'refreshDevices')
        notify(t('connectConnected', { target: `${host}:${p}` }), {
          icon: 'success',
        })
      } catch (e: any) {
        notify(t('connectErr') + '：' + (e && e.message ? e.message : e), {
          icon: 'error',
        })
      } finally {
        setConnecting(false)
      }
      return
    }

    setPortScanning(true)
    setProgress(t('connectPreparing'))
    try {
      const r = await main.scanDevicePorts(host)
      if (r.cancelled) {
        notify(t('connectCancelled'), { icon: 'info' })
      } else if (r.adbPorts.length) {
        const found = r.adbPorts[0]
        setPort(String(found))
        await main.connectDevice(host, found)
        main.sendToWindow('main', 'refreshDevices')
        const note = r.scanned
          ? t('connectScanned', {
              count: r.scanned,
              duration: (r.durationMs / 1000).toFixed(1),
            })
          : t('connectPortUsed')
        notify(
          t('connectConnectedNote', {
            target: `${host}:${found}`,
            note,
          }),
          { icon: 'success' }
        )
      } else if (r.openPorts.length) {
        notify(
          t('connectOpenNotAdb', {
            count: r.scanned,
            ports: r.openPorts.join(' / '),
          }),
          { icon: 'info' }
        )
      } else {
        notify(t('connectNoAdb', { count: r.scanned }), { icon: 'info' })
      }
    } catch (e: any) {
      notify(t('connectPortScanFail') + (e && e.message ? e.message : e), {
        icon: 'error',
      })
    } finally {
      setPortScanning(false)
      setProgress('')
    }
  }

  async function scanLan() {
    if (scanning) return
    setScanning(true)
    try {
      const r = await main.scanLanDevices()
      const connected = r.found.filter((f) => f.connected).length
      if (!r.found.length) {
        notify(t('connectNoLan', { count: r.scanned }), { icon: 'info' })
      } else {
        notify(
          t('connectFound', { count: r.found.length, online: connected }),
          { icon: 'success' }
        )
      }
      main.sendToWindow('main', 'refreshDevices')
    } catch (e: any) {
      notify(t('connectScanFail') + (e && e.message ? e.message : e), {
        icon: 'error',
      })
    } finally {
      setScanning(false)
    }
  }

  const devices = map(store.devices, (device) => ({
    id: device.id,
    serialno: device.serialno || '--',
    name: device.name,
    androidVersion: device.androidVersion
      ? `Android ${device.androidVersion} (API ${device.sdkVersion})`
      : '--',
    status:
      device.type === 'offline' ? t('connectOffline') : t('connectOnline'),
  }))

  const selected =
    store.devices.find((item) => item.id === selectedId) || store.device
  const remote = selected ? isRemoteDevice(selected.id) : false
  const offline = selected ? selected.type === 'offline' : true
  const connectDisabled = (isStrBlank(ip) && !portScanning) || connecting

  return (
    <Page>
      <PageToolbar>
        <ToolInput
          value={ip}
          width={120}
          placeholder={t('ipAddress')}
          onChange={(val) => setIp(val)}
          onKeyDown={(e) => {
            // IP 框回车直接连接：工具栏输入完还要去点按钮很别扭
            if (e.key === 'Enter') connect()
          }}
        />
        <ToolInput
          value={port}
          width={56}
          placeholder={t('port')}
          onChange={(val) => setPort(val)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') connect()
          }}
        />
        <ToolButton
          label={
            portScanning
              ? t('connectScanning')
              : connecting
                ? t('connectingPreview')
                : t('connect')
          }
          title={portScanning ? progress : undefined}
          primary
          onClick={connect}
          disabled={connectDisabled}
        />
        <ToolSeparator />
        <ToolButton
          label={t('pair')}
          onClick={() => setPairVisible(true)}
          disabled={connecting || portScanning}
        />
        <ToolButton
          label={scanning ? t('connectScanning') : t('connectLan')}
          onClick={scanLan}
          disabled={scanning}
        />
        <ToolSeparator />
        {/* 过滤/刷新放在左侧组：窗口缩到最小宽度时右侧只留设备级操作，
            不会把过滤框压成一条缝 */}
        <ToolInput
          value={filter}
          width={88}
          placeholder={t('filter')}
          onChange={(val) => setFilter(val)}
        />
        <ToolButton
          icon="icon-refresh"
          title={t('refresh')}
          onClick={async () => {
            main.sendToWindow('main', 'refreshDevices')
            notify(t('deviceRefreshed'), { icon: 'success' })
          }}
        />
        <ToolSpace />
        <ToolButton
          icon="icon-wifi"
          title={t('wirelessMode')}
          disabled={!selected || remote || offline}
          onClick={async () => {
            if (!selected) return
            try {
              await main.startWireless(selected.id)
              notify(t('connectWirelessOn'), {
                icon: 'success',
              })
            } catch {
              notify(t('commonErr'), { icon: 'error' })
            }
          }}
        />
        <ToolButton
          icon="icon-disconnect"
          title={t('disconnect')}
          disabled={!selected || !remote || offline}
          onClick={() => selected && disconnect(selected.id)}
        />
      </PageToolbar>
      <div className={Style.body} ref={wrapRef}>
        <LunaDataGrid
          className={Style.grid}
          columns={columns}
          data={devices}
          filter={filter}
          selectable={true}
          uniqueId="id"
          onSelect={(node) => {
            const n: any = Array.isArray(node) ? node[0] : node
            if (n && n.data && n.data.id) setSelectedId(n.data.id)
          }}
          onDoubleClick={(_e, node) => {
            const n: any = Array.isArray(node) ? node[0] : node
            if (n && n.data && n.data.id) {
              // 双击才真正切当前设备：单击只是选中，工具栏按选中行操作
              setSelectedId(n.data.id)
              store.selectDevice(n.data.id)
              store.selectPanel('overview')
            }
          }}
          onCreate={(grid) => {
            gridRef.current = grid
            grid.fit()
          }}
        />
        {isEmpty(devices) && (
          <div className={Style.empty}>
            <div className={Style.emptyTitle}>{t('connectEmptyTitle')}</div>
            <div className={Style.emptyHint}>{t('connectEmptyHint')}</div>
          </div>
        )}
      </div>
      <CodePairModal
        visible={pairVisible}
        onClose={() => setPairVisible(false)}
      />
    </Page>
  )
})

const columns = [
  { id: 'id', title: 'ID', weight: 22, sortable: true },
  { id: 'serialno', title: t('serialno'), weight: 16, sortable: true },
  { id: 'name', title: t('name'), weight: 24, sortable: true },
  {
    id: 'androidVersion',
    title: t('androidVersion'),
    weight: 24,
    sortable: true,
  },
  { id: 'status', title: t('status'), weight: 10, sortable: true },
]
