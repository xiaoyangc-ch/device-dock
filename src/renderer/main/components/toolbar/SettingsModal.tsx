/**
 * 设置弹窗：外观（主题/语言/原生标题栏）、ADB 路径、退出时是否结束 adb。
 * 语言和标题栏改动需要重启窗口才能完全生效，所以提示「重启应用」。
 */
import LunaModal from 'luna-modal/react'
import LunaSetting, {
  LunaSettingButton,
  LunaSettingCheckbox,
  LunaSettingSelect,
  LunaSettingSeparator,
  LunaSettingTitle,
} from 'luna-setting/react'
import { notify } from 'share/renderer/lib/util'
import { t } from 'common/util'
import Style from './SettingsModal.module.scss'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import debounce from 'licia/debounce'
import SettingPath from 'share/renderer/components/SettingPath'
import store from '../../store'
import { IModalProps } from 'share/common/types'

const RELOAD_KEYS = ['language', 'useNativeTitlebar']

// 连续切换主题/语言时会连发多次：1 秒内合并成一条提示
const notifyRequireReload = debounce(() => {
  notify(t('requireReload'), { icon: 'info' })
}, 1000)

export default observer(function SettingsModal(props: IModalProps) {
  function onChange(key: string, value: any) {
    if (RELOAD_KEYS.includes(key)) notifyRequireReload()
    store.settings.set(key, value)
  }

  return createPortal(
    <LunaModal
      title={t('settings')}
      width={400}
      visible={props.visible}
      onClose={props.onClose}
    >
      <LunaSetting className={Style.settingsPanel} onChange={onChange}>
        <LunaSettingTitle title={t('appearance')} />
        <LunaSettingSelect
          keyName="theme"
          value={store.settings.theme}
          title={t('theme')}
          options={{
            [t('sysPreference')]: 'system',
            [t('light')]: 'light',
            [t('dark')]: 'dark',
          }}
        />
        <LunaSettingSelect
          keyName="language"
          value={store.settings.language}
          title={t('language')}
          options={{
            [t('sysPreference')]: 'system',
            ['العربية']: 'ar',
            English: 'en-US',
            ['Français']: 'fr',
            ['Português']: 'pt',
            ['Español']: 'es',
            ['Русский']: 'ru',
            ['Türkçe']: 'tr',
            ['中文']: 'zh-CN',
            ['繁體中文']: 'zh-TW',
          }}
        />
        <LunaSettingCheckbox
          keyName="useNativeTitlebar"
          value={store.settings.useNativeTitlebar}
          description={t('useNativeTitlebar')}
        />
        <LunaSettingSeparator />
        <LunaSettingTitle title="ADB" />
        <SettingPath
          title={t('adbPath')}
          value={store.settings.adbPath}
          onChange={(value) => {
            notifyRequireReload()
            store.settings.set('adbPath', value)
          }}
          options={{ properties: ['openFile'] }}
        />
        <LunaSettingCheckbox
          keyName="killAdbWhenExit"
          value={store.settings.killAdbWhenExit}
          description={t('killAdbWhenExit')}
        />
        <LunaSettingButton
          description={t('restartApp')}
          onClick={() => main.relaunch()}
        />
      </LunaSetting>
    </LunaModal>,
    document.body
  )
})
