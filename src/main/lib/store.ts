/**
 * 主进程配置存储：main（界面状态）、screencast（投屏设置）、settings（全局设置）。
 * 都落在 userData/data/*.json，读写走 licia FileStore（同步、原子写）。
 */
import memoize from 'licia/memoize'
import FileStore from 'licia/FileStore'
import { getUserDataPath } from 'share/main/lib/util'

export const getMainStore = memoize(function () {
  return new FileStore(getUserDataPath('data/main.json'), {})
})

export const getScreencastStore = memoize(function () {
  return new FileStore(getUserDataPath('data/screencast.json'), {
    settings: {},
    alwaysOnTop: false,
  })
})

export const getSettingsStore = memoize(function () {
  return new FileStore(getUserDataPath('data/settings.json'), {
    language: 'system',
    theme: 'system',
    useNativeTitlebar: false,
    adbPath: '',
    killAdbWhenExit: false,
  })
})
