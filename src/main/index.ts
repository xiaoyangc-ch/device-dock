import { app } from 'electron'
import * as menu from './lib/menu'
import * as main from './window/main'
import * as adb from './lib/adb'
import * as disktool from './lib/disktool'
import * as webCast from './lib/webCast'
import * as webCastWindow from './window/webCast'
import * as recording from './lib/recording'
import * as preview from './lib/preview'
import * as latency from './lib/latency'
import * as reboot from './lib/reboot'
import * as stream from './lib/stream'
import * as diagnostics from './lib/diagnostics'
import * as terminal from 'share/main/window/terminal'
import * as window from 'share/main/lib/window'
import log from 'share/common/log'
import { getSettingsStore } from './lib/store'
import 'share/main'

const logger = log('main')
logger.info('start')

const settingsStore = getSettingsStore()
window.setDefaultOptions({
  customTitlebar: !settingsStore.get('useNativeTitlebar'),
})

app.on('ready', () => {
  logger.info('app ready')

  terminal.init()
  diagnostics.init()
  disktool.init()
  webCast.init()
  webCastWindow.init()
  recording.init()
  preview.init()
  latency.init()
  reboot.init()
  stream.init()
  menu.init()

  void adb
    .init()
    .catch((error) => logger.error('initialize adb failed', error))
    .finally(() => main.showWin())
})
