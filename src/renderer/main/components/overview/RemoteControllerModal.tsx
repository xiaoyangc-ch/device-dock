/**
 * 遥控器：电源/音量、方向键 + OK、主页/返回/多任务，走 input keyevent。
 */
import LunaModal from 'luna-modal/react'
import { observer } from 'mobx-react-lite'
import { createPortal } from 'react-dom'
import { t } from 'common/util'
import { IModalProps } from 'share/common/types'
import Style from './RemoteControllerModal.module.scss'
import className from 'licia/className'
import store from '../../store'
import { AndroidKeyCode } from '@yume-chan/scrcpy'
import { notify } from 'share/renderer/lib/util'

export default observer(function RemoteControllerModal(props: IModalProps) {
  function press(keyCode: AndroidKeyCode) {
    return () => {
      if (!store.device) return
      main.inputKey(store.device.id, keyCode).catch((e: any) => {
        notify(t('commonErr') + (e?.message ? `：${e.message}` : ''), {
          icon: 'error',
        })
      })
    }
  }

  return createPortal(
    <LunaModal
      title={t('remoteController')}
      width={400}
      visible={props.visible}
      onClose={props.onClose}
    >
      <div className={Style.remotePad}>
        <div className={Style.remoteRowTop}>
          <div className={Style.remoteKey}>
            <span
              className="icon-power"
              title={t('power')}
              onClick={press(AndroidKeyCode.Power)}
            />
          </div>
          <div className={Style.remoteKey}>
            <span
              title={t('volumeDown')}
              className="icon-volume-down"
              onClick={press(AndroidKeyCode.VolumeDown)}
            />
          </div>
          <div className={Style.remoteKey}>
            <span
              className="icon-volume"
              title={t('volumeUp')}
              onClick={press(AndroidKeyCode.VolumeUp)}
            />
          </div>
        </div>

        <div className={Style.remoteDpad}>
          <div
            className={Style.dpadCenter}
            onClick={press(AndroidKeyCode.AndroidDPadCenter)}
          >
            OK
          </div>
          <div
            className={Style.dpadUp}
            onClick={press(AndroidKeyCode.ArrowUp)}
          />
          <div
            className={Style.dpadRight}
            onClick={press(AndroidKeyCode.ArrowRight)}
          />
          <div
            className={Style.dpadDown}
            onClick={press(AndroidKeyCode.ArrowDown)}
          />
          <div
            className={Style.dpadLeft}
            onClick={press(AndroidKeyCode.ArrowLeft)}
          />
        </div>

        <div className={Style.remoteRowBottom}>
          <div className={Style.remoteKey}>
            <span
              title={t('home')}
              className="icon-circle"
              onClick={press(AndroidKeyCode.AndroidHome)}
            />
          </div>
          <div className={Style.remoteKey}>
            <span
              title={t('back')}
              className={className('icon-back', Style.remoteBack)}
              onClick={press(AndroidKeyCode.AndroidBack)}
            />
          </div>
          <div className={Style.remoteKey}>
            <span
              title={t('appSwitch')}
              className="icon-square"
              onClick={press(AndroidKeyCode.AndroidAppSwitch)}
            />
          </div>
        </div>
      </div>
    </LunaModal>,
    document.body,
  )
})
