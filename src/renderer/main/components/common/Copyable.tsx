import { FC, PropsWithChildren, useRef } from 'react'
import Style from './Copyable.module.scss'
import copy from 'licia/copy'
import { notify } from 'share/renderer/lib/util'
import { t } from 'common/util'
import className from 'licia/className'

interface IProps {
  className?: string
}

/** 可点击复制的文本块。延迟 200ms 是为了避开双击选中文本。 */
export const Copyable: FC<PropsWithChildren<IProps>> = function (props) {
  const valueRef = useRef<HTMLDivElement>(null)

  function copyValue() {
    setTimeout(() => {
      const element = valueRef.current
      if (!element) return
      copy(element.innerText)
      notify(t('copied'), { icon: 'info' })
    }, 200)
  }

  return (
    <div
      className={className(props.className, Style.copyText)}
      ref={valueRef}
      onClick={copyValue}
    >
      {props.children}
    </div>
  )
}
