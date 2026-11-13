import { observer } from 'mobx-react-lite'
import store from '../../store'
import { t } from 'common/util'
import Style from './PageHead.module.scss'

const titles: Record<string, string> = {
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

export default observer(function PageHead() {
  const online = store.device && store.device.type !== 'offline'

  return (
    <header className={Style.head}>
      <div className={Style.title}>
        {t(titles[store.panel] || store.panel)}
      </div>
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
