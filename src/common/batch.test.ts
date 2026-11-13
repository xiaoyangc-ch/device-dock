import { test } from 'node:test'
import assert from 'node:assert/strict'
import { takeBatch } from './batch'

test('预算充足时整批放行', () => {
  assert.deepEqual(takeBatch([1, 2, 3], 0, 10), [1, 2, 3])
})

test('预算不足时只取剩余额度', () => {
  assert.deepEqual(takeBatch([1, 2, 3, 4, 5], 8, 10), [1, 2])
})

test('额度用尽后不再推送（但内存里的 pending 由调用方清空）', () => {
  assert.deepEqual(takeBatch([1, 2, 3], 10, 10), [])
  assert.deepEqual(takeBatch([1, 2, 3], 11, 10), [])
})

test('空批返回空数组', () => {
  assert.deepEqual(takeBatch([], 0, 10), [])
})

test('max 为 0 时不推任何东西', () => {
  assert.deepEqual(takeBatch([1, 2], 0, 0), [])
})
