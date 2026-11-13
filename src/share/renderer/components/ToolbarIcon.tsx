import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LunaToolbarButton } from 'luna-toolbar/react'
import { PropsWithChildren } from 'react'
import Style from './ToolbarIcon.module.scss'

interface IProps {
  icon: string
  className?: string
  title?: string
  disabled?: boolean
  state?: '' | 'hover' | 'active'
  onClick: () => void
}

export default function (props: PropsWithChildren<IProps>) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<any>(null)

  function show(e: React.MouseEvent) {
    const text = props.title
    if (!text) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setTip({ x: rect.left + rect.width / 2, y: rect.bottom + 6 })
    }, 350)
  }

  function hide() {
    clearTimeout(timer.current)
    setTip(null)
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <span
      className={Style.wrap}
      onMouseEnter={show}
      onMouseLeave={hide}
      onMouseDown={hide}
    >
      <LunaToolbarButton
        className={props.className || ''}
        disabled={props.disabled}
        state={props.state || ''}
        onClick={props.onClick}
      >
        <div className="icon toolbar-icon">
          <span className={`icon-${props.icon}`}></span>
        </div>
      </LunaToolbarButton>
      {tip &&
        createPortal(
          <div className={Style.tip} style={{ left: tip.x, top: tip.y }}>
            {props.title}
          </div>,
          document.body
        )}
    </span>
  )
}
