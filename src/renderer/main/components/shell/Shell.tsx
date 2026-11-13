import { observer } from 'mobx-react-lite'
import Term from './Term'
import { t } from 'common/util'
import store from '../../store'
import Style from './Shell.module.scss'
import { useEffect, useRef, useState } from 'react'
import uuid from 'licia/uuid'
import map from 'licia/map'
import filter from 'licia/filter'
import LunaCommandPalette from 'luna-command-palette/react'
import find from 'licia/find'
import idxOf from 'licia/idxOf'
import truncate from 'licia/truncate'
import { Terminal } from '@xterm/xterm'
import PageToolbar, {
  Page,
  PageBody,
  ToolButton,
  ToolSpace,
} from '../layout/PageToolbar'

interface IShell {
  id: string
  name: string
  sessionId: string
  terminal?: Terminal
}

export default observer(function Shell() {
  const [shells, setShells] = useState<Array<IShell>>([])
  const [commandPaletteVisible, setCommandPaletteVisible] = useState(false)
  const [selectedShell, setSelectedShell] = useState<IShell>({
    id: '',
    name: '',
    sessionId: '',
  })
  const numRef = useRef(1)
  const { device } = store

  useEffect(() => add(), [])

  function add() {
    const id = uuid()
    const shell = {
      id,
      name: `${t('shell')} ${numRef.current++}`,
      sessionId: '',
    }
    setShells((prev) => [...prev, shell])
    setSelectedShell(shell)
  }

  function close(id: string) {
    const closedShell = find(shells, (shell) => shell.id === id)
    let closedIdx = idxOf(shells, closedShell)
    const newShells = filter(shells, (shell) => shell.id !== id)
    // 函数式更新：连点关闭时两次计算不会基于同一份旧数组
    setShells((prev) => filter(prev, (shell) => shell.id !== id))

    if (closedShell === selectedShell) {
      // 关掉最后一个标签时 newShells 为空，closedIdx 会变成 -1：
      // 之后渲染 selectedShell.id 直接抛异常（整页变成「此页面出错」）
      if (!newShells.length) {
        setSelectedShell({ id: '', name: '', sessionId: '' })
        return
      }
      if (closedIdx >= newShells.length) {
        closedIdx = newShells.length - 1
      }
      setSelectedShell(newShells[Math.max(0, closedIdx)])
    }
  }

  const terms = map(shells, (shell) => {
    return (
      <Term
        key={shell.id}
        onSessionIdChange={(id) => {
          shell.sessionId = id
        }}
        onCreate={(terminal) => {
          shell.terminal = terminal
        }}
        visible={selectedShell.id === shell.id && store.panel === 'shell'}
      />
    )
  })

  const commands = map(getCommands(), ([title, command]) => {
    return {
      title: `${title} (${truncate(command, 95 - title.length)})`,
      handler: () => {
        // 没有活动标签（刚关掉最后一个/切设备）时 sessionId 为空：
        // 直接写会打到 undefined 会话，命令静默丢失
        if (!selectedShell.sessionId) return
        main.writeShell(selectedShell.sessionId, command)
        setTimeout(() => {
          if (selectedShell.terminal) {
            selectedShell.terminal.focus()
          }
        }, 500)
      },
    }
  })

  return (
    <Page>
      <PageToolbar className={Style.tabBar}>
        <div className={Style.tabsWrap}>
          {shells.map((shell) => (
            <div
              key={shell.id}
              className={
                Style.tab +
                (selectedShell.id === shell.id ? ' ' + Style.active : '')
              }
              onClick={() => setSelectedShell(shell)}
            >
              <span className={Style.tabName}>{shell.name}</span>
              <span
                className={Style.tabClose}
                title={t('close')}
                onClick={(e) => {
                  e.stopPropagation()
                  close(shell.id)
                }}
              >
                <span className="icon-x" />
              </span>
            </div>
          ))}
        </div>
        <ToolButton
          icon="icon-add"
          title={t('add')}
          onClick={add}
          disabled={!device}
        />
        <ToolSpace />
        <ToolButton
          icon="icon-list"
          label={t('shortcut')}
          title={t('shortcut')}
          onClick={() => setCommandPaletteVisible(true)}
          disabled={!device}
        />
      </PageToolbar>
      <PageBody className={Style.termBody}>
        {terms}
        <LunaCommandPalette
          placeholder={t('typeCmd')}
          visible={commandPaletteVisible}
          onClose={() => setCommandPaletteVisible(false)}
          commands={commands}
        />
      </PageBody>
    </Page>
  )
})

function getCommands() {
  const commands = [
    [t('reboot'), 'reboot\n'],
    [t('rebootRecovery'), 'reboot recovery\n'],
    [t('rebootBootloader'), 'reboot bootloader\n'],
    [t('memInfo'), 'dumpsys meminfo\n'],
    [t('batteryInfo'), 'dumpsys battery\n'],
    [
      `${t('start')} shizuku`,
      'sh /sdcard/Android/data/moe.shizuku.privileged.api/start.sh\n',
    ],
  ]

  if (store.language === 'zh-CN') {
    commands.push([
      '授权 GKD',
      'pm grant li.songe.gkd android.permission.WRITE_SECURE_SETTINGS; appops set li.songe.gkd ACCESS_RESTRICTED_SETTINGS allow\n',
    ])
  }

  return commands
}
