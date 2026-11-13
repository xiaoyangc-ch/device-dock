import { t } from 'common/util'
import LunaModal from 'luna-modal/react'
import { createPortal } from 'react-dom'
import { IModalProps } from 'share/common/types'
import { Input, Row } from 'share/renderer/components/setting'
import className from 'licia/className'
import { useState } from 'react'
import LunaOtpInput from 'luna-otp-input/react'
import toNum from 'licia/toNum'
import { notify } from 'share/renderer/lib/util'
import Style from './CodePairModal.module.scss'
import { LoadingCircle } from 'share/renderer/components/loading'

export default function CodePairModal(props: IModalProps) {
  const [ip, setIp] = useState('')
  const [port, setPort] = useState('')
  const [password, setPassword] = useState('')
  const [isPairing, setIsPairing] = useState(false)

  async function pair() {
    // 关闭弹窗不会卸载 children，上次的配对码还留着：不合法的输入直接拦住，别拿旧码再配一次
    if (isPairing || !ip || !port || !password || password.length < 6) return
    setIsPairing(true)
    try {
      await main.pairDevice(ip, toNum(port), password)
      setPassword('')
      props.onClose()
    } catch (e: any) {
      notify(t('commonErr') + '：' + (e && e.message ? e.message : e), {
        icon: 'error',
      })
    }
    setIsPairing(false)
  }

  const disabled = isPairing || !ip || !port || !password || password.length < 6

  return createPortal(
    <LunaModal
      title={t('pairDevice')}
      visible={props.visible}
      onClose={props.onClose}
      width={400}
    >
      <Row className="modal-setting-row">
        <Input title={t('ipAddress')} value={ip} onChange={(ip) => setIp(ip)} />
        <Input
          title={t('port')}
          value={port}
          onChange={(port) => setPort(port)}
        />
      </Row>
      <div className={Style.pairingCode}>
        <div className={Style.pairingCodeTitle}>{t('pairingCode')}</div>
        <LunaOtpInput
          onChange={(password) => {
            setPassword(password)
          }}
        />
      </div>
      <div
        className={className('modal-button', 'button', 'primary', {
          disabled,
        })}
        onClick={pair}
      >
        {isPairing ? <LoadingCircle className={Style.loading} /> : t('pair')}
      </div>
    </LunaModal>,
    document.body
  )
}
