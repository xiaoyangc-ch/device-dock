/**
 * 日志终端：xterm + WebGL（拿不到就退回 canvas）。
 * 日志来自主进程 stdout/stderr 拦截，只读。
 */
import { observer } from 'mobx-react-lite'
import { useEffect, useRef } from 'react'
import { Terminal, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import replaceAll from 'licia/replaceAll'
import Style from './Terminal.module.scss'
import {
  colorBgContainer,
  colorBgContainerDark,
  colorPrimary,
  colorText,
  colorTextDark,
} from 'common/theme'
import store from '../store'
import '@xterm/xterm/css/xterm.css'
import contextMenu from '../../lib/contextMenu'
import { t } from '../../../common/i18n'
import copy from 'licia/copy'

function getTheme(dark = false): ITheme {
  return {
    selectionForeground: '#fff',
    selectionBackground: colorPrimary,
    background: dark ? colorBgContainerDark : colorBgContainer,
    foreground: dark ? colorTextDark : colorText,
  }
}

export default observer(function () {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const term = new Terminal({
      allowProposedApi: true,
      fontSize: 14,
      fontFamily: 'mono, courier-new, courier, monospace',
      theme: getTheme(store.theme === 'dark'),
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    // WebGL 在部分机型/虚拟机上创建失败，退回 canvas 仍然可用
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      term.loadAddon(new CanvasAddon())
    }

    term.open(containerRef.current!)
    const write = (log: string) => {
      term.write(replaceAll(log, '\n', '\r\n'))
    }
    const fit = () => fitAddon.fit()
    fit()

    window.addEventListener('resize', fit)
    // 窗口后开：先把主进程缓存的日志补齐，再订阅增量
    main.getLogs().then((logs: string[]) => {
      for (const item of logs) write(item)
    })
    main.on('addLog', write)

    termRef.current = term

    return () => {
      window.removeEventListener('resize', fit)
      term.dispose()
      termRef.current = null
    }
  }, [])

  const onContextMenu = (e: React.MouseEvent) => {
    const term = termRef.current!
    const template: any[] = [
      {
        label: t('copy'),
        click: () => {
          if (term.hasSelection()) {
            copy(term.getSelection())
            term.focus()
          }
        },
      },
      {
        label: t('selectAll'),
        click: () => term.selectAll(),
      },
      { type: 'separator' },
      {
        label: t('clear'),
        click: () => {
          main.clearLogs()
          term.clear()
          term.focus()
        },
      },
    ]

    contextMenu(e, template)
  }

  // 主题切换：只换配色，不重建终端（否则滚动位置和清屏状态丢失）
  if (termRef.current) {
    termRef.current.options.theme = getTheme(store.theme === 'dark')
  }

  return (
    <div className={Style.terminalContainer}>
      <div
        className={Style.terminal}
        ref={containerRef}
        onContextMenu={onContextMenu}
      />
    </div>
  )
})
