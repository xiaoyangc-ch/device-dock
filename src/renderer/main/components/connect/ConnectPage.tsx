/**
 * 设备连接页：USB/局域网连接、端口扫描、局域网发现、配对码、断开。
 *
 * 只保留 USB 与局域网 ADB，不依赖任何远程平台。
 */
import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import LunaDataGrid from 'luna-data-grid/react'
import DataGrid from 'luna-data-grid'
import { useResizeSensor } from 'share/renderer/lib/hooks'
import toNum from 'licia/toNum'
import isStrBlank from 'licia/isStrBlank'
import isEmpty from 'licia/isEmpty'
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

// 端口扫描进度由主进程按 150ms 节流推送：模块级只订阅一次，
// 页面卸载后 sink 置空，不会往已卸载组件 setState
let progressSink: ((text: string) => void) | null = null
let lanSink: ((text: string) => void) | null = null
let subscribed = false

function subscribeProgress() {
  if (subscribed) return
  subscribed = true

  main.on(
    'portScanProgress',
    (payload: { phase: string; done: number; total: number }) => {
      if (!progressSink) return

      const percent = payload.total
        ? Math.min(100, Math.round((payload.done / payload.total) * 100))
        : 0

      const label =
        payload.phase === 'deep'
          ? t('connectPortAll')
          : payload.phase === 'adb'
            ? t('connectPortAdb')
            : t('connectPortCommon')

      progressSink(`${label} ${percent}%`)
    }
  )

  main.on(
    'lanScanProgress',
    (payload: { phase: 'probe' | 'connect'; done: number; total: number }) => {
      if (!lanSink) return
      lanSink(
        `${payload.phase === 'connect' ? t('connect') : t('connectLan')} ${payload.done}/${payload.total}`
      )
    }
  )
}

/** ip:port 断开连接；USB 只传串号。 */
async function disconnect(deviceId: string) {
  const [host, port] = deviceId.split(':')
  try {
    if (port) {
      await main.disconnectDevice(host, toNum(port))
    } else {
      await main.disconnectDevice(host)
    }
  } catch (e: any) {
    notify(t('commonErr') + '：' + (e?.message || e), { icon: 'error' })
  }
}

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

