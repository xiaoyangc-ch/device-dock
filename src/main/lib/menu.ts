import { Menu, MenuItemConstructorOptions, app, shell } from 'electron'
import * as window from 'share/main/lib/window'
import * as terminal from 'share/main/window/terminal'
import * as process from 'share/main/window/process'
import * as about from 'share/main/window/about'
import isMac from 'licia/isMac'
import { t } from 'common/util'
import upperCase from 'licia/upperCase'
import isWindows from 'licia/isWindows'
import { getUserDataPath } from 'share/main/lib/util'
import { isDev } from 'share/common/util'

function getTemplate(): MenuItemConstructorOptions[] {
  const hideMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          type: 'separator',
        },
        {
          label: t('hideApp'),
          role: 'hide',
        },
        {
          label: t('hideOthers'),
          role: 'hideOthers',
        },
        {
          label: t('showAll'),
          role: 'unhide',
        },
      ]
    : []

  const appMenu: MenuItemConstructorOptions = {
    label: upperCase(app.name),
    submenu: [
      {
        label: t('aboutApp'),
        click() {
          about.showWin()
        },
      },
      ...hideMenu,
      {
        type: 'separator',
      },
      {
        label: t('quitApp'),
        accelerator: isMac ? 'Command+Q' : 'Ctrl+Q',
        click() {
          app.quit()
        },
      },
    ],
  }

  const edit: MenuItemConstructorOptions = {
    label: t('edit'),
    submenu: [
      {
        role: 'cut',
        label: t('cut'),
      },
      {
        role: 'copy',
        label: t('copy'),
      },
      {
        role: 'paste',
        label: t('paste'),
      },
      {
        role: 'delete',
        label: t('delete'),
      },
      {
        role: 'selectAll',
        label: t('selectAll'),
      },
    ],
  }

  const tools: MenuItemConstructorOptions = {
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

  const help: MenuItemConstructorOptions = {
    role: 'help',
    label: t('help'),
    submenu: [
      ...(isDev()
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
            {
              type: 'separator' as const,
            },
          ]
        : []),
      {
        role: 'toggleDevTools',
        label: t('toggleDevtools'),
      },
    ],
  }

  const template: MenuItemConstructorOptions[] = [tools, help]
  // Windows 也要有「编辑」菜单：没有 copy/paste 的 role，Ctrl+C/V 在输入框里
  // 有时不生效（尤其远程桌面/精简菜单的打包），用户连粘贴都没入口
  template.unshift(appMenu, edit)

  return template
}

function updateMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(getTemplate()))

  if (isWindows) {
    window.sendTo('main', 'refreshMenu')
  }
}

export function init() {
  updateMenu()
}
