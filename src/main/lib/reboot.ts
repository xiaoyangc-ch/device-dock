/**
 * 重启设备。
 *
 * 这个 IPC 原本写在 `lib/apm.ts` 末尾（那是全局功能的顺手位置），
 * 4.0 删 APM 层时被一起删掉了：preload 还暴露着 `rebootDevice`、
 * 投屏页还在调，主进程却没有注册，点击后一直悬着。
 * 它和 APM 无关，单独放这里。
 */
import { IpcRebootDevice } from 'common/types'
import { handleEvent } from 'share/main/lib/util'
import log from 'share/common/log'
import { spawnAdb } from './adb/base'

const logger = log('reboot')

const rebootDevice: IpcRebootDevice = async function (deviceId) {
  const r = await spawnAdb(['-s', deviceId, 'reboot'])
  logger.info('reboot sent to', deviceId, String(r.stdout || '').trim())
}

export function init() {
  handleEvent('rebootDevice', rebootDevice)
}
