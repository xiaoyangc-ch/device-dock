import assert from 'node:assert/strict'
import test from 'node:test'
import { retryOnce } from './retry'

test('retryOnce：第一次失败后自动重试一次', async () => {
  let calls = 0
  const value = await retryOnce(async () => {
    calls++
    if (calls === 1) throw new Error('temporary')
    return 'ok'
  }, 0)
  assert.equal(value, 'ok')
  assert.equal(calls, 2)
})

test('retryOnce：连续失败时保留第二次错误', async () => {
  let calls = 0
  await assert.rejects(
    retryOnce(async () => {
      calls++
      throw new Error(`failed-${calls}`)
    }, 0),
    /failed-2/,
  )
})
