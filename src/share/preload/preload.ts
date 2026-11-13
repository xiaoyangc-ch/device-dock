/**
 * preload 入口：自定义标题栏、主题切换、缩放比例。
 * 窗口类型由右上角的标题栏样式决定，这里只负责把 class 挂到 body 上。
 */
import { Titlebar, TitlebarColor } from 'custom-electron-titlebar'
import { colorBgContainer, colorBgContainerDark } from 'common/theme'
import getUrlParam from 'licia/getUrlParam'
import isMac from 'licia/isMac'
import $ from 'licia/$'
import mainObj from './main'
import { webFrame, webUtils } from 'electron'

let titleBar: Titlebar

async function updateTheme() {
  const theme = await mainObj.getTheme()
  document.body.classList.toggle('-theme-with-dark-background', theme === 'dark')

  if (await mainObj.isCustomTitlebar()) {
    const backgroundColor = TitlebarColor.fromHex(
      theme === 'dark' ? colorBgContainerDark : colorBgContainer
    )
    if (titleBar) {
      ;(titleBar as any).currentOptions.menuBarBackgroundColor = backgroundColor
      titleBar.updateBackground(backgroundColor)
    }
  }
}

async function updateZoomFactor(zoomFactor?: number) {
  const factor = zoomFactor || (await mainObj.getSettingsStore('zoomFactor'))
  if (factor) webFrame.setZoomFactor(factor)
}

window.addEventListener('DOMContentLoaded', async () => {
  const customTitlebar = await mainObj.isCustomTitlebar()

  if (customTitlebar) {
    titleBar = new Titlebar({ containerOverflow: 'hidden' })
    const $body = $('body')
    $body.addClass('custom-titlebar')
    // 子窗口（page=xxx）不显示自绘菜单栏，省一行高度
    if (getUrlParam('page') && !isMac) {
      $body.addClass('hide-cet-menubar')
    }
  }

  if (await mainObj.isTitlebarOverlay()) {
    $('body').addClass('native-titlebar-overlay')
  }

  updateTheme()
  mainObj.on('changeTheme', updateTheme)
})

updateZoomFactor()

mainObj.on('changeSettingsStore', (name: string, val: any) => {
  if (name === 'zoomFactor') updateZoomFactor(val)
})

mainObj.on('refreshMenu', () => {
  if (titleBar) titleBar.refreshMenu()
})

export default {
  setTitle: (title: string) => {
    document.title = title
    if (titleBar) titleBar.updateTitle(title)
  },
  // 拖入文件时拿真实磁盘路径：File.path 在新版 Electron 已移除
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  closeWin: () => mainObj.closeWin(),
}
