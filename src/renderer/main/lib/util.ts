import isIp from 'licia/isIp'
import isNumeric from 'licia/isNumeric'
import contain from 'licia/contain'
import trim from 'licia/trim'

export function normalizePort(port: string) {
  port = trim(port)

  if (isNumeric(port)) {
    return `tcp:${port}`
  }

  return port
}

// ip:port 形式即远程设备；USB 串口不含冒号
export function isRemoteDevice(deviceId: string) {
  if (!contain(deviceId, ':')) {
    return false
  }

  return isIp.v4(deviceId.split(':')[0])
}
