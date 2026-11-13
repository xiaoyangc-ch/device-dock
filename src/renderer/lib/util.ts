import isEmpty from 'licia/isEmpty'
import { isObservable, toJS } from 'mobx'
import { t } from 'common/util'
import { notify } from 'share/renderer/lib/util'

/** mobx 对象要转纯 JS 才能过 IPC。 */
export async function setMainStore(name: string, value: any) {
  await main.setMainStore(name, isObservable(value) ? toJS(value) : value)
}

/** 安装 APK：不传路径就弹选择框；返回是否至少成功一个。 */
export async function installPackages(deviceId: string, apkPaths?: string[]) {
  let hasSuccess = false

  let paths = apkPaths
  if (!paths) {
    const { filePaths } = await main.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'apk file', extensions: ['apk'] }],
    })
    if (isEmpty(filePaths)) return hasSuccess
    paths = filePaths
  }

  // 逐个装：adb install-multiple 在部分老设备上会整批失败，
  // 而且逐个装才能告诉用户具体是哪个 APK 出错
  for (const apkPath of paths) {
    notify(t('packageInstalling', { path: apkPath }), { icon: 'info' })
    try {
      await main.installPackage(deviceId, apkPath)
      hasSuccess = true
    } catch {
      notify(t('installPackageErr'), { icon: 'error' })
    }
  }

  return hasSuccess
}
