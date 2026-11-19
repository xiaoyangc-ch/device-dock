import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTrustedAppUrl } from './appUrl'

const appUrl = 'file:///Applications/%E8%AE%BE%E5%A4%87%E5%9D%9E/app.asar/renderer/index.html'

test('应用来源：只允许当前 renderer/index.html', () => {
  assert.equal(isTrustedAppUrl(appUrl + '?page=webcast', appUrl), true)
  assert.equal(isTrustedAppUrl('file:///tmp/attack.html', appUrl), false)
  assert.equal(
    isTrustedAppUrl('file:///Applications/%E8%AE%BE%E5%A4%87%E5%9D%9E/app.asar/renderer/other.html', appUrl),
    false
  )
})

test('应用来源：开发服务器只允许固定 origin 和入口路径', () => {
  assert.equal(isTrustedAppUrl('http://localhost:8080/?page=shell', appUrl), true)
  assert.equal(isTrustedAppUrl('http://127.0.0.1:8080/index.html', appUrl), false)
  assert.equal(isTrustedAppUrl('http://localhost:8081/', appUrl), false)
  assert.equal(isTrustedAppUrl('http://localhost:8080/evil.html', appUrl), false)
})

test('应用来源：拒绝外部协议和畸形 URL', () => {
  assert.equal(isTrustedAppUrl('https://example.com/', appUrl), false)
  assert.equal(isTrustedAppUrl('javascript:alert(1)', appUrl), false)
  assert.equal(isTrustedAppUrl('not a url', appUrl), false)
})
