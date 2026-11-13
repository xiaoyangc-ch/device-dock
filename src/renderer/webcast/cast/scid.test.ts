import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeScid } from './scid'

test('scid：同一设备同一秒内稳定（同一次会话重试不会换 socket 名）', () => {
  const now = 1_700_000_000_000
  assert.equal(makeScid('66.66.1.38:5555', now), makeScid('66.66.1.38:5555', now))
})

test('scid：跨秒变化（新会话不复用上一次的 socket 名）', () => {
  const a = makeScid('66.66.1.38:5555', 1_700_000_000_000)
  const b = makeScid('66.66.1.38:5555', 1_700_000_001_000)
  assert.notEqual(a, b)
})

test('scid：不同设备给出不同值', () => {
  const now = 1_700_000_000_000
  assert.notEqual(
    makeScid('66.66.1.38:5555', now),
    makeScid('77.77.0.100:5555', now)
  )
})

test('scid：始终是 1..999999 的正整数，且能补零成 8 位十六进制', () => {
  const samples = [
    '',
    'a',
    '66.66.1.38:5555',
    '77.77.0.100:5555',
    'ca6a9c48d2ad2896',
    '\u4e2d\u6587\u8bbe\u5907',
    'x'.repeat(200),
  ]
  for (const id of samples) {
    for (const now of [0, 1, 1_700_000_000_000, 4_102_444_800_000]) {
      const scid = makeScid(id, now)
      assert.match(scid, /^\d{1,6}$/, `scid=${scid} for ${id}@${now}`)
      const n = Number(scid)
      assert.ok(n >= 1 && n <= 999999, `范围越界: ${scid}`)
      assert.match(
        (n >>> 0).toString(16).padStart(8, '0'),
        /^[0-9a-f]{8}$/,
        `socket 名不合法: ${scid}`
      )
    }
  }
})

test('scid：不为 0（0 是 scrcpy 默认值，会撞残留 server）', () => {
  // 构造 hash 绝对值能被 999999 整除的输入不容易，直接扫一批时间点
  for (let t = 0; t < 200; t++) {
    const scid = makeScid('66.66.1.38:5555', t * 1000)
    assert.notEqual(scid, '0')
  }
})

test('scid：空 deviceId 也不崩', () => {
  assert.match(makeScid('', 1_700_000_000_000), /^\d+$/)
})
