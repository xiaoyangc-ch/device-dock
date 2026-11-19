import { IPackageInfo } from 'common/types'
import { fallbackIcon } from '../../lib/appIcon'

export function iconEntry(info: IPackageInfo) {
  const style: Record<string, string> = { borderRadius: '20%' }
  if (!info.enabled) style.filter = 'grayscale(100%)'

  return {
    info,
    src: info.icon || fallbackIcon(info.label, info.packageName),
    name: info.label,
    style,
  }
}

/** dex 不可用时至少保留包名入口，列表不能因为详情失败而静默少项。 */
export function placeholderInfo(
  packageName: string,
  system: boolean,
): IPackageInfo {
  return {
    packageName,
    label: packageName,
    icon: '',
    enabled: true,
    versionName: '',
    apkPath: '',
    apkSize: 0,
    system,
    firstInstallTime: 0,
    lastUpdateTime: 0,
    dataSize: 0,
    cacheSize: 0,
    appSize: 0,
    signatures: [],
  }
}
