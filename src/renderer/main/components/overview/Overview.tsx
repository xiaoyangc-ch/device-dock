/**
 * 概览页：存储/内存/分辨率三个指标 + 设备/系统/网络三组信息。
 * 单击行复制值，双击「字体缩放」打开调整弹窗。
 */
import { observer } from 'mobx-react-lite'
import Style from './Overview.module.scss'
import { JSX, useEffect, useRef, useState } from 'react'
import isEmpty from 'licia/isEmpty'
import fileSize from 'licia/fileSize'
import types from 'licia/types'
import { notify } from 'share/renderer/lib/util'
import { t } from 'common/util'
import store from '../../store'
import copy from 'licia/copy'
import { getOverview } from '../../lib/overview'
import { PannelLoading } from '../common/loading'
import FontAdjustModal from './FontAdjustModal'
import PortMappingModal from './PortMappingModal'
import RemoteControllerModal from './RemoteControllerModal'
import toBool from 'licia/toBool'
import PageToolbar, {
  Page,
  ToolButton,
  ToolSpace,
} from '../layout/PageToolbar'

export default observer(function Overview() {
  const [isLoading, setIsLoading] = useState(false)
  const [overview, setOverview] = useState<
    types.PlainObj<string | number | boolean>
  >({})

  // 切设备时旧请求可能后到：只认最后一次，别让上一台的数据盖住新设备
  const loadSeq = useRef(0)
  const rootRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { device } = store

  // 面板切设备时不卸载：deps 必须带设备，否则永远显示上一台的数据。
  // force 是必要的——旧设备还在加载时切过来 isLoading 仍为 true，
  // 普通 refresh 会直接 return，新设备就再也没机会加载
  useEffect(() => {
    setOverview({})
    refresh(true)
    return () => {
      if (rootRefreshTimer.current) clearTimeout(rootRefreshTimer.current)
      rootRefreshTimer.current = null
    }
  }, [device?.id, device?.type])

  async function refresh(force = false, noCache = false) {
    if (!device || (isLoading && !force)) return

    const seq = ++loadSeq.current
    try {
      setIsLoading(true)
      const data = await getOverview(device.id, noCache)
      if (seq !== loadSeq.current) return
      setOverview(data)
    } catch {
      if (seq === loadSeq.current) notify(t('commonErr'), { icon: 'error' })
    }

    if (seq === loadSeq.current) setIsLoading(false)
  }

  async function root() {
    if (!device || overview.root) return
    try {
      await main.root(device.id)
      // adbd 重启要 1-2 秒：等它回来再刷新，否则读到旧状态
      rootRefreshTimer.current = setTimeout(() => {
        rootRefreshTimer.current = null
        refresh()
      }, 2000)
    } catch {
      notify(t('rootModeErr'), { icon: 'error' })
    }
  }

  async function restartAdbServer() {
    await main.restartAdbServer()
    notify(t('adbServerRestarted'), { icon: 'success' })
  }

  function metric(
    label: string,
    value: string,
    foot: string,
    percent?: number
  ) {
    return (
      <div className={Style.metric}>
        <div className={Style.metricHead}>{label}</div>
        <div className={Style.metricValue} title={value}>
          {value}
        </div>
        <div
          className={
            percent === undefined ? Style.bar + ' ' + Style.barGhost : Style.bar
          }
        >
          <span style={{ width: `${percent || 0}%` }} />
        </div>
        <div className={Style.metricFoot} title={foot}>
          {foot}
        </div>
      </div>
    )
  }

  function infoRow(
    label: string,
    value: string | number | boolean | undefined,
    onDoubleClick?: () => void
  ) {
    let handled = false
    const text =
      value === undefined || value === '' ? t('unknown') : String(value)

    return (
      <div
        className={Style.row}
        onClick={() => {
          // 等 200ms 看是不是双击：单击才复制，避免双击也闪一次「已复制」
          setTimeout(() => {
            if (handled) return
            copy(text)
            notify(t('copied'), { icon: 'info' })
          }, 200)
        }}
        onDoubleClick={() => {
          if (!onDoubleClick) return
          handled = true
          onDoubleClick()
        }}
      >
        <span className={Style.k}>{label}</span>
        <span className={Style.v} title={text}>
          {text}
        </span>
      </div>
    )
  }

  let content: JSX.Element | null = null

  if (!device) {
    content = <div className={Style.empty}>{t('deviceNotConnected')}</div>
  } else if (isLoading) {
    content = <PannelLoading />
  } else if (!isEmpty(overview)) {
    const storageUsed = Number(overview.storageUsed || 0)
    const storageTotal = Number(overview.storageTotal || 0)
    const memUsed = Number(overview.memUsed || 0)
    const memTotal = Number(overview.memTotal || 0)

    const storagePct = storageTotal
      ? Math.min(100, Math.round((storageUsed / storageTotal) * 100))
      : 0
    const memPct = memTotal
      ? Math.min(100, Math.round((memUsed / memTotal) * 100))
      : 0

    content = (
      <div className={Style.page}>
        <div className={Style.metrics}>
          {metric(
            t('storage'),
            `${fileSize(storageUsed)} / ${fileSize(storageTotal)}`,
            t('used', { percent: storagePct }),
            storagePct
          )}
          {metric(
            t('memory'),
            `${fileSize(memUsed)} / ${fileSize(memTotal)}`,
            t('used', { percent: memPct }),
            memPct
          )}
          {metric(
            t('resolution'),
            String(overview.resolution || '--'),
            t('physical', {
              size: overview.physicalResolution || '--',
              dpi: overview.physicalDensity || '--',
            })
          )}
        </div>

        <div className={Style.sheet}>
          <section className={Style.section}>
            <div className={Style.sectionTitle}>{t('groupDevice')}</div>
            <div className={Style.rows}>
              {infoRow(t('name'), overview.name)}
              {infoRow(t('brand'), overview.brand)}
              {infoRow(t('model'), overview.model)}
              {infoRow(t('serialno'), overview.serialno)}
            </div>
          </section>

          <section className={Style.section}>
            <div className={Style.sectionTitle}>{t('groupSystem')}</div>
            <div className={Style.rows}>
              {infoRow(
                t('androidVersion'),
                `Android ${device.androidVersion} (API ${device.sdkVersion})`
              )}
              {infoRow(t('kernelVersion'), overview.kernelVersion)}
              {infoRow(
                t('processor'),
                `${overview.processor || t('unknown')} · ${t('cpuNum', {
                  count: overview.cpuNum,
                })} · ${overview.abi}`
              )}
              {infoRow(
                'Root',
                toBool(overview.root) ? t('rooted') : t('notRooted')
              )}
            </div>
          </section>

          <section className={Style.section}>
            <div className={Style.sectionTitle}>{t('networkDisplay')}</div>
            <div className={Style.rows}>
              {infoRow(t('network'), overview.wifi)}
              {infoRow(t('ipAddress'), overview.ip)}
              {infoRow(t('macAddress'), overview.mac)}
              {infoRow(
                t('fontScale'),
                overview.fontScale ? `${overview.fontScale}x` : '1x',
                overview.fontScale
                  ? () => store.openModal('fontAdjust')
                  : undefined
              )}
            </div>
          </section>
        </div>

        <FontAdjustModal
          visible={store.activeModal === 'fontAdjust'}
          initialScale={overview.fontScale as number}
          onClose={() => {
            store.closeModal('fontAdjust')
            refresh()
          }}
        />
      </div>
    )
  }

  return (
    <Page>
      <PageToolbar>
        <ToolButton
          icon="icon-terminal"
          title={t('adbCli')}
          onClick={() => main.openAdbCli()}
        />
        <ToolButton
          icon="icon-reset"
          title={t('restartAdbServer')}
          onClick={restartAdbServer}
        />
        <ToolButton
          icon="icon-unlock"
          disabled={!device || toBool(overview.root)}
          active={toBool(overview.root)}
          title={t('rootMode')}
          onClick={root}
        />
        <ToolButton
          icon="icon-bidirection"
          disabled={!device}
          title={t('portMapping')}
          onClick={() => store.openModal('portMapping')}
        />
        <ToolButton
          icon="icon-remote-controller"
          disabled={!device}
          title={t('remoteController')}
          onClick={() => store.openModal('remoteController')}
        />
        <ToolSpace />
        <ToolButton
          icon="icon-refresh"
          title={t('refresh')}
          disabled={isLoading || !device}
          onClick={() => refresh(true, true)}
        />
      </PageToolbar>
      {content}
      <PortMappingModal
        visible={store.activeModal === 'portMapping'}
        onClose={() => store.closeModal('portMapping')}
      />
      <RemoteControllerModal
        visible={store.activeModal === 'remoteController'}
        onClose={() => store.closeModal('remoteController')}
      />
    </Page>
  )
})
