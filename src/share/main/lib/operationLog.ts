import { randomUUID } from 'node:crypto'

const MAX_OPERATIONS = 200
const MAX_TEXT = 4000
const MAX_DEPTH = 5
const MAX_ARRAY = 30
const SENSITIVE_KEY =
  /^(?:authorization|cookie|data|password|passwd|secret|token)$/i

export const OPERATION_SESSION_ID = randomUUID()

export interface IOperationRecord {
  id: string
  channel: string
  status: 'pending' | 'ok' | 'error'
  startedAt: string
  endedAt?: string
  durationMs?: number
  args?: unknown
  error?: string
}

const records: IOperationRecord[] = []
const active = new Map<
  string,
  { record: IOperationRecord; startedMs: number }
>()

export function redactText(value: unknown, maxLength = MAX_TEXT) {
  let text = typeof value === 'string' ? value : String(value ?? '')
  text = text
    .replace(
      /([?&;](?:authorization|cookie|password|passwd|secret|token)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b(authorization|password|passwd|secret|token)\s*[:=]\s*[^\s,]+/gi,
      '$1=[REDACTED]',
    )
  return text.length > maxLength
    ? text.slice(0, maxLength) + '…[truncated]'
    : text
}

export function sanitizeForDiagnostics(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function') return '[Function]'
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: redactText(value.stack || '', 8000),
    }
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[bytes:${value.byteLength}]`
  }
  if (depth >= MAX_DEPTH) return '[MaxDepth]'

  const object = value as object
  if (seen.has(object)) return '[Circular]'
  seen.add(object)

  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_ARRAY)
      .map((item) => sanitizeForDiagnostics(item, depth + 1, seen))
    if (value.length > MAX_ARRAY)
      result.push(`[${value.length - MAX_ARRAY} more]`)
    return result
  }

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key)
      ? '[REDACTED]'
      : sanitizeForDiagnostics(child, depth + 1, seen)
  }
  return result
}

export function startOperation(channel: string, args: unknown[]) {
  const record: IOperationRecord = {
    id: randomUUID(),
    channel,
    status: 'pending',
    startedAt: new Date().toISOString(),
    args: sanitizeForDiagnostics(args),
  }
  records.push(record)
  active.set(record.id, { record, startedMs: Date.now() })
  while (records.length > MAX_OPERATIONS) {
    const removed = records.shift()
    if (removed) active.delete(removed.id)
  }
  return record.id
}

export function finishOperation(id: string, error?: unknown) {
  const item = active.get(id)
  if (!item) return
  active.delete(id)
  item.record.durationMs = Date.now() - item.startedMs
  item.record.endedAt = new Date().toISOString()
  if (error === undefined) {
    item.record.status = 'ok'
  } else {
    item.record.status = 'error'
    item.record.error = redactText(
      error instanceof Error ? error.stack || error.message : error,
      8000,
    )
  }
}

export function getOperationSnapshot() {
  return records.map((record) => ({
    ...record,
    args: sanitizeForDiagnostics(record.args),
  }))
}
