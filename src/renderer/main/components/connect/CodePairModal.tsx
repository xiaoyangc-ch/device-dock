/**
 * 无线调试配对（Android 11+）：IP + 配对端口 + 6 位配对码。
 */
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

const CODE_LENGTH = 6

export default function CodePairModal(props: IModalProps) {
  const [ip, setIp] = useState('')
  const [port, setPort] = useState('')
  const [password, setPassword] = useState('')
  const [isPairing, setIsPairing] = useState(false)

  const invalid =
    !ip || !port || !password || password.length < CODE_LENGTH || isPairing

  async function pair() {
    // 关闭弹窗不会卸载 children，上次的配对码还留着：
    // 输入不合法就直接拦住，不能拿旧码再配一次
    if (invalid) return

    setIsPairing(true)
    try {
      await main.pairDevice(ip, toNum(port), password)
      setPassword('')
      props.onClose()
    } catch (e: any) {
      notify(t('commonErr') + '：' + (e?.message || e), { icon: 'error' })
    }
    setIsPairing(false)
  }

  return createPortal(
    <LunaModal
      title={t('pairDevice')}
      visible={props.visible}
      onClose={props.onClose}
      width={400}
    >
      <Row className="modal-setting-row">
        <Input title={t('ipAddress')} value={ip} onChange={setIp} />
        <Input title={t('port')} value={port} onChange={setPort} />
      </Row>
      <div className={Style.pairingCode}>
        <div className={Style.pairingCodeTitle}>{t('pairingCode')}</div>
        <LunaOtpInput
          onChange={(code) => {
            setPassword(code)
          }}
        />
      </div>
      <div
        className={className('modal-button', 'button', 'primary', {
          disabled: invalid,
        })}
        onClick={pair}
      >
        {isPairing ? <LoadingCircle className={Style.loading} /> : t('pair')}
      </div>
    </LunaModal>,
    document.body
  )
}
