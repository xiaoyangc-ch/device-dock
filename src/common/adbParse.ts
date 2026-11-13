import { isUtf8 } from 'node:buffer'

/**
 * 从 `ps` 输出里找 frpc 的 PID。
 * 只认命令行里带 frpc.ini / /frp/frpc 的进程，跳过 grep 自身和 KTV 业务进程名。
 */
export function parseFrpcPid(text: string): string | null {
  for (let line of (text || '').split('\n')) {
    line = line.trim()
    if (
      !line ||
      line.includes('grep frp') ||
      line.includes('com.shinektv.vod:frpc')
    ) {
      continue
    }
    if (
      line.includes('frpc.ini') ||
      line.includes('/frp/./frpc') ||
      line.includes('/frp/frpc') ||
      /\/frp\/.*frpc/.test(line)
    ) {
      const m = line.match(/^\S+\s+(\d+)/)
      if (m) return m[1]
    }
  }
  return null
}

/**
 * adb（尤其 Windows 上的 adb.exe）输出可能是 GBK。
 * 必须整段判定编码，逐块解码会出现半个汉字乱码。
 */
export function decodeAdbOutput(chunks: Buffer[]): string {
  const buf = Buffer.concat(chunks)
  if (!buf.length) return ''
  try {
    return isUtf8(buf)
      ? buf.toString('utf8')
      : new TextDecoder('gbk').decode(buf)
  } catch {
    return buf.toString('utf8')
  }
}
