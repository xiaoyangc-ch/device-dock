/**
 * 设置项基础行：标题 + 控件。range 模式带滑块进度条和「当前值/最大值」。
 */
import { PropsWithChildren, useEffect, useRef, useState } from 'react'
import className from 'licia/className'
import Style from './setting.module.scss'
import toNum from 'licia/toNum'
import toStr from 'licia/toStr'

interface IRowProps {
  className?: string
}

export function Row(props: PropsWithChildren<IRowProps>) {
  return (
    <div className={className(Style.settingFormRow, props.className)}>
      {props.children}
    </div>
  )
}

interface INumberProps {
  title: string
  value: number
  onChange: (val: number) => void
  min?: number
  max?: number
  step?: number
  range?: boolean
}

function progress(val: number, min: number, max: number) {
  // max 未传（0）或 <= min 时不能除零，否则宽度变成 NaN%
  if (max <= min) return '0'
  return (((val - min) / (max - min)) * 100).toFixed(2)
}

export function Number(props: INumberProps) {
  // 输入过程中保留原始字符串：直接受控成 number 会把「12.」清成「12」
  const [draft, setDraft] = useState(toStr(props.value))

  // 外部（store/其它入口）改了这个值才同步 draft。
  // 注意不能无条件覆盖：用户正在输入「12.」时 toNum 也是 12，
  // 父级 value 跟着变成 12 会把这个点清掉——那正是 draft 要解决的问题
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => {
    if (toNum(draftRef.current) !== props.value) {
      setDraft(toStr(props.value))
    }
  }, [props.value])

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value)
    props.onChange(toNum(e.target.value))
  }

  // max 传 0 时不能被当成 Infinity；未传 max 时不渲染进度条
  const max = props.max ?? 0
  const min = props.min ?? 0
  const step = props.step || 1

  const input = (
    <input
      type={props.range ? 'range' : 'number'}
      value={draft}
      onChange={onChange}
      min={min}
      max={max}
      step={step}
    />
  )

  return (
    <div className={className(Style.settingField, Style.settingNumberField)}>
      <div className={Style.settingLabel}>{props.title}</div>
      {props.range ? (
        <div className={Style.settingControl}>
          <span className={Style.settingRangeValue}>{`${props.value}/${max}`}</span>
          <div className={Style.settingRange}>
            <div className={Style.settingRangeTrack}>
              <div className={Style.settingRangeBar}>
                <div
                  className={Style.settingRangeFill}
                  style={{ width: `${progress(props.value, min, max)}%` }}
                ></div>
              </div>
            </div>
            {input}
          </div>
        </div>
      ) : (
        <div className={Style.settingControl}>{input}</div>
      )}
    </div>
  )
}

interface IInputProps {
  title: string
  value: string
  onChange: (val: string) => void
}

export function Input(props: IInputProps) {
  return (
    <div className={className(Style.settingField, Style.settingInputField)}>
      <div className={Style.settingLabel}>{props.title}</div>
      <div className={Style.settingControl}>
        <input
          value={props.value}
          type="text"
          onChange={(e) => props.onChange(e.target.value)}
        ></input>
      </div>
    </div>
  )
}
