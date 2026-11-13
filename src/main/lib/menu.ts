/**
 * 应用菜单：macOS 的 app 菜单（关于/隐藏/退出）、编辑、工具、帮助。
 * Windows 也保留「编辑」菜单：没有 copy/paste role 时，
 * 输入框里的 Ctrl+C/V 在部分打包/远程桌面环境下不生效。
 */
import { Menu, MenuItemConstructorOptions, app, shell } from 'electron'
import * as window from 'share/main/lib/window'
import * as terminal from 'share/main/window/terminal'
import * as process from 'share/main/window/process'
import * as about from 'share/main/window/about'
import isMac from 'licia/isMac'
import isWindows from 'licia/isWindows'
import upperCase from 'licia/upperCase'
import { t } from 'common/util'
import { getUserDataPath } from 'share/main/lib/util'
import { isDev } from 'share/common/util'

function appMenu(): MenuItemConstructorOptions {
  const macItems: MenuItemConstructorOptions[] = isMac
    ? [
        { type: 'separator' },
        { label: t('hideApp'), role: 'hide' },
        { label: t('hideOthers'), role: 'hideOthers' },
        { label: t('showAll'), role: 'unhide' },
      ]
    : []

  return {
    label: upperCase(app.name),
    submenu: [
      {
        label: t('aboutApp'),
        click() {
          about.showWin()
        },
      },
      ...macItems,
      { type: 'separator' },
      {
        label: t('quitApp'),
        accelerator: isMac ? 'Command+Q' : 'Ctrl+Q',
        click() {
          app.quit()
        },
      },
    ],
  }
}

function editMenu(): MenuItemConstructorOptions {
  return {
    label: t('edit'),
    submenu: [
      { role: 'cut', label: t('cut') },
      { role: 'copy', label: t('copy') },
      { role: 'paste', label: t('paste') },
      { role: 'delete', label: t('delete') },
      { role: 'selectAll', label: t('selectAll') },
    ],
  }
}

function toolsMenu(): MenuItemConstructorOptions {
  return {
    label: t('tools'),
    submenu: [
      {
        label: t('terminal'),
        click() {
          terminal.showWin()
        },
      },
      {
        label: t('processManager'),
        click() {
          process.showWin()
        },
      },
    ],
  }
}

function helpMenu(): MenuItemConstructorOptions {
  const devItems: MenuItemConstructorOptions[] = isDev()
    ? [
        {
          label: t('openUserDataDir'),
          click() {
            shell.openPath(getUserDataPath(''))
          },
        },
        {
          label: t('debugMainProcess'),
          click() {
            process.debugMainProcess()
          },
        },
        { type: 'separator' },
      ]
    : []

  return {
    role: 'help',
    label: t('help'),
    submenu: [
      ...devItems,
      { role: 'toggleDevTools', label: t('toggleDevtools') },
    ],
  }
}

function buildTemplate(): MenuItemConstructorOptions[] {
  return [appMenu(), editMenu(), toolsMenu(), helpMenu()]
}

function updateMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate()))
  // Windows 用的是自绘标题栏：菜单变了要通知渲染层重画
  if (isWindows) window.sendTo('main', 'refreshMenu')
}

export function init() {
  updateMenu()
}
