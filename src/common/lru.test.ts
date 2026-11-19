import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LruCache } from './lru'

test('LRU：超过条目上限淘汰最久未使用项，命中会刷新顺序', () => {
  const cache = new LruCache<string, string>({ maxEntries: 2 })
  cache.set('a', 'A')
  cache.set('b', 'B')
  assert.equal(cache.get('a'), 'A')
  cache.set('c', 'C')
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 'A')
  assert.equal(cache.get('c'), 'C')
})

test('LRU：按字节权重淘汰，重复 set 不会重复累计', () => {
  const cache = new LruCache<string, string>({
    maxEntries: 10,
    maxBytes: 9,
    weight: (value) => value.length,
  })
  cache.set('a', '1234')
  cache.set('a', '12345')
  cache.set('b', '6789')
  assert.equal(cache.byteSize, 9)
  cache.set('c', 'x')
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('b'), '6789')
  assert.equal(cache.get('c'), 'x')
  assert.equal(cache.byteSize, 5)
})
