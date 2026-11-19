import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCurrentUser,
  parsePackageListing,
  parsePackagePaths,
  parseTopPackage,
} from './packageParse'

test('当前用户：兼容纯数字和 Huawei Current user 输出', () => {
  assert.equal(parseCurrentUser('0\n'), 0)
  assert.equal(parseCurrentUser('Current user: 10'), 10)
  assert.equal(parseCurrentUser('Error: unknown command'), null)
})

test('包列表：兼容带路径、不带路径和 Huawei 多余空格', () => {
  assert.deepEqual(
    parsePackageListing(
      [
        'package:/data/app/~~abc==/com.demo-1/base.apk=com.demo versionCode:123',
        'package:com.vendor.app  versionCode: 456',
        'package:/data/app/com.noversion/base.apk=com.noversion',
        'package:/data/app/~~abc==/com.demo-1/base.apk=com.demo versionCode:123',
        'Error: unknown option',
      ].join('\n')
    ),
    [
      {
        name: 'com.demo',
        path: '/data/app/~~abc==/com.demo-1/base.apk',
        versionCode: '123',
      },
      {
        name: 'com.vendor.app',
        path: '',
        versionCode: '456',
      },
      {
        name: 'com.noversion',
        path: '/data/app/com.noversion/base.apk',
        versionCode: '',
      },
    ]
  )
})

test('APK 路径：支持 pm path 的分包输出并去重', () => {
  assert.deepEqual(
    parsePackagePaths(
      [
        'package:/data/app/~~abc==/com.demo-1/base.apk',
        'package:/data/app/~~abc==/com.demo-1/split_config.arm64_v8a.apk',
        'package:/data/app/~~abc==/com.demo-1/base.apk',
        'Error: package not found',
      ].join('\n')
    ),
    [
      '/data/app/~~abc==/com.demo-1/base.apk',
      '/data/app/~~abc==/com.demo-1/split_config.arm64_v8a.apk',
    ]
  )
})

test('前台应用：标准 top-activity 保留 PID', () => {
  assert.deepEqual(
    parseTopPackage(
      'mFocusedApp=... top-activity ActivityRecord{2f9 u0 com.demo/.Main t42}'
    ),
    { name: 'com.demo', pid: 0 }
  )
  assert.deepEqual(
    parseTopPackage(
      '  top-activity=ActivityRecord{abc u0 1234:com.demo/.Main t42}'
    ),
    { name: 'com.demo', pid: 1234 }
  )
})

test('前台应用：Huawei mResumedActivity 格式', () => {
  const output =
    'mResumedActivity: ActivityRecord{e2c12d u0 com.huawei.android.launcher/.unihome.UniHomeFlowActivity t12}'
  assert.deepEqual(parseTopPackage(output), {
    name: 'com.huawei.android.launcher',
    pid: 0,
  })
})

test('前台应用：Huawei window mCurrentFocus 格式', () => {
  const output =
    'mCurrentFocus=Window{45a u0 com.shinektv.vod/com.shinektv.vod.PlayerActivity}'
  assert.deepEqual(parseTopPackage(output), {
    name: 'com.shinektv.vod',
    pid: 0,
  })
})

test('前台应用：未知输出返回空值', () => {
  assert.deepEqual(parseTopPackage('nothing useful'), { name: '', pid: 0 })
})
