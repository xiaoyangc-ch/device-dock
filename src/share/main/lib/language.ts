/**
 * 语言：settings.language 为 system 时跟随系统，否则按「完整 locale → 主语言」匹配。
 */
import { getSettingsStore } from '../../../main/lib/store'
import { i18n, hasLocale } from '../../common/i18n'
import { app } from 'electron'
import { handleEvent } from './util'
import log from '../../common/log'
import { IpcGetLanguage } from '../../common/types'

const logger = log('language')
const store = getSettingsStore()

let language = 'en-US'

export const get: IpcGetLanguage = () => language

function resolveLocale(locale: string) {
  if (hasLocale(locale)) return locale

  const [lang] = locale.split('-')
  if (hasLocale(lang)) return lang
}

export function init() {
  logger.info('init')

  const setting = store.get('language')
  const systemLanguage = resolveLocale(app.getLocale()) || 'en-US'
  language =
    setting === 'system'
      ? systemLanguage
      : resolveLocale(setting) || systemLanguage

  i18n.locale(language)
  handleEvent('getLanguage', get)
}
