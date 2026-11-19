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
    bytes: Buffer.from([1, 2, 3]),
    nested: [{ token: 'nope', ok: true }],
  })
  const text = JSON.stringify(value)
  assert.equal(text.includes('abcdef'), false)
  assert.equal(text.includes('plain-secret'), false)
  assert.match(text, /\[bytes:3\]/)
  assert.match(redactText('Authorization: Bearer abc'), /\[REDACTED\]/)
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

test('操作记录：固定上限不会无限增长', () => {
  for (let i = 0; i < 230; i++) finishOperation(startOperation(`cap-${i}`, []))
  assert.equal(getOperationSnapshot().length, 200)
})
