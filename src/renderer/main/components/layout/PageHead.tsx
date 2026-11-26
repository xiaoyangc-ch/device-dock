import { observer } from 'mobx-react-lite'
import store from '../../store'
import { t } from 'common/util'
import Style from './PageHead.module.scss'
import { isOnlineDevice } from '../../lib/util'

const TITLES: Record<string, string> = {
  connect: 'connectDevice',
  overview: 'overview',
  application: 'application',
  process: 'process',
  performance: 'performance',
  disk: 'disk',
  shell: 'shell',
  screenshot: 'screenshot',
  logcat: 'logcat',
}

/** 页面标题 + 当前设备状态条。文件页有自己的工具栏，不显示这里。 */
export default observer(function PageHead() {
  const online = isOnlineDevice(store.device)

  return (
    <header className={Style.head}>
      <div className={Style.title}>{t(TITLES[store.panel] || store.panel)}</div>
      <div className={Style.status}>
        <span className={online ? Style.dot : Style.dot + ' ' + Style.off} />
        {store.device ? (
          <>
            <span className={Style.name}>{store.device.name}</span>
            <span className={Style.text}>
              {online ? t('connected') : t('offline')}
            </span>
          </>
        ) : (
          <span className={Style.text}>{t('deviceNotConnected')}</span>
        )}
      </div>
    </header>
  )
})
