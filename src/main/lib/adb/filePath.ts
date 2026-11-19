/** 设备 shell 参数引用：单引号内所有特殊字符都不再解释。 */
export function shellQuotePath(devicePath: string) {
  return "'" + devicePath.replace(/'/g, "'\\''") + "'"
}

export function joinDevicePath(dir: string, name: string) {
  if (!dir || dir === '/') return '/' + name
  return dir.replace(/\/+$/, '') + '/' + name
}

/** URL path 必须按段编码，不能把文件名里的 #、? 或 + 当成 URL 语法。 */
export function encodeDevicePath(devicePath: string) {
  return devicePath
    .split('/')
    .map((part, index) => (index === 0 ? '' : encodeURIComponent(part)))
    .join('/')
}