export default observer(function ConnectPage() {
  const [ip, setIp] = useState('')
  const [port, setPort] = useState('')
  const [filter, setFilter] = useState('')
  // 列表选中行只决定工具栏操作对象：单击不直接切当前设备（多设备运维很容易误切）
  const [selectedId, setSelectedId] = useState('')
  const [scanning, setScanning] = useState(false)
  const [portScanning, setPortScanning] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [progress, setProgress] = useState('')
  const [lanProgress, setLanProgress] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<DataGrid | null>(null)

  useEffect(() => {
    subscribeProgress()
    progressSink = setProgress
    lanSink = setLanProgress
    return () => {
      progressSink = null
      lanSink = null
    }
  }, [])

  useResizeSensor(wrapRef, () => gridRef.current?.fit())

  async function connect() {
    // 扫描中再点一次 = 中断
    if (portScanning) {
      main.cancelPortScan()
      return
    }

    let host = ip.trim()
    let targetPort = port.trim()

    // 兼容把 ip:port 整串粘进 IP 框
    const matched = host.match(/^(.+?):(\d+)$/)
    if (matched) {
      host = matched[1]
      if (!targetPort) targetPort = matched[2]
    }
    if (!host) return

    if (targetPort) {
      setConnecting(true)
      try {
        await main.connectDevice(host, toNum(targetPort))
        main.sendToWindow('main', 'refreshDevices')
        notify(t('connectConnected', { target: `${host}:${targetPort}` }), {
          icon: 'success',
        })
      } catch (e: any) {
        notify(t('connectErr') + '：' + (e?.message || e), { icon: 'error' })
      } finally {
        setConnecting(false)
      }
      return
    }

    // 没填端口：先扫常见 ADB 端口
    setPortScanning(true)
    setProgress(t('connectPreparing'))
    try {
      const result = await main.scanDevicePorts(host)

      if (result.cancelled) {
        notify(t('connectCancelled'), { icon: 'info' })
      } else if (result.adbPorts.length) {
        const found = result.adbPorts[0]
        setPort(String(found))
        await main.connectDevice(host, found)
        main.sendToWindow('main', 'refreshDevices')

        const note = result.scanned
          ? t('connectScanned', {
              count: result.scanned,
              duration: (result.durationMs / 1000).toFixed(1),
            })
          : t('connectPortUsed')

        notify(
          t('connectConnectedNote', {
            target: `${host}:${found}`,
            note,
          }),
          { icon: 'success' }
        )
      } else if (result.openPorts.length) {
        notify(
          t('connectOpenNotAdb', {
            count: result.scanned,
            ports: result.openPorts.join(' / '),
          }),
          { icon: 'info' }
        )
      } else {
        notify(t('connectNoAdb', { count: result.scanned }), { icon: 'info' })
      }
    } catch (e: any) {
      notify(t('connectPortScanFail') + (e?.message || e), { icon: 'error' })
    } finally {
      setPortScanning(false)
      setProgress('')
    }
  }

  async function scanLan() {
    if (scanning) return

    setScanning(true)
    try {
      const result = await main.scanLanDevices()
      const connected = result.found.filter((item) => item.connected).length

      if (!result.found.length) {
        notify(t('connectNoLan', { count: result.scanned }), { icon: 'info' })
      } else {
        notify(
          t('connectFound', { count: result.found.length, online: connected }),
          { icon: 'success' }
        )
      }
      main.sendToWindow('main', 'refreshDevices')
    } catch (e: any) {
      notify(t('connectScanFail') + (e?.message || e), { icon: 'error' })
    } finally {
      setScanning(false)
      setLanProgress('')
    }
  }

  const devices = store.devices.map((device) => ({
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
          onChange={setIp}
          onKeyDown={(e) => {
            // IP 框回车直接连接
            if (e.key === 'Enter') connect()
          }}
        />
        <ToolInput
          value={port}
          width={56}
          placeholder={t('port')}
          onChange={setPort}
          onKeyDown={(e) => {
            if (e.key === 'Enter') connect()
          }}
        />
        <ToolButton
          label={
            portScanning
              ? progress || t('connectScanning')
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
          onClick={() => store.openModal('pair')}
          disabled={connecting || portScanning}
        />
        <ToolButton
          label={
            scanning ? lanProgress || t('connectScanning') : t('connectLan')
          }
          title={scanning ? lanProgress : undefined}
          onClick={scanLan}
          disabled={scanning}
        />
        <ToolSeparator />
        {/* 过滤/刷新放左侧：窗口缩到最小宽度时右侧只留设备级操作，
            过滤框不会被压成一条缝 */}
        <ToolInput
          value={filter}
          width={88}
          placeholder={t('filter')}
          onChange={setFilter}
        />
        <ToolButton
          icon="icon-refresh"
          title={t('refresh')}
          onClick={() => {
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
              notify(t('connectWirelessOn'), { icon: 'success' })
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
      <div className={Style.connectPane} ref={wrapRef}>
        <LunaDataGrid
          className={Style.connectGrid}
          columns={columns}
          data={devices}
          filter={filter}
          selectable={true}
          uniqueId="id"
          onSelect={(node) => {
            const picked: any = Array.isArray(node) ? node[0] : node
            if (picked?.data?.id) setSelectedId(picked.data.id)
          }}
          onDoubleClick={(_e, node) => {
            const picked: any = Array.isArray(node) ? node[0] : node
            if (!picked?.data?.id) return
            // 双击才切当前设备：单击只是选中，工具栏按选中行操作
            setSelectedId(picked.data.id)
            store.selectDevice(picked.data.id)
            store.selectPanel('overview')
          }}
          onCreate={(grid) => {
            gridRef.current = grid
            grid.fit()
          }}
        />
        {isEmpty(devices) && (
          <div className={Style.connectEmpty}>
            <div className={Style.connectEmptyTitle}>{t('connectEmptyTitle')}</div>
            <div className={Style.connectEmptyHint}>{t('connectEmptyHint')}</div>
          </div>
        )}
      </div>
      <CodePairModal
        visible={store.activeModal === 'pair'}
        onClose={() => store.closeModal('pair')}
      />
    </Page>
  )
})
