/**
 * 会话 id（scid）生成。
 *
 * scid 决定设备端 abstract socket 名（@scrcpy_%08x），每次会话换一个，
 * 避免撞上上一次会话残留的 server 进程。抽成独立模块是为了能脱离
 * scrcpy 解码器依赖做纯函数测试。
 */
export function makeScid(deviceId: string, now = Date.now()) {
  let hash = 0
  for (let i = 0; i < deviceId.length; i++) {
    hash = (hash * 31 + deviceId.charCodeAt(i)) | 0
  }
  // 用毫秒而不是秒：用户连续点两次重连时也不能复用残留 server 的 socket 名。
  const seed = Math.abs(hash) + Math.floor(now % 999983)
  // 加 1：取模可能得到 0，而 scid=0 是 scrcpy 的默认值，
  // 会和残留 server 的 socket 名撞上
  return String((seed % 999999) + 1)
}
