/**
 * 单个终端标签：xterm + adb shell 会话。
 * 组件挂载时创建会话、卸载时 kill；可见性变化时重新 fit（隐藏时 fit 会算错尺寸）。
 */
import { observer } from 'mobx-react-lite'
import store from '../../store'
import { Terminal, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { useEffect, useRef } from 'react'
import {
  colorPrimary,
  colorText,
  colorTextDark,
  fontFamilyCode,
} from 'common/theme'
import copy from 'licia/copy'
import Style from './Term.module.scss'
import '@xterm/xterm/css/xterm.css'
import { t } from 'common/util'
import contextMenu from 'share/renderer/lib/contextMenu'
import isHidden from 'licia/isHidden'

interface ITermProps {
  visible: boolean
  onSessionIdChange: (id: string) => void
  onCreate: (terminal: Terminal) => void
}

function getTheme(dark = false): ITheme {
  return {
    selectionForeground: '#fff',
    selectionBackground: colorPrimary,
    // 背景跟随主题底色，避免页面和 xterm 之间出现一条浅色接缝
    background: dark ? '#1c1e22' : '#ffffff',
    foreground: dark ? colorTextDark : colorText,
    cursor: dark ? colorTextDark : colorText,
  }
}

export default observer(function Term(props: ITermProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef('')
  const disposedRef = useRef(false)

  const { device } = store

  useEffect(() => {
    disposedRef.current = false
    const term = new Terminal({
      allowProposedApi: true,
      fontSize: 14,
      fontFamily: fontFamilyCode,
      theme: getTheme(store.theme === 'dark'),
    })

    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)

    const fit = () => {
      const el = containerRef.current
      // 隐藏的标签页尺寸为 0：fit 会把 cols/rows 算成 1
      if (el && !isHidden(el)) fitAddon.fit()
    }
    window.addEventListener('resize', fit)

    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'

    term.open(containerRef.current!)
    termRef.current = term
    props.onCreate(term)

    const offShellData = main.on('shellData', (id: string, data: string) => {
      if (sessionIdRef.current !== id) return
      term.write(data)
    })

    let disposed = false
    if (device) {
      main
        .createShell(device.id)
        .then((id) => {
          // 请求还在路上组件就卸载了：立刻回收，
          // 否则设备端留一个永远没人用的 shell 进程
          if (disposed) {
            main.killShell(id)
            return
          }

          setSessionId(id)
          term.onData((data) => main.writeShell(sessionIdRef.current, data))
          term.onResize((size) =>
            main.resizeShell(sessionIdRef.current, size.cols, size.rows)
          )
          fit()
        })
        .catch(() => {
          // 设备掉线：终端留空即可，不能抛未处理拒绝
        })
    }

    return () => {
      disposed = true
      disposedRef.current = true
      offShellData()
      if (sessionIdRef.current) main.killShell(sessionIdRef.current)
      term.dispose()
      window.removeEventListener('resize', fit)
    }
  }, [])

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getTheme(store.theme === 'dark')
    }
  }, [store.theme])

  useEffect(() => {
    if (!props.visible) return

    fitAddonRef.current?.fit()
    // 等面板显示完成再聚焦，否则 focus 会被隐藏状态吞掉
    const timer = setTimeout(() => termRef.current?.focus(), 500)
    return () => clearTimeout(timer)
  }, [props.visible])

  function setSessionId(id: string) {
    sessionIdRef.current = id
    props.onSessionIdChange(id)
  }

  function onContextMenu(e: React.MouseEvent) {
    if (!device) return

    const term = termRef.current!
    const template: any[] = [
      {
        label: t('copy'),
        click() {
          if (term.hasSelection()) {
            copy(term.getSelection())
            term.focus()
          }
        },
      },
      {
        label: t('paste'),
        click: async () => {
          try {
            const text = await main.readClipboard()
            if (text) main.writeShell(sessionIdRef.current, text)
          } catch {
            // 系统剪贴板不可用时保持终端内容不变。
          }
        },
      },
      {
        label: t('selectAll'),
        click() {
          term.selectAll()
        },
      },
      { type: 'separator' },
      {
        label: t('reset'),
        click() {
          if (sessionIdRef.current) main.killShell(sessionIdRef.current)

          term.reset()
          if (!device) return

          main
            .createShell(device.id)
            .then((id) => {
              if (disposedRef.current) {
                main.killShell(id)
                return
              }
              setSessionId(id)
            })
            .catch(() => {
              // 设备掉线：重置后留空终端，不能产生未处理拒绝
            })
          term.focus()
        },
      },
      {
        label: t('clear'),
        click() {
          term.clear()
          term.focus()
        },
      },
    ]

    contextMenu(e, template)
  }

  return (
    <div
      className={Style.term}
      style={{ display: props.visible ? 'block' : 'none' }}
      ref={containerRef}
      onContextMenu={onContextMenu}
    />
  )
})
