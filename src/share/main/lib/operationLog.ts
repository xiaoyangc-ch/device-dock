import { randomUUID } from 'node:crypto'

const MAX_OPERATIONS = 200
const MAX_TEXT = 4000
const MAX_DEPTH = 5
const MAX_ARRAY = 30
const SENSITIVE_KEY =
  /^(?:authorization|cookie|data|password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key)$/i
const SENSITIVE_QUERY_KEY =
  '(?:authorization|cookie|password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key)'
const SENSITIVE_QUERY_VALUE = new RegExp(
  `([?&;]${SENSITIVE_QUERY_KEY}=)[^&#\\s]+`,
  'gi',
)
const SENSITIVE_LABEL_VALUE = new RegExp(
  `\\b(${SENSITIVE_QUERY_KEY})\\s*[:=]\\s*[^\\s,&]+`,
  'gi',
)
// 视频窗口会把内层 URL 作为 file:// 查询参数传一层，因此 ?token= 会变成
// %3Ftoken%3D。诊断里不能只看明文查询串。
const SENSITIVE_ENCODED_QUERY_VALUE = new RegExp(
  `((?:%3F|%26|%3B)${SENSITIVE_QUERY_KEY}%3D)(?:(?!%26|%23)[^&#\\s])+`,
  'gi',
)

// 部分 IPC 的凭据是位置参数，没有字段名可供通用脱敏器识别。
const SENSITIVE_ARG_INDEX: Record<string, number[]> = {
  apmLogin: [1],
  pairDevice: [2],
}

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
    .replace(SENSITIVE_QUERY_VALUE, '$1[REDACTED]')
    .replace(SENSITIVE_ENCODED_QUERY_VALUE, '$1[REDACTED]')
    .replace(SENSITIVE_LABEL_VALUE, '$1=[REDACTED]')
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
  const safeArgs = sanitizeForDiagnostics(args) as unknown[]
  for (const index of SENSITIVE_ARG_INDEX[channel] || []) {
    if (index >= 0 && index < safeArgs.length) safeArgs[index] = '[REDACTED]'
  }

  const record: IOperationRecord = {
    id: randomUUID(),
    channel,
    status: 'pending',
    startedAt: new Date().toISOString(),
    args: safeArgs,
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
    args: sanitizeOperationArgs(record.channel, record.args),
  }))
}

function sanitizeOperationArgs(channel: string, args: unknown) {
  const safeArgs = sanitizeForDiagnostics(
    Array.isArray(args) ? args : [],
  ) as unknown[]
  for (const index of SENSITIVE_ARG_INDEX[channel] || []) {
    if (index >= 0 && index < safeArgs.length) safeArgs[index] = '[REDACTED]'
  }
  return safeArgs
}
