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

export default observer(function Term(props: ITermProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal>(null)
  const fitAddonRef = useRef<FitAddon>(null)
  const sessionIdRef = useRef('')

  const { device } = store

  useEffect(() => {
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
      const el = terminalRef.current
      if (el && !isHidden(el)) {
        fitAddon.fit()
      }
    }
    window.addEventListener('resize', fit)

    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'

    term.open(terminalRef.current!)
    termRef.current = term
    props.onCreate(term)

    function onShellData(id, data) {
      if (sessionIdRef.current !== id) {
        return
      }
      term.write(data)
    }
    const offShellData = main.on('shellData', onShellData)

    let disposed = false
    if (device) {
      main
        .createShell(device.id)
        .then((id) => {
          // 请求还在路上组件就卸载了：立刻回收，否则设备端留一个永远没人用的 shell
          if (disposed) {
            main.killShell(id)
            return
          }
          setSessionId(id)
          term.onData((data) => main.writeShell(sessionIdRef.current, data))
          term.onResize((size) => {
            main.resizeShell(sessionIdRef.current, size.cols, size.rows)
          })
          fit()
        })
        .catch(() => {
          // 设备掉线：终端留空即可，不能抛出未处理拒绝
        })
    }

    return () => {
      disposed = true
      offShellData()
      if (sessionIdRef.current) {
        main.killShell(sessionIdRef.current)
      }
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
    if (fitAddonRef.current && props.visible) {
      fitAddonRef.current.fit()
    }
    if (props.visible) {
      setTimeout(() => {
        if (termRef.current) {
          termRef.current.focus()
        }
      }, 500)
    }
  }, [props.visible])

  function setSessionId(id: string) {
    sessionIdRef.current = id
    props.onSessionIdChange(id)
  }

  const onContextMenu = (e: React.MouseEvent) => {
    if (!device) {
      return
    }

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
          const text = await navigator.clipboard.readText()
          if (text) {
            main.writeShell(sessionIdRef.current, text)
          }
        },
      },
      {
        label: t('selectAll'),
        click() {
          term.selectAll()
        },
      },
      {
        type: 'separator',
      },
      {
        label: t('reset'),
        click() {
          if (sessionIdRef.current) {
            main.killShell(sessionIdRef.current)
          }
          term.reset()
          if (device) {
            main
              .createShell(device.id)
              .then((id) => {
                setSessionId(id)
              })
              .catch(() => {
                // 设备掉线：重置后留空终端，不能产生未处理拒绝
              })
            term.focus()
          }
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
    <>
      <div
        className={Style.term}
        style={{ display: props.visible ? 'block' : 'none' }}
        ref={terminalRef}
        onContextMenu={onContextMenu}
      />
    </>
  )
})

function getTheme(dark = false) {
  // 终端背景跟随 3.0 的 --ui-bg，避免页面和 xterm 之间出现一条浅色接缝
  let theme: ITheme = {
    background: '#ffffff',
    foreground: colorText,
    cursor: colorText,
  }

  if (dark) {
    theme = {
      background: '#1c1e22',
      foreground: colorTextDark,
      cursor: colorTextDark,
    }
  }

  return {
    selectionForeground: '#fff',
    selectionBackground: colorPrimary,
    ...theme,
  }
}
