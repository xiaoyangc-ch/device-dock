import { test } from 'node:test'
import assert from 'node:assert/strict'
import enUS from './langs/en-US.json'
import { i18n, t } from './util'

const LOCALES = [
  'ar',
  'en-US',
  'es',
  'fr',
  'pt',
  'ru',
  'tr',
  'zh-CN',
  'zh-TW',
]

function flattenKeys(
  value: Record<string, unknown>,
  prefix = '',
  out: string[] = []
) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flattenKeys(child as Record<string, unknown>, path, out)
    } else {
      out.push(path)
    }
  }
  return out
}

test('多语言：所有已发布 locale 都能解析英文主字典的每个键', () => {
  const keys = flattenKeys(enUS)
  for (const locale of LOCALES) {
    i18n.locale(locale)
    for (const key of keys) {
      const text = t(key)
      assert.equal(
        typeof text,
        'string',
        `${locale} 缺少字符串键 ${key}`
      )
      assert.notEqual(text, key, `${locale} 未提供 ${key} 的文案或英文兜底`)
    }
  }
  i18n.locale('en-US')
})
