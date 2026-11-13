import { KeyboardEvent, ReactNode } from 'react'
import Style from './PageToolbar.module.scss'

function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ')
}

interface IPageProps {
  children: ReactNode
  className?: string
}

export function Page(props: IPageProps) {
  return <div className={cx(Style.page, props.className)}>{props.children}</div>
}

export function PageBody(props: IPageProps) {
  return <div className={cx(Style.body, props.className)}>{props.children}</div>
}

export default function PageToolbar(props: IPageProps) {
  return (
    <div className={cx(Style.bar, props.className)}>{props.children}</div>
  )
}

interface IToolButtonProps {
  icon?: string
  label?: string
  title?: string
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  primary?: boolean
}

export function ToolButton(props: IToolButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        Style.btn,
        props.active && Style.active,
        props.primary && Style.primary
      )}
      title={props.title || props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.icon && <span className={cx(Style.icon, props.icon)} />}
      {props.label && <span>{props.label}</span>}
    </button>
  )
}

export function ToolText(props: {
  children: ReactNode
  mono?: boolean
  className?: string
}) {
  return (
    <span
      className={cx(Style.text, props.mono && Style.mono, props.className)}
    >
      {props.children}
    </span>
  )
}

export function ToolSeparator() {
  return <span className={Style.sep} />
}

export function ToolSpace() {
  return <span className={Style.space} />
}

export function ToolInput(props: {
  value: string
  placeholder?: string
  onChange: (value: string) => void
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
  width?: number
  disabled?: boolean
}) {
  return (
    <input
      className={Style.input}
      style={{ width: props.width || 160 }}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={props.onKeyDown}
    />
  )
}

export function ToolSelect(props: {
  value: string
  options: { label: string; value: string }[]
  onChange: (value: string) => void
  width?: number
  disabled?: boolean
}) {
  return (
    <select
      className={Style.select}
      style={{ width: props.width || 100 }}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function ToolCheckbox(props: {
  checked: boolean
  label: string
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className={Style.check}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.label}
    </label>
  )
}
