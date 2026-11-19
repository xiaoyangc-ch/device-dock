import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeDevicePath,
  joinDevicePath,
  shellQuotePath,
} from './filePath'

test('设备 shell 路径引用：单引号、$ 和反引号不会执行', () => {
  assert.equal(shellQuotePath("/sdcard/a'b"), "'/sdcard/a'\\''b'")
  assert.equal(shellQuotePath('/sdcard/$(id)'), "'/sdcard/$(id)'")
  assert.equal(shellQuotePath('/sdcard/`id`'), "'/sdcard/`id`'")
})

test('设备路径拼接：根目录不会产生双斜杠', () => {
  assert.equal(joinDevicePath('/', 'a'), '/a')
  assert.equal(joinDevicePath('/sdcard/', 'a'), '/sdcard/a')
})

test('设备 URL 路径：#、?、+ 和空格均按段编码', () => {
  assert.equal(
    encodeDevicePath('/sdcard/a #?+.txt'),
    '/sdcard/a%20%23%3F%2B.txt'
  )
})
