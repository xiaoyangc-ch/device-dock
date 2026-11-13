import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import { t } from 'common/util'
import store from '../../store'
import { getOverview } from '../../lib/overview'
import Style from './DeviceStage.module.scss'
import useLatency from './useLatency'

const START_CODE = new Uint8Array([0, 0, 0, 1])

function concatBytes(parts: Uint8Array[]) {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export default observer(function DeviceStage() {
  const { device } = store
  const [url, setUrl] = useState('')
  const [streamReady, setStreamReady] = useState(false)
  const [preview, setPreview] = useState<'idle' | 'loading' | 'error' | 'offline'>(
    'idle'
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [resolution, setResolution] = useState('')
  const urlRef = useRef('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // 离线设备不探测延迟：只会每 3 秒失败一次，侧栏显示 -- 即可
  const ms = useLatency(
    device && device.type !== 'offline' ? device.id : ''
  )

  useEffect(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = ''
    }
    setUrl('')
    setStreamReady(false)
    setResolution('')
    const canvas = canvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)

    if (!device) {
      setPreview('idle')
      return
    }
    if (device.type === 'offline') {
      setPreview('offline')
      return
    }

    let alive = true
    // ---- PNG 回退：流被设备拒绝/解码失败时继续用每秒一张截图 ----
    let pngTimer: ReturnType<typeof setTimeout>
    let pngAlive = false
    let pngRunning = false

    const tick = async () => {
      if (!alive || !pngAlive) return
      if (document.hidden) {
        pngTimer = setTimeout(tick, 10000)
        return
      }
      if (pngRunning) return
      pngRunning = true
      let nextDelay = 1000
      setPreview((p) => (p === 'error' || p === 'offline' ? 'loading' : p))
      try {
        const data = await main.screencapRaw(device.id)
        if (!alive || !pngAlive) return
        if (data) {
          const next = URL.createObjectURL(
            new Blob([data], { type: 'image/png' })
          )
          const prev = urlRef.current
          urlRef.current = next
          setUrl(next)
          // 先让 DOM 切到新地址再释放旧 Blob：同步 revoke 会让当前这张图先失效
          if (prev) setTimeout(() => URL.revokeObjectURL(prev), 1000)
        } else {
          nextDelay = 1500
        }
        setPreview('idle')
      } catch {
        if (alive && pngAlive) setPreview('error')
        nextDelay = 3000
      } finally {
        pngRunning = false
        if (alive && pngAlive) pngTimer = setTimeout(tick, nextDelay)
      }
    }

    const startPng = () => {
      if (!alive) return
      pngAlive = true
      if (pngRunning) return
      pngRunning = true
      tick()
    }
    const stopPng = () => {
      pngAlive = false
      clearTimeout(pngTimer)
      pngRunning = false
    }

    // ---- H264 流：screenrecord -> 主进程 -> WebCodecs 解码 ----
    let decoder: VideoDecoder | null = null
    let codec = ''
    let sps: Uint8Array | null = null
    let pps: Uint8Array | null = null
    let pending = new Uint8Array(0)
    let ts = 0
    let frames = 0
    let gotFrame = false
    let failed = false

    const fail = () => {
      if (!alive || failed) return
      failed = true
      try {
        decoder?.close()
      } catch {
        // ignore
      }
      decoder = null
      setStreamReady(false)
      startPng()
    }

    const onFrame = (frame: VideoFrame) => {
      const canvas = canvasRef.current
      if (canvas) {
        if (
          canvas.width !== frame.displayWidth ||
          canvas.height !== frame.displayHeight
        ) {
          canvas.width = frame.displayWidth
          canvas.height = frame.displayHeight
        }
        canvas.getContext('2d')?.drawImage(frame, 0, 0)
        canvas.dataset.frames = String(++frames)
      }
      frame.close()
      if (!gotFrame) {
        gotFrame = true
        setStreamReady(true)
        setPreview('idle')
        stopPng()
      }
    }

    const configure = () => {
      if (!sps || sps.length < 4) return
      // SPS 的 profile / constraint / level 就是 codec 字符串的三段
      const next = `avc1.${[1, 2, 3]
        .map((i) => sps![i].toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()}`
      if (decoder && next === codec) return
      try {
        decoder?.close()
        decoder = new VideoDecoder({ output: onFrame, error: fail })
        // 不传 description：H264 按 Annex B 解析，SPS/PPS 随 IDR 一起送进来
        decoder.configure({ codec: next, optimizeForLatency: true })
        codec = next
      } catch {
        fail()
      }
    }

    const onNal = (nal: Uint8Array) => {
      if (!nal.length || failed) return
      const type = nal[0] & 0x1f
      if (type === 7) {
        sps = nal.slice()
        configure()
        return
      }
      if (type === 8) {
        pps = nal.slice()
        return
      }
      if (type !== 1 && type !== 5) return
      if (!decoder || !codec) return
      const parts: Uint8Array[] = []
      // IDR 前补 SPS/PPS：重新 configure 或丢包后解码器仍能恢复
      if (type === 5 && sps && pps) {
        parts.push(START_CODE, sps, START_CODE, pps)
      }
      parts.push(START_CODE, nal)
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: type === 5 ? 'key' : 'delta',
            timestamp: (ts += 33333),
            data: concatBytes(parts),
          })
        )
      } catch {
        fail()
      }
    }

    const pushChunk = (buf: ArrayBuffer | Uint8Array) => {
      const incoming = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
      const merged = new Uint8Array(pending.length + incoming.length)
      merged.set(pending)
      merged.set(incoming, pending.length)
      pending = merged

      // 找 start code；最后一个 NAL 可能不完整，留到下一次拼
      const starts: Array<{ pos: number; len: number }> = []
      for (let i = 0; i + 3 < pending.length; i++) {
        if (pending[i] === 0 && pending[i + 1] === 0) {
          if (pending[i + 2] === 1) {
            starts.push({ pos: i, len: 3 })
            i += 2
          } else if (pending[i + 2] === 0 && pending[i + 3] === 1) {
            starts.push({ pos: i, len: 4 })
            i += 3
          }
        }
      }
      if (!starts.length) {
        // 码流异常时别让缓冲区无限增长
        if (pending.length > 1024 * 1024) pending = new Uint8Array(0)
        return
      }
      for (let k = 0; k + 1 < starts.length; k++) {
        const from = starts[k].pos + starts[k].len
        const to = starts[k + 1].pos
        if (to > from) onNal(pending.slice(from, to))
      }
      pending = pending.slice(starts[starts.length - 1].pos)
    }

    const offChunk = main.on(
      'previewChunk',
      (deviceId: string, data: ArrayBuffer) => {
        if (!alive || failed || deviceId !== device.id) return
        pushChunk(data)
      }
    )
    const offError = main.on('previewError', (deviceId: string) => {
      if (!alive || deviceId !== device.id) return
      fail()
    })

    main.startPreviewStream(device.id).catch(fail)
    // 3.5 秒没首帧（老设备不支持 screenrecord / 编码器被占用）就退回截图
    const watchdog = setTimeout(() => {
      if (alive && !gotFrame) fail()
    }, 3500)

    return () => {
      alive = false
      clearTimeout(watchdog)
      offChunk()
      offError()
      stopPng()
      try {
        decoder?.close()
      } catch {
        // ignore
      }
      decoder = null
      main.stopPreviewStream().catch(() => undefined)
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = ''
      }
    }
    // 同一台设备也会从 offline 变成在线：type 一起进依赖，状态变化时重开预览
  }, [device?.id, device?.type])

  // 设备弹层要能 Esc 关闭：只能靠点遮罩关，键盘用户没退路
  useEffect(() => {
    if (!pickerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pickerOpen])

  useEffect(() => {
    setResolution('')
    if (!device || device.type === 'offline') return
    let alive = true
    getOverview(device.id)
      .then((overview) => {
        if (!alive) return
        const raw = String(
          overview.physicalResolution || overview.resolution || ''
        )
        const matched = /(\d+)x(\d+)/.exec(raw)
        setResolution(matched ? `${matched[2]}p` : raw)
      })
      .catch(() => {
        // 概览拿不到不影响文件页，侧栏保持 --
      })
    return () => {
      alive = false
    }
  }, [device?.id, device?.type])

  const online = device && device.type !== 'offline'
  const latency = ms !== null && ms >= 0 ? `${ms} ms` : '--'
  const android = device && device.androidVersion
    ? `Android ${device.androidVersion}`
    : '--'

  const liveText = !device
    ? t('notConnected')
    : preview === 'offline'
      ? t('offline')
      : preview === 'error'
        ? t('previewUnavailable')
        : preview === 'loading' && !url && !streamReady
          ? t('connectingPreview')
          : t('livePreview')

  return (
    <div className={Style.stageWrap}>
      <div className={Style.card}>
        <div
          className={Style.screen}
          onClick={() => {
            if (device) store.selectPanel('screenshot')
          }}
          title={device ? t('screenshot') : undefined}
        >
          <canvas
            ref={canvasRef}
            className={Style.video}
            width={480}
            height={270}
            style={{ display: streamReady ? 'block' : 'none' }}
          />
          {!streamReady &&
            (url ? (
              <img src={url} alt="" draggable={false} />
            ) : (
              <div className={Style.screenEmpty}>
                <span className="icon-phone" />
                <span>
                  {!device
                    ? t('deviceNotConnected')
                    : preview === 'offline'
                      ? t('deviceOffline')
                      : preview === 'error'
                        ? t('screenUnavailable')
                        : t('fetchingScreen')}
                </span>
                {!device && (
                  <button
                    className={Style.emptyBtn}
                    onClick={(e) => {
                      e.stopPropagation()
                      store.selectPanel('connect')
                    }}
                  >
                    {t('connect')}
                  </button>
                )}
              </div>
            ))}
          <span className={Style.live}>
            <span className={online ? Style.liveDot : Style.liveDotOff} />
            {liveText}
          </span>
        </div>

        <div className={Style.info}>
          <button
            className={Style.nameRow}
            onClick={() => setPickerOpen(!pickerOpen)}
            title={t('switchDevice')}
          >
            <span className={online ? Style.dot : Style.dot + ' ' + Style.off} />
            <span className={Style.name}>
              {device ? device.name : t('notConnected')}
            </span>
            <span className="icon-chevron-down" />
          </button>
          <div className={Style.ip}>{device ? device.id : '—'}</div>
          <div className={Style.stats}>
            <div className={Style.stat}>
              <div className={Style.k}>{t('system')}</div>
              <div className={Style.v}>{android}</div>
            </div>
            <div className={Style.stat}>
              <div className={Style.k}>{t('resolution')}</div>
              <div className={Style.v}>{resolution || '--'}</div>
            </div>
            <div className={Style.stat}>
              <div className={Style.k}>{t('latency')}</div>
              <div className={Style.v}>{latency}</div>
            </div>
          </div>
        </div>
      </div>

      <div className={Style.quick}>
        <button
          className={Style.quickBtn}
          disabled={!device}
          onClick={() => store.selectPanel('screenshot')}
        >
          <span className="icon-camera" />
          {t('screenshot')}
        </button>
        <button
          className={Style.quickBtn}
          disabled={!device}
          onClick={() => main.showScreencast()}
        >
          <span className="icon-screencast" />
          {t('screencast')}
        </button>
      </div>

      {pickerOpen && (
        <>
          <div
            className={Style.backdrop}
            onClick={() => setPickerOpen(false)}
          />
          <div className={Style.picker}>
            <div className={Style.pickerTitle}>{t('switchDevice')}</div>
            <div className={Style.pickerList}>
              {store.devices.map((item) => (
                <button
                  key={item.id}
                  className={
                    Style.pickerItem +
                    (device && item.id === device.id ? ' ' + Style.active : '')
                  }
                  onClick={() => {
                    store.selectDevice(item.id)
                    setPickerOpen(false)
                  }}
                >
                  <span
                    className={
                      item.type === 'offline'
                        ? Style.dot + ' ' + Style.off
                        : Style.dot
                    }
                  />
                  <span className={Style.pickerInfo}>
                    <span className={Style.pickerName}>{item.name}</span>
                    <span className={Style.pickerIp}>{item.id}</span>
                  </span>
                  {device && item.id === device.id && (
                    <span className={Style.current}>{t('current')}</span>
                  )}
                </button>
              ))}
            </div>
            <button
              className={Style.pickerConnect}
              onClick={() => {
                store.selectPanel('connect')
                setPickerOpen(false)
              }}
            >
              <span className="icon-link" />
              {t('connectDevice')}
            </button>
          </div>
        </>
      )}
    </div>
  )
})
