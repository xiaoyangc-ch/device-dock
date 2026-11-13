import isIp from 'licia/isIp'
import isNumeric from 'licia/isNumeric'

/** 「5555」补成「tcp:5555」；已带 tcp:/usb: 前缀的原样返回。 */
export function normalizePort(port: string) {
  const value = port.trim()
  return isNumeric(value) ? `tcp:${value}` : value
}

// ip:port 形式即远程设备；USB 串口不含冒号
export function isRemoteDevice(deviceId: string) {
  if (!deviceId.includes(':')) return false
  return isIp.v4(deviceId.split(':')[0])
}
