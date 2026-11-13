/**
 * 渲染层发过来的菜单模板：click 是字符串 id，转成回发 clickContextMenu。
 */
import { Menu } from 'electron'
import * as window from './window'
import { IpcShowContextMenu } from '../../common/types'

function transTpl(template: any[]) {
  for (const item of template) {
    if (item.click) {
      const id: string = item.click
      item.click = () => window.sendFocused('clickContextMenu', id)
    }
    if (item.type === 'submenu') {
      item.submenu = transTpl(item.submenu)
    }
  }
  return template
}

const contextMenu: IpcShowContextMenu = (x, y, template) => {
  transTpl(template)
  Menu.buildFromTemplate(template).popup({
    x: Math.round(x),
    y: Math.round(y),
  })
}

export default contextMenu
