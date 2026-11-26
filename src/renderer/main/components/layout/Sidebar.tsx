import { observer } from 'mobx-react-lite'
import store from '../../store'
import { t } from 'common/util'
import Style from './Sidebar.module.scss'
import DeviceStage from './DeviceStage'
import SettingsModal from '../toolbar/SettingsModal'
import { isOnlineDevice } from '../../lib/util'

// 侧栏分组：设备（连接/概览/文件/应用）、系统（进程/性能/硬盘/终端）、采集（截屏/日志）
const GROUPS = [
  {
    label: 'groupDevice',
    items: [
      { panel: 'connect', icon: 'icon-wifi', label: 'connectDevice' },
      { panel: 'overview', icon: 'icon-monitor', label: 'overview' },
      { panel: 'file', icon: 'icon-folder', label: 'file' },
      { panel: 'application', icon: 'icon-grid', label: 'application' },
    ],
  },
  {
    label: 'groupSystem',
    items: [
      { panel: 'process', icon: 'icon-processor', label: 'process' },
      { panel: 'performance', icon: 'icon-activity', label: 'performance' },
      { panel: 'disk', icon: 'icon-storage', label: 'disk' },
      { panel: 'shell', icon: 'icon-terminal', label: 'shell' },
    ],
  },
  {
    label: 'groupCapture',
    items: [
      { panel: 'screenshot', icon: 'icon-camera', label: 'screenshot' },
      { panel: 'logcat', icon: 'icon-file-text', label: 'logcat' },
    ],
  },
]

export default observer(function Sidebar() {
  const collapsed = store.settings.sidebarCollapsed
  const online = store.devices.filter(isOnlineDevice).length

  return (
    <aside className={Style.sidebar + (collapsed ? ' ' + Style.collapsed : '')}>
      <div className={Style.brand}>
        <span className={Style.mark} />
        <span className={Style.brandText}>
          设备<em>坞</em>
        </span>
      </div>

      {/* 折叠时不渲染设备卡：预览循环会整段停掉，而不是在隐藏 DOM 里继续抓图 */}
      {!collapsed && <DeviceStage />}

      <nav className={Style.nav}>
        {GROUPS.map((group) => (
          <div key={group.label}>
            <div className={Style.navLabel}>{t(group.label)}</div>
            {group.items.map((item) => (
              <button
                key={item.panel}
                className={
                  Style.navItem +
                  (store.panel === item.panel ? ' ' + Style.active : '')
                }
                aria-current={store.panel === item.panel ? 'page' : undefined}
                title={collapsed ? t(item.label) : undefined}
                onClick={() => store.selectPanel(item.panel)}
              >
                <span className={item.icon} />
                <span className={Style.navText}>{t(item.label)}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className={Style.footer}>
        <span className={online ? Style.dot : Style.dot + ' ' + Style.off} />
        {store.devices.length ? (
          <span className={Style.footerText}>
            {t('devicesOnline', { count: store.devices.length, online })}
          </span>
        ) : (
          <span className={Style.footerText}>{t('deviceNotConnected')}</span>
        )}

        <span className={Style.grow} />
        <button
          className={Style.settings}
          title={t('settings')}
          onClick={() => store.openModal('settings')}
        >
          <span className="icon-setting" />
        </button>
        <button
          className={Style.collapseBtn}
          title={t(collapsed ? 'expandSidebar' : 'collapseSidebar')}
          onClick={() => store.settings.set('sidebarCollapsed', !collapsed)}
        >
          <span className="icon-panel-right" />
        </button>
      </div>

      <SettingsModal
        visible={store.activeModal === 'settings'}
        onClose={() => store.closeModal('settings')}
      />
    </aside>
  )
})
