/**
 * 日志页：主进程按批推 logcat 条目，这里只负责渲染/过滤/导出。
 * 暂停逻辑统一由一个 effect 发 pause/resume：放渲染体里每次重绘都会多打一条 IPC。
 */
import { observer } from 'mobx-react-lite'
import LunaLogcat from 'luna-logcat/react'
import Logcat from 'luna-logcat'
import rpad from 'licia/rpad'
import dateFormat from 'licia/dateFormat'
import toNum from 'licia/toNum'
import { useEffect, useRef, useState } from 'react'
import store from '../../store'
import copy from 'licia/copy'
import download from 'licia/download'
import toStr from 'licia/toStr'
import { t } from 'common/util'
import contextMenu from 'share/renderer/lib/contextMenu'
import Style from './Logcat.module.scss'
import PageToolbar, {
  Page,
  PageBody,
  ToolButton,
  ToolInput,
  ToolSelect,
  ToolSeparator,
  ToolSpace,
} from '../layout/PageToolbar'

const MAX_ENTRIES = 10000
const PRIORITY_LETTERS = ['?', '?', 'V', 'D', 'I', 'W', 'E']

function toLetter(priority: number) {
  return PRIORITY_LETTERS[priority] || '?'
}

export default observer(function Logcat() {
  const [view, setView] = useState<'compact' | 'standard'>('standard')
  const [softWrap, setSoftWrap] = useState(false)
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState<{
    priority?: number
    package?: string
    tag?: string
  }>({})
  const [logcatId, setLogcatId] = useState('')
  const [pageHidden, setPageHidden] = useState(document.hidden)

  const logcatRef = useRef<Logcat>(null)
  // 导出用的影子副本：不能无限长，否则长会话迟早 OOM
  const entriesRef = useRef<any[]>([])
  const logcatIdRef = useRef('')

  const { device } = store

  useEffect(() => {
    function onEntries(id: string, entries: any[]) {
      if (logcatIdRef.current !== id) return
      if (!logcatRef.current) return

      for (const entry of entries) {
        logcatRef.current.append(entry)
        entriesRef.current.push(entry)
      }

      if (entriesRef.current.length > MAX_ENTRIES) {
        entriesRef.current.splice(0, entriesRef.current.length - MAX_ENTRIES)
      }
    }

    const offEntries = main.on('logcatEntries', onEntries)
    // 设备切太快时 openLogcat 可能在 cleanup 之后才 resolve：
    // 迟到的会话没人关，设备端就会挂一条常驻 logcat
    let disposed = false

    if (device) {
      main
        .openLogcat(device.id)
        .then((id) => {
          if (disposed) {
            main.closeLogcat(id).catch(() => {})
            return
          }
          logcatIdRef.current = id
          setLogcatId(id)
        })
        .catch(() => {
          // 设备掉线：保持空日志视图，不能变成未处理拒绝
        })
    }

    return () => {
      disposed = true
      offEntries()
      if (logcatIdRef.current) {
        main.closeLogcat(logcatIdRef.current).catch(() => {})
        logcatIdRef.current = ''
      }
    }
    // 换设备必须重开日志流：deps 为空会一直显示上一台设备的 logcat
  }, [device ? device.id : ''])

  useEffect(() => {
    const onVisibility = () => setPageHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () =>
      document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    if (!logcatId) return

    // 不在日志页 / 暂停 / 窗口最小化时都要停：日志每秒几百条，
    // DOM 会在后台一直重排
    if (store.panel !== 'logcat' || paused || pageHidden) {
      main.pauseLogcat(logcatId)
    } else {
      main.resumeLogcat(logcatId)
    }
  }, [store.panel, paused, logcatId, pageHidden])

  function save() {
    const data = entriesRef.current
      .map((entry) =>
        `${dateFormat(entry.date, 'mm-dd HH:MM:ss.l')} ${rpad(
          entry.pid,
          5,
          ' '
        )} ${rpad(entry.tid, 5, ' ')} ${toLetter(entry.priority)} ${
          entry.tag
        }: ${entry.message}`.trim()
      )
      .join('\n')

    const name = `${
      store.device ? store.device.name : 'logcat'
    }.${dateFormat('yyyymmddHH')}.txt`

    download(data, name, 'text/plain')
  }

  function clear() {
    logcatRef.current?.clear()
    entriesRef.current = []
  }

  function restart() {
    if (logcatIdRef.current) {
      main.closeLogcat(logcatIdRef.current).catch(() => {})
      clear()
    }
    if (!device) return

    main
      .openLogcat(device.id)
      .then((id) => {
        logcatIdRef.current = id
        setLogcatId(id)
        setPaused(false)
      })
      .catch(() => {
        // 掉线时重启失败：保持空白日志页即可
      })
  }

  function onContextMenu(e: PointerEvent, entry: any) {
    e.preventDefault()

    const logcat = logcatRef.current!
    const template: any[] = [
      {
        label: t('copy'),
        click: () => {
          if (logcat.hasSelection()) {
            copy(logcat.getSelection())
          } else if (entry) {
            copy(entry.message)
          }
        },
      },
      { type: 'separator' },
      {
        label: t('clear'),
        click: clear,
      },
    ]

    contextMenu(e, template)
  }

  return (
    <Page>
      <PageToolbar>
        <ToolSelect
          value={view}
          width={92}
          disabled={!device}
          options={[
            { label: t('standardView'), value: 'standard' },
            { label: t('compactView'), value: 'compact' },
          ]}
          onChange={(value) =>
            setView(value === 'compact' ? 'compact' : 'standard')
          }
        />
        <ToolSeparator />
        <ToolSelect
          value={toStr(filter.priority || 2)}
          width={88}
          disabled={!device}
          options={[
            { label: 'VERBOSE', value: '2' },
            { label: 'DEBUG', value: '3' },
            { label: 'INFO', value: '4' },
            { label: 'WARNING', value: '5' },
            { label: 'ERROR', value: '6' },
          ]}
          onChange={(value) =>
            setFilter({ ...filter, priority: toNum(value) })
          }
        />
        <ToolInput
          value={filter.package || ''}
          width={120}
          placeholder={t('package')}
          onChange={(value) => setFilter({ ...filter, package: value })}
        />
        <ToolInput
          value={filter.tag || ''}
          width={100}
          placeholder={t('tag')}
          onChange={(value) => setFilter({ ...filter, tag: value })}
        />
        <ToolSpace />
        <ToolButton
          icon="icon-save"
          title={t('save')}
          onClick={save}
          disabled={!device}
        />
        <ToolSeparator />
        <ToolButton
          icon="icon-soft-wrap"
          title={t('softWrap')}
          active={softWrap}
          onClick={() => setSoftWrap(!softWrap)}
        />
        <ToolButton
          icon="icon-scroll-end"
          title={t('scrollToEnd')}
          onClick={() => logcatRef.current?.scrollToEnd()}
          disabled={!device}
        />
        <ToolButton
          icon="icon-reset"
          title={t('restart')}
          disabled={!device}
          onClick={restart}
        />
        <ToolButton
          icon={paused ? 'icon-play' : 'icon-pause'}
          title={t(paused ? 'resume' : 'pause')}
          disabled={!device}
          // 只切状态：pause/resume IPC 由上面的 effect 统一发，避免一次点击两条
          onClick={() => setPaused(!paused)}
        />
        <ToolSeparator />
        <ToolButton
          icon="icon-delete"
          title={t('clear')}
          onClick={clear}
          disabled={!device}
        />
      </PageToolbar>
      <PageBody className={Style.body}>
        <LunaLogcat
          className={Style.logcat}
          theme={store.theme === 'dark' ? 'dark' : 'light'}
          maxNum={MAX_ENTRIES}
          filter={filter}
          wrapLongLines={softWrap}
          onContextMenu={onContextMenu}
          view={view}
          onCreate={(instance) => (logcatRef.current = instance)}
        />
      </PageBody>
    </Page>
  )
})
