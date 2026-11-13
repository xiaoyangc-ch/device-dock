import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import store from '../../store'
import { t } from 'common/util'
import Style from './Sidebar.module.scss'
import DeviceStage from './DeviceStage'
import SettingsModal from '../toolbar/SettingsModal'

const groups = [
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
  const [settingsVisible, setSettingsVisible] = useState(false)
  const online = store.devices.filter((d) => d.type !== 'offline').length
  const collapsed = store.settings.sidebarCollapsed

  return (
    <aside className={Style.sidebar + (collapsed ? ' ' + Style.collapsed : '')}>
      <div className={Style.brand}>
        <span className={Style.mark} />
        <span className={Style.brandText}>
          设备<em>坞</em>
        </span>
      </div>

      {/* 折叠时不渲染设备卡：预览循环会整段停掉，而不是在隐藏的 DOM 里继续抓图 */}
      {!collapsed && <DeviceStage />}

      <nav className={Style.nav}>
        {groups.map((group) => (
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
        <span
          className={
            store.devices.length ? Style.dot : Style.dot + ' ' + Style.off
          }
        />
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
          onClick={() => setSettingsVisible(true)}
        >
          <span className="icon-setting" />
        </button>
        <button
          className={Style.collapseBtn}
          title={t(collapsed ? 'expandSidebar' : 'collapseSidebar')}
          onClick={() =>
            store.settings.set('sidebarCollapsed', !collapsed)
          }
        >
          <span className="icon-panel-right" />
        </button>
      </div>

      <SettingsModal
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
      />
    </aside>
  )
})
