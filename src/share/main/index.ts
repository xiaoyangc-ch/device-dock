import { app, session } from 'electron'
import isMac from 'licia/isMac'
import isWindows from 'licia/isWindows'
import * as theme from './lib/theme'
import * as language from './lib/language'
import * as ipc from './lib/ipc'
import pkg from '../../../package.json'
import { setupTitlebar } from 'custom-electron-titlebar/main'

// 单实例：第二个实例要把命令行里的 APK 交给已运行的实例，不能自己开一份
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

app.setName(pkg.productName)

app.on('ready', () => {
  // Linux 没装拼写词典时每个输入框都会刷警告
  if (!isMac && !isWindows) {
    session.defaultSession.setSpellCheckerLanguages([])
  }
  setupTitlebar()
  language.init()
  theme.init()
  ipc.init()
})
