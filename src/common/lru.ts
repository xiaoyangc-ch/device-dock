interface ILruOptions<V> {
  maxEntries: number
  maxBytes?: number
  weight?: (value: V) => number
}

/** 插入顺序即 LRU 顺序；get 与重复 set 都会把条目移到队尾。 */
export class LruCache<K, V> {
  private readonly map = new Map<K, { value: V; bytes: number }>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly weight: (value: V) => number
  private usedBytes = 0

  constructor(options: ILruOptions<V>) {
    this.maxEntries = Math.max(1, options.maxEntries)
    this.maxBytes = Math.max(0, options.maxBytes ?? 0)
    this.weight = options.weight || (() => 0)
  }

  get size() {
    return this.map.size
  }

  get byteSize() {
    return this.usedBytes
  }

  keys() {
    return this.map.keys()
  }

  *entries(): IterableIterator<[K, V]> {
    for (const [key, entry] of this.map) {
      yield [key, entry.value]
    }
  }

  has(key: K) {
    return this.map.has(key)
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  set(key: K, value: V) {
    this.delete(key)
    const bytes = Math.max(0, this.weight(value))
    this.map.set(key, { value, bytes })
    this.usedBytes += bytes
    this.trim()
  }

  delete(key: K) {
    const entry = this.map.get(key)
    if (!entry) return false
    this.usedBytes -= entry.bytes
    return this.map.delete(key)
  }

  clear() {
    this.map.clear()
    this.usedBytes = 0
  }

  private trim() {
    while (
      this.map.size > this.maxEntries ||
      (this.maxBytes > 0 && this.usedBytes > this.maxBytes)
    ) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }
}
