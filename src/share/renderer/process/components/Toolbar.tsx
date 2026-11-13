import { observer } from 'mobx-react-lite'
import LunaToolbar, {
  LunaToolbarInput,
  LunaToolbarSeparator,
  LunaToolbarSpace,
  LunaToolbarText,
} from 'luna-toolbar/react'
import store from '../store'
import { t } from '../../../common/i18n'
import ToolbarIcon from '../../components/ToolbarIcon'
import LunaModal from 'luna-modal'
import { isDev } from '../../../common/util'
import toBool from 'licia/toBool'
import Style from './Toolbar.module.scss'

export default observer(function Toolbar() {
  async function stop() {
    const process = store.process!
    const confirmed = await LunaModal.confirm(
      t('killProcessConfirm', { name: process.name })
    )
    if (!confirmed) return

    main.killProcess(process.pid)
    store.refresh()
  }

  function inspect() {
    const process = store.process!
    // 渲染进程有自己的 devtools；主进程要走 --inspect，只有 dev 下开得起来
    if (process.webContentsId) {
      main.openDevtools(process.webContentsId)
    } else {
      main.debugMainProcess()
    }
  }

  const current = store.process
  const canInspect = current
    ? toBool(current.webContentsId || (isDev() && current.type === 'Browser'))
    : false

  return (
    <LunaToolbar className={Style.processToolbar}>
      <LunaToolbarInput
        keyName="filter"
        value={store.filter}
        placeholder={t('filter')}
        onChange={(val) => store.setFilter(val)}
      />
      <LunaToolbarText
        text={t('totalProcess', { total: store.processes.length })}
      />
      <LunaToolbarSpace />
      <ToolbarIcon
        disabled={!canInspect}
        icon="debug"
        title={t('inspect')}
        onClick={inspect}
      />
      <LunaToolbarSeparator />
      <ToolbarIcon
        disabled={store.process === null}
        icon="delete"
        title={t('stop')}
        onClick={stop}
      />
    </LunaToolbar>
  )
})
