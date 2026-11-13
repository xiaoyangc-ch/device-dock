import { PropsWithChildren, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LunaToolbarButton } from 'luna-toolbar/react'
import Style from './ToolbarIcon.module.scss'

interface IProps {
  icon: string
  className?: string
  title?: string
  disabled?: boolean
  state?: '' | 'hover' | 'active'
  onClick: () => void
}

/** 工具栏图标按钮 + 自绘 tooltip（原生 title 太慢且不可控）。 */
export default function ToolbarIcon(props: PropsWithChildren<IProps>) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function hover(e: React.MouseEvent) {
    if (!props.title) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setTip({ x: rect.left + rect.width / 2, y: rect.bottom + 6 })
    }, 350)
  }

  function hide() {
    if (timer.current) clearTimeout(timer.current)
    setTip(null)
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  return (
    <span
      className={Style.wrap}
      onMouseEnter={hover}
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
