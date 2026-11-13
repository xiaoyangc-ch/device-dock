/**
 * 投屏窗口：工具栏 + 画面 + 信号源/设置弹窗。
 *
 * 连接与解码在 cast/session，输入绑定在 cast/input，录制在 cast/recorder。
 * 这个文件只做状态编排和界面。
 */
import { useEffect, useRef, useState } from 'react'
import getUrlParam from 'licia/getUrlParam'
import download from 'licia/download'
import fullscreen from 'licia/fullscreen'
import dateFormat from 'licia/dateFormat'
import LunaModal from 'luna-modal'
import LunaToolbar, {
  LunaToolbarSeparator,
  LunaToolbarSpace,
} from 'luna-toolbar/react'
import ToolbarIcon from 'share/renderer/components/ToolbarIcon'
import { LoadingBar } from 'share/renderer/components/loading'
import { t } from 'common/util'
import { AndroidKeyCode } from '@yume-chan/scrcpy'
import Style from './App.module.scss'
import { CastConfig, CastSession, SessionState } from './cast/session'
import { bindKeyboard, bindPointer, hasNonAscii } from './cast/input'
import { ScreenRecorder } from './cast/recorder'

const DEFAULT_CONFIG: CastConfig = {
  bitRate: 8000000,
  maxSize: 1280,
  maxFps: 30,
  codec: 'h264',
  displayId: 0,
}

const MAX_AUTO_RETRIES = 2
const QUIET_RETRY_WINDOW = 10000
const TOAST_TTL = 3000

