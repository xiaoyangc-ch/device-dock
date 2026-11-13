import detectOs from 'licia/detectOs'

export function isDev() {
  // @ts-ignore
  return import.meta.env.MODE === 'development'
}

/** licia 返回 'os x'，业务里统一用 mac/win/linux */
export function getPlatform() {
  const os = detectOs()
  return os === 'os x' ? 'mac' : os
}
