import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml } from './html'
import { parseFrpcPid, decodeAdbOutput } from './adbParse'

test('escapeHtml：设备名里的标签被转义', () => {
  assert.equal(
    escapeHtml('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;'
  )
  assert.equal(escapeHtml(`a&b"c'd`), 'a&amp;b&quot;c&#39;d')
  assert.equal(escapeHtml('普通中文路径 /sdcard/a b.apk'), '普通中文路径 /sdcard/a b.apk')
})

test('parseFrpcPid：命中 frpc.ini 的真实 ps 行', () => {
  const ps = [
    'root      1234  1     123456 7890 0    0   S frpc',
    'root      4321  1     123456 7890 0    0   S /frp/frpc -c /frp/frpc.ini',
  ].join('\n')
  assert.equal(parseFrpcPid(ps), '4321')
})

test('parseFrpcPid：跳过 grep 自身与业务进程', () => {
  const ps = [
    'root      111  1  1 1 0 0 S grep frp',
    'root      222  1  1 1 0 0 S com.shinektv.vod:frpc',
    'root      333  1  1 1 0 0 S /data/frp/./frpc -c frpc.ini',
  ].join('\n')
  assert.equal(parseFrpcPid(ps), '333')
})

test('parseFrpcPid：没有 frpc 时返回 null', () => {
  assert.equal(parseFrpcPid(''), null)
  assert.equal(parseFrpcPid('root 1 1 1 1 0 0 S init'), null)
})

test('decodeAdbOutput：UTF-8 原样输出', () => {
  const buf = Buffer.from('中文 /sdcard/音乐.mp3', 'utf8')
  assert.equal(decodeAdbOutput([buf]), '中文 /sdcard/音乐.mp3')
})

test('decodeAdbOutput：整段 GBK（Windows adb.exe）也能正确解码', () => {
  // “中文” 的 GBK 字节，不是合法 UTF-8
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  assert.equal(decodeAdbOutput([gbk]), '中文')
})

test('decodeAdbOutput：分块输入按整段判定，不会切坏汉字', () => {
  const buf = Buffer.from('中文', 'utf8')
  const chunks = [buf.subarray(0, 2), buf.subarray(2)]
  assert.equal(decodeAdbOutput(chunks), '中文')
})

test('decodeAdbOutput：空输入返回空串', () => {
  assert.equal(decodeAdbOutput([]), '')
})