export default function App() {
  const deviceId = getUrlParam('device') || ''
  const deviceName = getUrlParam('name') || deviceId

  const screenRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<CastSession | null>(null)
  const recorderRef = useRef<ScreenRecorder | null>(null)
  const videosRef = useRef<HTMLVideoElement[]>([])
  const unbindRef = useRef<Array<() => void>>([])
  const imeRef = useRef('')
  const configRef = useRef<CastConfig>(DEFAULT_CONFIG)
  const startedAtRef = useRef(0)
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 设备不支持 HEVC 时只自动回退一次，避免用户故意选 H.265 时被无声改掉
  const h265FallbackRef = useRef(false)

  const [state, setState] = useState<SessionState>('connecting')
  const [error, setError] = useState('')
  const [pin, setPin] = useState(false)
  const [config, setConfig] = useState<CastConfig>(DEFAULT_CONFIG)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [displaysOpen, setDisplaysOpen] = useState(false)
  const [displays, setDisplays] = useState<{ id: number; name: string }[]>([])
  const [toast, setToast] = useState('')
  const [recording, setRecording] = useState(false)
  const [generation, setGeneration] = useState(0)

  function showToast(message: string) {
    setToast(message)
  }

  // toast 统一在这里自动消失，调用方不用各自 setTimeout
  useEffect(() => {
    if (!toast) return

    const timer = setTimeout(() => setToast(''), TOAST_TTL)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const address = deviceId.includes(':') ? deviceId : ''
    preload.setTitle(address ? `${deviceName} (${address})` : deviceName)
  }, [deviceName, deviceId])

  useEffect(() => {
    main
      .getInputMethod(deviceId)
      .then((ime) => {
        imeRef.current = ime
      })
      .catch(() => {})
  }, [deviceId])

  // 窗口被直接销毁时 React 不一定走 unmount：beforeunload 兜一层，
  // 否则设备端会留一个没人用的 server 进程
  useEffect(() => {
    const stop = () => {
      main.stopWebCast(deviceId).catch(() => {})
    }
    window.addEventListener('beforeunload', stop)

    return () => {
      window.removeEventListener('beforeunload', stop)
      recorderRef.current?.dispose()
      recorderRef.current = null
    }
  }, [deviceId])

  useEffect(() => {
    let cancelled = false
    let unbindKeys: (() => void) | null = null

    async function boot() {
      // 设置是异步读出来的：开局用默认值会「设置里写 16M，实际跑 8M」
      try {
        const stored = (await main.getScreencastStore(
          'deviceCast'
        )) as CastConfig | null
        if (stored?.bitRate) {
          configRef.current = { ...DEFAULT_CONFIG, ...stored }
          setConfig(configRef.current)
        }
      } catch {
        // 读不到就用默认值
      }
      if (cancelled) return

      startedAtRef.current = Date.now()
      setError('')
      setState('connecting')

      // 旧会话只清本地资源：设备端 server 由新会话 start() 统一停，
      // 否则旧会话的异步清理可能把刚起来的这一路踢掉
      sessionRef.current?.disposeLocal()
      for (const video of videosRef.current) video.remove()
      videosRef.current = []

      const session: CastSession = new CastSession(deviceId, {
        onState: (next, detail) => {
          if (cancelled) return

          setState(next)
          if (next === 'failed' && detail) setError(detail)
        },
        onToast: (message) => {
          if (!cancelled) showToast(message)
        },
        onSize: () => {},
        onClipboard: (text) => {
          // 设备端复制的文本回传到 PC 剪贴板
          main.writeClipboard(text).catch(() => undefined)
          if (!cancelled) showToast('已同步设备剪贴板')
        },
        onVideo: (element) => {
          if (cancelled) return

          element.className = Style.castVideo
          element.tabIndex = 0
          screenRef.current?.appendChild(element)
          videosRef.current.push(element)

          unbindRef.current.push(
            bindPointer(element, {
              control: session.control,
              getSize: () => session.size,
              getIme: () => imeRef.current,
              onToast: showToast,
              readClipboard: () => main.readClipboard(),
            })
          )
        },
      })

      sessionRef.current = session
      unbindKeys = bindKeyboard({
        control: session.control,
        getSize: () => session.size,
        getIme: () => imeRef.current,
        onToast: showToast,
        readClipboard: () => main.readClipboard(),
      })

      recorderRef.current = new ScreenRecorder(
        deviceId,
        () => session.videoEl,
        {
          onState: (active) => {
            if (!cancelled) setRecording(active)
          },
          onToast: showToast,
        }
      )

      try {
        await session.start(configRef.current)
        if (!cancelled) retryCountRef.current = 0
      } catch (e: any) {
        if (!cancelled) handleStartFailure(e)
      }
    }

    boot()

    return () => {
      cancelled = true
      unbindKeys?.()

      for (const unbind of unbindRef.current) unbind()
      unbindRef.current = []

      // 只清本地；设备端 server 交给下一轮 start() 或 beforeunload
      sessionRef.current?.disposeLocal()
      sessionRef.current = null
    }
    // generation 变化 = 用户重连 / 切信号源 / 改设置
  }, [deviceId, generation])

  /** 启动失败：先自动重试，再考虑 H.265 回退，最后才展示错误。 */
  function handleStartFailure(e: any) {
    const message = String(e?.message || e)

    // rk3399 这类设备没有可用 HEVC 编码器：server 打印
    // "Could not create default video encoder for h265" 后退出，
    // 前端只能看到流提前结束，不自动回退会一直死循环
    if (configRef.current.codec === 'h265' && !h265FallbackRef.current) {
      h265FallbackRef.current = true
      applyConfig({ ...configRef.current, codec: 'h264' })
      showToast('该设备不支持 H.265 编码，已自动切回 H.264')
      setGeneration((value) => value + 1)
      return
    }

    // 刚起来的 10 秒内断线不提示：设备重启 adb 时这很常见
    const quiet = Date.now() - startedAtRef.current < QUIET_RETRY_WINDOW
    if (retryCountRef.current < MAX_AUTO_RETRIES) {
      retryCountRef.current += 1
      if (!quiet) {
        showToast(`连接断开，正在第 ${retryCountRef.current} 次重连…`)
      }
      setState('connecting')

      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null
        setGeneration((value) => value + 1)
      }, 1200)
      return
    }

    setState('failed')
    setError(
      /ExactReadable ended/i.test(message)
        ? configRef.current.codec === 'h265'
          ? '投屏流意外中断：该设备不支持 H.265 硬件编码，请改用 H.264'
          : '投屏流意外中断：设备端编码器异常（可点下方「重新连接」）'
        : message
    )
  }

  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [])

  function restartSession() {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    retryCountRef.current = 0
    setError('')
    setState('connecting')
    setGeneration((value) => value + 1)
  }

  function applyConfig(next: CastConfig) {
    configRef.current = next
    setConfig(next)
    main.setScreencastStore('deviceCast', next)
  }

  function saveSettings(next: CastConfig) {
    // 用户重新选 H.265 就再给一次机会（可能换了设备或分辨率）
    if (next.codec === 'h265') h265FallbackRef.current = false

    applyConfig(next)
    setSettingsOpen(false)
    restartSession()
  }

  function chooseDisplay(displayId: number) {
    applyConfig({ ...configRef.current, displayId })
    setDisplaysOpen(false)
    restartSession()
  }

  async function openDisplays() {
    setDisplaysOpen(true)
    try {
      setDisplays(await main.getWebCastDisplays(deviceId))
    } catch {
      showToast('读取信号源失败')
    }
  }

  // 按钮回调里现取会话：渲染时闭包里的 control 在重连后会失效
  function pressKey(keyCode: number) {
    return () => sessionRef.current?.control.key(keyCode)
  }

  function sendCommand(type: number) {
    sessionRef.current?.control.command(type)
  }

  function setScreenPower(mode: number) {
    sessionRef.current?.control.screenPower(mode)
  }

  async function injectTextInput() {
    const text = await LunaModal.prompt(t('inputText'), '')
    if (!text) return

    const control = sessionRef.current?.control
    if (!control) return

    if (hasNonAscii(text)) {
      control.paste(text)
      showToast('已通过剪贴板粘贴（含非 ASCII 字符）')
    } else {
      control.text(text)
    }
  }

  function toggleFullscreen() {
    const element = screenRef.current
    if (element) fullscreen.toggle(element)
  }

  function captureScreenshot() {
    const video = sessionRef.current?.videoEl
    if (!video) return

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || video.clientWidth
    canvas.height = video.videoHeight || video.clientHeight

    const context = canvas.getContext('2d')
    if (!context) return

    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (blob) {
        download(
          blob,
          `screenshot-${dateFormat('yyyymmddHHMM')}.png`,
          'image/png'
        )
      }
    }, 'image/png')
  }

  async function onDropFiles(e: React.DragEvent) {
    e.preventDefault()

    for (const file of Array.from(e.dataTransfer.files || [])) {
      if (!file.name.toLowerCase().endsWith('.apk')) continue

      const filePath = preload.getPathForFile(file)
      if (!filePath) continue

      showToast(`正在安装 ${file.name}…`)
      const result = await main.installWebCastApk(deviceId, filePath)
      showToast(
        result.ok ? `${file.name} 安装完成` : `安装失败：${result.message}`
      )
    }
  }

  const loading = state === 'connecting'

  return (
    <div
      className={Style.castShell}
      onDrop={onDropFiles}
      onDragOver={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <LunaToolbar className={Style.castToolbar}>
        <ToolbarIcon
          icon="power"
          title={t('power')}
          onClick={pressKey(AndroidKeyCode.Power)}
        />
        <ToolbarIcon
          icon="volume"
          title={t('volumeUp')}
          onClick={pressKey(AndroidKeyCode.VolumeUp)}
        />
        <ToolbarIcon
          icon="volume-down"
          title={t('volumeDown')}
          onClick={pressKey(AndroidKeyCode.VolumeDown)}
        />
        <LunaToolbarSeparator />
        <ToolbarIcon
          icon="back"
          title={t('back')}
          onClick={pressKey(AndroidKeyCode.AndroidBack)}
        />
        <ToolbarIcon
          icon="circle"
          title={t('home')}
          onClick={pressKey(AndroidKeyCode.AndroidHome)}
        />
        <ToolbarIcon
          icon="square"
          title={t('appSwitch')}
          onClick={pressKey(AndroidKeyCode.AndroidAppSwitch)}
        />
        <ToolbarIcon
          icon="text"
          title={t('inputText')}
          onClick={injectTextInput}
        />
        <LunaToolbarSeparator />
        <ToolbarIcon icon="grid" title="信号源" onClick={openDisplays} />
        <ToolbarIcon icon="refresh" title="重启投屏" onClick={restartSession} />
        <ToolbarIcon
          icon="screen-off"
          title={t('screenOff')}
          onClick={() => setScreenPower(0)}
        />
        <ToolbarIcon
          icon="screen-on"
          title={t('screenOn')}
          onClick={() => setScreenPower(2)}
        />
        <ToolbarIcon
          icon="rotate-left"
          title="旋转屏幕"
          onClick={() => sendCommand(11)}
        />
        <ToolbarIcon
          icon="expand"
          title="通知面板"
          onClick={() => sendCommand(5)}
        />
        <ToolbarIcon
          icon="collapse"
          title="收起面板"
          onClick={() => sendCommand(7)}
        />
        <ToolbarIcon
          icon="camera"
          title={t('screenshot')}
          onClick={captureScreenshot}
        />
        <ToolbarIcon
          icon="video-recorder"
          title={recording ? '停止录制' : '开始录制'}
          state={recording ? 'hover' : ''}
          onClick={() =>
            recording
              ? recorderRef.current?.stop()
              : recorderRef.current?.start()
          }
        />
        <LunaToolbarSeparator />
        <ToolbarIcon
          icon="pin"
          title={t('alwaysOnTop')}
          state={pin ? 'hover' : ''}
          onClick={() => {
            const next = !pin
            setPin(next)
            main.webCastOnTop(deviceId, next)
          }}
        />
        <ToolbarIcon
          icon="fullscreen"
          title={t('fullscreen')}
          onClick={toggleFullscreen}
        />
        <LunaToolbarSpace />
        <ToolbarIcon
          icon="setting"
          title={t('settings')}
          onClick={() => setSettingsOpen(true)}
        />
      </LunaToolbar>

      <div ref={screenRef} className={Style.castStage}>
        {loading && (
          <div className={Style.castLoading}>
            <LoadingBar />
          </div>
        )}
        {error && (
          <div className={Style.castError}>
            <div className={Style.castErrorMessage}>{error}</div>
            <button className={Style.castRetry} onClick={restartSession}>
              重新连接
            </button>
          </div>
        )}
      </div>

      {toast && <div className={Style.castToast}>{toast}</div>}

      {displaysOpen && (
        <div className={Style.castOverlay} onClick={() => setDisplaysOpen(false)}>
          <div className={Style.castDialog} onClick={(e) => e.stopPropagation()}>
            <div className={Style.castDialogTitle}>信号源</div>
            <div className={Style.castDialogHint}>
              副屏（HDMI）只有在设备端有内容输出时才有画面，否则是黑屏；可随时切回主屏。
            </div>
            {displays.map((item) => {
              const current = config.displayId === item.id
              return (
                <button
                  key={item.id}
                  className={Style.castDisplayOption}
                  disabled={current}
                  onClick={() => chooseDisplay(item.id)}
                >
                  {item.name}
                  {current ? '（当前）' : ''}
                </button>
              )
            })}
            <div className={Style.castDialogActions}>
              <button onClick={() => setDisplaysOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <SettingsDialog
          value={config}
          onCancel={() => setSettingsOpen(false)}
          onSave={saveSettings}
          onReboot={() => {
            // 「重启设备」放设置里：工具栏上误点会把门店机重启
            if (
              !window.confirm(
                `确定要重启「${deviceName}」吗？重启期间投屏会中断。`
              )
            ) {
              return
            }

            setSettingsOpen(false)
            main
              .rebootDevice(deviceId)
              .then(() => showToast('已发送重启命令'))
              .catch(() => showToast('重启失败：设备可能已离线'))
          }}
        />
      )}
    </div>
  )
}

function SettingsDialog(props: {
  value: CastConfig
  onCancel: () => void
  onSave: (value: CastConfig) => void
  onReboot: () => void
}) {
  const [draft, setDraft] = useState<CastConfig>(props.value)

  return (
    <div className={Style.castOverlay} onClick={props.onCancel}>
      <div className={Style.castDialog} onClick={(e) => e.stopPropagation()}>
        <div className={Style.castDialogTitle}>投屏设置</div>
        <label className={Style.castField}>
          <span>码率</span>
          <select
            value={draft.bitRate}
            onChange={(e) =>
              setDraft({ ...draft, bitRate: Number(e.target.value) })
            }
          >
            {[
              4000000, 8000000, 12000000, 16000000, 24000000, 32000000, 50000000,
            ].map((value) => (
              <option key={value} value={value}>
                {value / 1000000} Mbps
              </option>
            ))}
          </select>
        </label>
        <label className={Style.castField}>
          <span>最大尺寸</span>
          <select
            value={draft.maxSize}
            onChange={(e) =>
              setDraft({ ...draft, maxSize: Number(e.target.value) })
            }
          >
            <option value={720}>720</option>
            <option value={1280}>1280</option>
            <option value={1920}>1920</option>
            <option value={0}>原始分辨率</option>
          </select>
        </label>
        <label className={Style.castField}>
          <span>编码</span>
          <select
            value={draft.codec || 'h264'}
            onChange={(e) =>
              setDraft({ ...draft, codec: e.target.value as 'h264' | 'h265' })
            }
          >
            <option value="h264">H.264</option>
            <option value="h265">H.265（省带宽，需设备支持 HEVC 编码）</option>
          </select>
        </label>
        <div className={Style.castFieldHint}>
          设备不支持 HEVC 编码时自动回退 H.264
        </div>
        <label className={Style.castField}>
          <span>帧率</span>
          <select
            value={draft.maxFps}
            onChange={(e) =>
              setDraft({ ...draft, maxFps: Number(e.target.value) })
            }
          >
            <option value={15}>15 FPS</option>
            <option value={30}>30 FPS</option>
            <option value={60}>60 FPS</option>
          </select>
        </label>
        <div className={Style.castDialogActions}>
          <button className={Style.castReboot} onClick={props.onReboot}>
            重启设备
          </button>
          <button onClick={props.onCancel}>取消</button>
          <button className={Style.castPrimary} onClick={() => props.onSave(draft)}>
            保存并重连
          </button>
        </div>
      </div>
    </div>
  )
}
