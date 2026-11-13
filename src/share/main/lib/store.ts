/**
 * 共享存储：memStore 只在进程内（临时状态），windowStore 落盘窗口位置。
 */
import fs from 'fs-extra'
import memoize from 'licia/memoize'
import Store from 'licia/Store'
import FileStore from 'licia/FileStore'
import { getUserDataPath } from './util'

fs.exists(getUserDataPath('data'), (exists) => {
  if (!exists) fs.mkdirp(getUserDataPath('data'))
})

export const getMemStore = memoize(() => new Store({}))

export const getWindowStore = memoize(
  () => new FileStore(getUserDataPath('data/window.json'), {})
)
