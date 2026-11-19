import { createPortal } from 'react-dom'
import LunaModal from 'luna-modal/react'
import { t } from 'common/util'
import { Row, Number } from 'share/renderer/components/setting'
import { useEffect, useRef, useState } from 'react'
import store from '../../store'
import { IModalProps } from 'share/common/types'
import { notify } from 'share/renderer/lib/util'

interface IProps extends IModalProps {
  initialScale: number
}

/** 系统字体缩放：改的是设备设置，界面会立刻重排。 */
export default function FontAdjustModal(props: IProps) {
  const [scale, setScale] = useState(props.initialScale)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<{ deviceId: string; value: number } | null>(null)

  useEffect(() => {
    setScale(props.initialScale)
  }, [props.initialScale])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (pending.current) {
        main
          .setFontScale(pending.current.deviceId, pending.current.value)
          .catch(() => undefined)
      }
    },
    []
  )

  function onChange(value: number) {
    if (!store.device) return
    setScale(value)
    const deviceId = store.device.id
    pending.current = { deviceId, value }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      pending.current = null
      main.setFontScale(deviceId, value).catch(() => {
        notify(t('commonErr'), { icon: 'error' })
      })
    }, 300)
  }

  return createPortal(
    <LunaModal
      title={t('fontAdjust')}
      width={400}
      visible={props.visible}
      onClose={props.onClose}
    >
      <Row className="modal-setting-row">
        <Number
          value={scale}
          title={t('scale')}
          min={0.5}
          max={4}
          step={0.1}
          range={true}
          onChange={onChange}
        />
      </Row>
    </LunaModal>,
    document.body
  )
}
