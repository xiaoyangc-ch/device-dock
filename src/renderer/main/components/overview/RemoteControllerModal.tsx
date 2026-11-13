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

export default observer(function RemoteControllerModal(props: IModalProps) {
  function press(keyCode: AndroidKeyCode) {
    return () => {
      if (!store.device) return
      main.inputKey(store.device.id, keyCode)
    }
  }

  return createPortal(
    <LunaModal
      title={t('remoteController')}
      width={400}
      visible={props.visible}
      onClose={props.onClose}
    >
      <div className={Style.remoteController}>
        <div className={Style.top}>
          <div className={Style.button}>
            <span
              className="icon-power"
              title={t('power')}
              onClick={press(AndroidKeyCode.Power)}
            />
          </div>
          <div className={Style.button}>
            <span
              title={t('volumeDown')}
              className="icon-volume-down"
              onClick={press(AndroidKeyCode.VolumeDown)}
            />
          </div>
          <div className={Style.button}>
            <span
              className="icon-volume"
              title={t('volumeUp')}
              onClick={press(AndroidKeyCode.VolumeUp)}
            />
          </div>
        </div>

        <div className={Style.directionPad}>
          <div
            className={Style.ok}
            onClick={press(AndroidKeyCode.AndroidDPadCenter)}
          >
            OK
          </div>
          <div
            className={Style.up}
            onClick={press(AndroidKeyCode.ArrowUp)}
          />
          <div
            className={Style.right}
            onClick={press(AndroidKeyCode.ArrowRight)}
          />
          <div
            className={Style.down}
            onClick={press(AndroidKeyCode.ArrowDown)}
          />
          <div
            className={Style.left}
            onClick={press(AndroidKeyCode.ArrowLeft)}
          />
        </div>

        <div className={Style.bottom}>
          <div className={Style.button}>
            <span
              title={t('home')}
              className="icon-circle"
              onClick={press(AndroidKeyCode.AndroidHome)}
            />
          </div>
          <div className={Style.button}>
            <span
              title={t('back')}
              className={className('icon-back', Style.back)}
              onClick={press(AndroidKeyCode.AndroidBack)}
            />
          </div>
          <div className={Style.button}>
            <span
              title={t('appSwitch')}
              className="icon-square"
              onClick={press(AndroidKeyCode.AndroidAppSwitch)}
            />
          </div>
        </div>
      </div>
    </LunaModal>,
    document.body
  )
})
