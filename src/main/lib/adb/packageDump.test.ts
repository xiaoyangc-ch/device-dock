import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPackageDumpCommand,
  normalizePackageTimestamp,
  parsePackageDump,
} from './packageDump'

test('麒麟 dumpsys 元数据：解析版本、时间和 SDK', () => {
  const parsed = parsePackageDump(`
__DEVICEDOCK_PACKAGE__com.android.settings
    versionCode=23 targetSdk=23
    versionName=6.0.1
    firstInstallTime=2026-11-20 10:30:00
    lastUpdateTime=2026-11-21 11:40:00
__DEVICEDOCK_PACKAGE__com.demo.app
    versionCode=1 targetSdk=22
    versionName=1.0
    minSdk=21
`)
  assert.deepEqual(parsed.get('com.android.settings'), {
    packageName: 'com.android.settings',
    versionName: '6.0.1',
    firstInstallTime: Date.parse('2026-11-20T10:30:00'),
    lastUpdateTime: Date.parse('2026-11-21T11:40:00'),
    targetSdkVersion: 23,
  })
  assert.equal(parsed.get('com.demo.app')?.minSdkVersion, 21)
  assert.equal(parsed.get('com.demo.app')?.targetSdkVersion, 22)
})

test('dumpsys 命令：过滤非法包名并保留合法包', () => {
  const command = buildPackageDumpCommand([
    'com.android.settings',
    'com.demo;reboot',
  ])
  assert.match(command, /com\.android\.settings/)
  assert.doesNotMatch(command, /reboot/)
})

test('麒麟异常时间：1970 年视为未设置', () => {
  assert.equal(normalizePackageTimestamp(79000), 0)
  assert.equal(
    normalizePackageTimestamp(Date.parse('2026-11-20T10:30:00')),
    Date.parse('2026-11-20T10:30:00'),
  )
})
