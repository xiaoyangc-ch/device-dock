import { observer } from 'mobx-react-lite'
import LunaLogcat from 'luna-logcat/react'
import Logcat from 'luna-logcat'
import map from 'licia/map'
import rpad from 'licia/rpad'
import dateFormat from 'licia/dateFormat'
import toNum from 'licia/toNum'
import trim from 'licia/trim'
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

export default observer(function Logcat() {
  const [view, setView] = useState<'compact' | 'standard'>('standard')
  const [softWrap, setSoftWrap] = useState(false)
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState<{
    priority?: number
    package?: string
    tag?: string
  }>({})
  const logcatRef = useRef<Logcat>(null)
  const entriesRef = useRef<any[]>([])
  const logcatIdRef = useRef('')
  const [logcatId, setLogcatId] = useState('')
  const [pageHidden, setPageHidden] = useState(document.hidden)

  const { device } = store

  useEffect(() => {
    function onLogcatEntries(id, entries) {
      if (logcatIdRef.current !== id) {
        return
      }
      if (logcatRef.current) {
        for (let i = 0, len = entries.length; i < len; i++) {
          logcatRef.current.append(entries[i])
          entriesRef.current.push(entries[i])
        }
        // 长会话不能无限留一份影子副本（导出用），否则渲染进程迟早 OOM
        if (entriesRef.current.length > 10000) {
          entriesRef.current.splice(0, entriesRef.current.length - 10000)
        }
      }
    }
    const offLogcatEntry = main.on('logcatEntries', onLogcatEntries)
    // 设备切换太快时 openLogcat 可能在 cleanup 之后才 resolve：
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
          // 设备掉线：保持空日志视图，不能变未处理拒绝
        })
    }

    return () => {
      disposed = true
      offLogcatEntry()
      if (logcatIdRef.current) {
        main.closeLogcat(logcatIdRef.current).catch(() => {})
        logcatIdRef.current = ''
      }
    }
    // 换设备必须重开日志流：原来 deps 为空，界面会一直显示上一台设备的 logcat
  }, [device ? device.id : ''])

  // 原来在渲染函数体里直接发 pause/resume：每次重渲染都会多打一次 IPC，
  // 还会和「重启 logcat」抢同一个 id（main 侧已经没有对应 reader）
  useEffect(() => {
    const onVisibility = () => setPageHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    if (!logcatId) return
    // 窗口最小化时也暂停：否则日志每秒几百条，DOM 一直在后台重排
    if (store.panel !== 'logcat' || paused || pageHidden) {
      main.pauseLogcat(logcatId)
    } else {
      main.resumeLogcat(logcatId)
    }
  }, [store.panel, paused, logcatId, pageHidden])

  function save() {
    const data = map(entriesRef.current, (entry) => {
      return trim(
        `${dateFormat(entry.date, 'mm-dd HH:MM:ss.l')} ${rpad(
          entry.pid,
          5,
          ' '
        )} ${rpad(entry.tid, 5, ' ')} ${toLetter(entry.priority)} ${
          entry.tag
        }: ${entry.message}`
      )
    }).join('\n')
    const name = `${store.device ? store.device.name : 'logcat'}.${dateFormat(
      'yyyymmddHH'
    )}.txt`

    download(data, name, 'text/plain')
  }

  function clear() {
    if (logcatRef.current) {
      logcatRef.current.clear()
    }
    entriesRef.current = []
  }

  const onContextMenu = (e: PointerEvent, entry: any) => {
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
      {
        type: 'separator',
      },
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
          onChange={(val) =>
            setView(val === 'compact' ? 'compact' : 'standard')
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
          onChange={(val) =>
            setFilter({ ...filter, priority: toNum(val) })
          }
        />
        <ToolInput
          value={filter.package || ''}
          width={120}
          placeholder={t('package')}
          onChange={(val) => setFilter({ ...filter, package: val })}
        />
        <ToolInput
          value={filter.tag || ''}
          width={100}
          placeholder={t('tag')}
          onChange={(val) => setFilter({ ...filter, tag: val })}
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
          onClick={() => {
            if (logcatIdRef.current) {
              main.closeLogcat(logcatIdRef.current).catch(() => {})
              clear()
            }
            if (device) {
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
          }}
        />
        <ToolButton
          icon={paused ? 'icon-play' : 'icon-pause'}
          title={t(paused ? 'resume' : 'pause')}
          disabled={!device}
          onClick={() => {
            // 只切状态：pause/resume IPC 统一由上面的 effect 发，避免一次点击发两条
            setPaused(!paused)
          }}
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
          maxNum={10000}
          filter={filter}
          wrapLongLines={softWrap}
          onContextMenu={onContextMenu}
          view={view}
          onCreate={(logcat) => (logcatRef.current = logcat)}
        />
      </PageBody>
    </Page>
  )
})

function toLetter(priority: number) {
  return ['?', '?', 'V', 'D', 'I', 'W', 'E'][priority]
}
