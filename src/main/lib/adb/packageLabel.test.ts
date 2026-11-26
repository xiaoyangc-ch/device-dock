import assert from 'node:assert/strict'
import test from 'node:test'
import { packageLabelFallback } from './packageLabel'

test('应用名回退：常见系统包和自定义包名都可读', () => {
  assert.equal(packageLabelFallback('com.android.settings'), 'Settings')
  assert.equal(packageLabelFallback('com.vendor.musicPlayer'), 'Music Player')
  assert.equal(packageLabelFallback('com.ycserver.s3'), 'S3')
  assert.equal(packageLabelFallback('custom_app'), 'Custom app')
})
