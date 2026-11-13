import { useState } from 'react'
import { t } from '../../common/i18n'
import className from 'licia/className'

interface IProps {
  className?: string
  onClick: () => void
}

/** 复制按钮：点完 1 秒内变勾，给出明确反馈。 */
export default function CopyButton(props: IProps) {
  const [done, setDone] = useState(false)

  const onClick = () => {
    props.onClick()
    setDone(true)
    setTimeout(() => setDone(false), 1000)
  }

  return (
    <div className={className('icon', props.className)} onClick={onClick}>
      <span
        className={`icon-${done ? 'check' : 'copy'}`}
        title={t('copy')}
        style={done ? { color: 'var(--color-success)' } : undefined}
      ></span>
    </div>
  )
}
