import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertDeletable, assertPackageName } from './guards'

test('删除守卫：拒绝设备盘根与内部存储根', () => {
  const blocked = [
    '/',
    '/sdcard',
    '/storage',
    '/storage/emulated',
    '/storage/emulated/0',
    '/data',
    '/data/media',
    '/data/media/0',
    '/mnt',
    '/system',
    '/vendor',
    '/product',
    '/apex',
    // 末尾带斜杠也要拦住
    '/sdcard/',
    '/data/media/0/',
    // 只删顶层目录一律拒绝
    '/oem',
  ]
  for (const path of blocked) {
    assert.throws(
      () => assertDeletable(path),
      /拒绝删除/,
      `应当拒绝：${path}`
    )
  }
})

test('删除守卫：正常的两级以上路径放行', () => {
  const allowed = [
    '/sdcard/Download',
    '/sdcard/DCIM/Camera/a.jpg',
    '/storage/emulated/0/Download',
    '/data/local/tmp/x',
    '/data/media/0/Movies',
  ]
  for (const path of allowed) {
    assert.doesNotThrow(() => assertDeletable(path), `不应拒绝：${path}`)
  }
})

test('删除守卫：末尾斜杠归一化后同样受保护', () => {
  assert.throws(() => assertDeletable('/data/media/0///'), /拒绝删除/)
  assert.doesNotThrow(() => assertDeletable('/sdcard/Download/'))
})

test('包名：正常包名通过', () => {
  for (const pkg of [
    'com.android.settings',
    'com.shinektv.vod',
    'a',
    'a_b.c1',
    'com.example.app_2',
  ]) {
    assert.doesNotThrow(() => assertPackageName(pkg), `不应拒绝：${pkg}`)
  }
})

test('包名：拒绝注入与畸形输入', () => {
  const bad = [
    '',
    'com.a; rm -rf /',
    'com.a$(id)',
    'com.a`id`',
    'com a',
    'com.a|cat /etc/passwd',
    'com.a\nreboot',
    '../etc/passwd',
    '.leading.dot',
    'a'.repeat(256),
  ]
  for (const pkg of bad) {
    assert.throws(
      () => assertPackageName(pkg),
      /非法包名/,
      `应当拒绝：${JSON.stringify(pkg)}`
    )
  }
})
