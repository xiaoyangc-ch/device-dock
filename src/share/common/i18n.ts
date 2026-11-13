/**
 * 共享层文案：只有 main/preload 需要的少量 key（菜单、进程面板）。
 * 界面文案在 src/common/langs 里，由各页面自己的 i18n 实例加载。
 */
import I18n from 'licia/I18n'
import defaults from 'licia/defaults'
import enUS from './langs/en-US.json'
import zhCN from './langs/zh-CN.json'
import types from 'licia/types'
import keys from 'licia/keys'
import contain from 'licia/contain'
import unique from 'licia/unique'
import concat from 'licia/concat'

const langs: types.PlainObj<any> = {
  'en-US': enUS,
  // 中文缺的 key 用英文补齐，避免界面出现空白
  'zh-CN': defaults(zhCN, enUS),
}

let locales = keys(langs)

export const i18n = new I18n('en-US', langs)

export function init(extra: types.PlainObj<any>) {
  locales = unique(concat(locales, keys(extra)))
  for (const locale of keys(extra)) {
    i18n.set(locale, extra[locale])
  }
}

export function hasLocale(locale: string) {
  return contain(locales, locale)
}

export function t(path: string | string[], data?: types.PlainObj<any>) {
  return i18n.t(path, data)
}
