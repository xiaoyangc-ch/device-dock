/**
 * 终端页：多标签 adb shell，每个标签一个独立会话。
 * 标签全部隐藏而不是卸载（xterm 实例和 shell 会话很贵），只在切走时 display:none。
 */
import { observer } from 'mobx-react-lite'
import Term from './Term'
import { t } from 'common/util'
import store from '../../store'
import Style from './Shell.module.scss'
import { useEffect, useRef, useState } from 'react'
import uuid from 'licia/uuid'
import LunaCommandPalette from 'luna-command-palette/react'
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

const EMPTY_SHELL: IShell = { id: '', name: '', sessionId: '' }

function getCommands() {
  const commands: Array<[string, string]> = [
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

export default observer(function Shell() {
  const [shells, setShells] = useState<IShell[]>([])
  const [paletteVisible, setPaletteVisible] = useState(false)
  const [selected, setSelected] = useState<IShell>(EMPTY_SHELL)
  const numRef = useRef(1)
  const { device } = store

  useEffect(() => add(), [])

  function add() {
    const shell: IShell = {
      id: uuid(),
      name: `${t('shell')} ${numRef.current++}`,
      sessionId: '',
    }
    setShells((prev) => [...prev, shell])
    setSelected(shell)
  }

  function close(id: string) {
    const closed = shells.find((shell) => shell.id === id)
    const closedIndex = shells.findIndex((shell) => shell.id === id)
    const remaining = shells.filter((shell) => shell.id !== id)

    // 函数式更新：连点关闭时两次计算不会基于同一份旧数组
    setShells((prev) => prev.filter((shell) => shell.id !== id))

    if (closed !== selected) return

    // 关掉最后一个标签时 remaining 为空，索引会变 -1：
    // 之后渲染 selected.id 直接抛异常（整页「此页面出错」）
    if (!remaining.length) {
      setSelected(EMPTY_SHELL)
      return
    }

    const nextIndex = Math.min(
      closedIndex >= 0 ? closedIndex : 0,
      remaining.length - 1
    )
    setSelected(remaining[Math.max(0, nextIndex)])
  }

  const commands = getCommands().map(([title, command]) => ({
    title: `${title} (${truncate(command, 95 - title.length)})`,
    handler: () => {
      // 没有活动标签（刚关掉最后一个/切设备）时 sessionId 为空：
      // 直接写会打到 undefined 会话，命令静默丢失
      if (!selected.sessionId) return

      main.writeShell(selected.sessionId, command)
      // 命令回显后才聚焦：立刻 focus 会把光标抢在输出前面
      setTimeout(() => selected.terminal?.focus(), 500)
    },
  }))

  return (
    <Page>
      <PageToolbar className={Style.tabBar}>
        <div className={Style.tabsWrap}>
          {shells.map((shell) => (
            <div
              key={shell.id}
              className={
                Style.tab + (selected.id === shell.id ? ' ' + Style.active : '')
              }
              onClick={() => setSelected(shell)}
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
          onClick={() => setPaletteVisible(true)}
          disabled={!device}
        />
      </PageToolbar>
      <PageBody className={Style.termBody}>
        {shells.map((shell) => (
          <Term
            key={shell.id}
            onSessionIdChange={(id) => {
              shell.sessionId = id
            }}
            onCreate={(terminal) => {
              shell.terminal = terminal
            }}
            visible={selected.id === shell.id && store.panel === 'shell'}
          />
        ))}
        <LunaCommandPalette
          placeholder={t('typeCmd')}
          visible={paletteVisible}
          onClose={() => setPaletteVisible(false)}
          commands={commands}
        />
      </PageBody>
    </Page>
  )
})
