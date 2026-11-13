/**
 * 渲染层发过来的菜单模板：click 是字符串 id，转成回发 clickContextMenu。
 */
import { Menu, WebContents } from 'electron'
import * as window from './window'
import { IpcShowContextMenu } from '../../common/types'

function transTpl(template: any[], sender?: WebContents) {
  for (const item of template) {
    if (item.click) {
      const id: string = item.click
      // 必须发回发起菜单的那个窗口：回调表是每窗口一份的，
      // 用全局 focusedWin 时（弹原生菜单、切窗、Windows focus 延迟）
      // id 在目标窗口查不到，菜单项就静默失灵
      item.click = () => {
        if (sender && !sender.isDestroyed()) {
          sender.send('clickContextMenu', id)
        } else {
          window.sendFocused('clickContextMenu', id)
        }
      }
    }
    if (item.type === 'submenu') {
      item.submenu = transTpl(item.submenu, sender)
    }
  }
  return template
}

const contextMenu: IpcShowContextMenu = (x, y, template, sender) => {
  transTpl(template, sender)
  Menu.buildFromTemplate(template).popup({
    x: Math.round(x),
    y: Math.round(y),
  })
}

export default contextMenu
