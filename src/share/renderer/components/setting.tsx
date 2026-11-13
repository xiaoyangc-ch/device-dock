/**
 * 设置项基础行：标题 + 控件。range 模式带滑块进度条和「当前值/最大值」。
 */
import { PropsWithChildren, useState } from 'react'
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
  return (((val - min) / (max - min)) * 100).toFixed(2)
}

export function Number(props: INumberProps) {
  // 输入过程中保留原始字符串：直接受控成 number 会把「12.」清成「12」
  const [draft, setDraft] = useState(toStr(props.value))

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value)
    props.onChange(toNum(e.target.value))
  }

  const max = props.max || Infinity
  const min = props.min || 0
  const step = props.step || 1

  const input = (
    <input
      type={props.range ? 'range' : 'number'}
      value={draft !== '' ? props.value : draft}
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
