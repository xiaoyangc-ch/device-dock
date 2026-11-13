import { LunaSettingHtml } from 'luna-setting/react'
import LunaSetting from 'luna-setting'
import Style from './SettingPath.module.scss'
import { t } from '../../common/i18n'
import { OpenDialogOptions } from 'electron'
import isEmpty from 'licia/isEmpty'

interface IProps {
  title: string
  value?: string
  setting?: LunaSetting
  options: OpenDialogOptions
  onChange: (val: string) => void
}

/** 路径输入 + 浏览按钮：用户可以直接粘贴路径，也可以走系统选择框。 */
export default function SettingPath(props: IProps) {
  const browse = async () => {
    const { filePaths } = await main.showOpenDialog(props.options)
    if (!isEmpty(filePaths)) props.onChange(filePaths[0])
  }

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    props.onChange(e.target.value)
  }

  return (
    <LunaSettingHtml>
      <div className={Style.itemPath}>
        <div className="luna-setting-title">{props.title}</div>
        <div className="luna-setting-description"></div>
        <div className="luna-setting-control">
          <input value={props.value} spellCheck={false} onChange={onChange} />
          <div className="button primary" onClick={browse}>
            {t('browse')}
          </div>
        </div>
      </div>
    </LunaSettingHtml>
  )
}
