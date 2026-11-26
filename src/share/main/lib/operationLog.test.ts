import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  finishOperation,
  getOperationSnapshot,
  redactText,
  sanitizeForDiagnostics,
  startOperation,
} from './operationLog'

test('诊断脱敏：URL token、密码和二进制内容不进入记录', () => {
  const value = sanitizeForDiagnostics({
    url: 'http://127.0.0.1/preview?token=abcdef&x=1',
    password: 'plain-secret',
    pwd: 'legacy-secret',
    accessToken: 'access-secret',
    refresh_token: 'refresh-secret',
    bytes: Buffer.from([1, 2, 3]),
    nested: [{ token: 'nope', ok: true }],
  })
  const text = JSON.stringify(value)
  assert.equal(text.includes('abcdef'), false)
  assert.equal(text.includes('plain-secret'), false)
  assert.equal(text.includes('legacy-secret'), false)
  assert.equal(text.includes('access-secret'), false)
  assert.equal(text.includes('refresh-secret'), false)
  assert.match(text, /\[bytes:3\]/)
  assert.match(redactText('Authorization: Bearer abc'), /\[REDACTED\]/)
  assert.doesNotMatch(
    redactText(
      'file:///app/index.html?page=video&videoUrl=http%3A%2F%2F127.0.0.1%3Fx%3D1%26token%3Dencoded-secret',
    ),
    /encoded-secret/,
  )
  const nestedEncoded = redactText(
    'file:///app/index.html?page=video&videoUrl=http%3A%2F%2F127.0.0.1%3Ftoken%3Dhead%252Ftail%26x%3D1',
  )
  assert.doesNotMatch(nestedEncoded, /head|tail/)
  assert.match(nestedEncoded, /x%3D1/)
})

test('操作记录：完成和失败都保留操作 ID、耗时及错误', async () => {
  const okId = startOperation('testOk', [{ id: 1 }])
  await new Promise((resolve) => setTimeout(resolve, 2))
  finishOperation(okId)
  const errorId = startOperation('testError', [])
  finishOperation(errorId, new Error('boom token=secret'))

  const records = getOperationSnapshot()
  const ok = records.find((item) => item.id === okId)
  const failed = records.find((item) => item.id === errorId)
  assert.equal(ok?.status, 'ok')
  assert.ok((ok?.durationMs || 0) >= 0)
  assert.equal(failed?.status, 'error')
  assert.match(failed?.error || '', /boom/)
  assert.equal((failed?.error || '').includes('secret'), false)
})

test('操作记录：位置参数中的密码和配对码不会进入诊断快照', () => {
  const loginId = startOperation('apmLogin', ['demo-user', 'login-password'])
  finishOperation(loginId)
  const pairId = startOperation('pairDevice', ['192.168.1.2', 37000, '654321'])
  finishOperation(pairId)

  const text = JSON.stringify(getOperationSnapshot())
  assert.equal(text.includes('login-password'), false)
  assert.equal(text.includes('654321'), false)
  assert.match(text, /demo-user/)
})

test('操作记录：固定上限不会无限增长', () => {
  for (let i = 0; i < 230; i++) finishOperation(startOperation(`cap-${i}`, []))
  assert.equal(getOperationSnapshot().length, 200)
})
