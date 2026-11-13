import { action, makeObservable, observable, runInAction } from 'mobx'
import isUndef from 'licia/isUndef'

export class Settings {
  language = 'en-US'
  theme = 'light'
  adbPath = ''
  killAdbWhenExit = false
  useNativeTitlebar = false
  // 3.0 侧栏可折叠：316px → 84px，文件表格在 1024 窗口下能多出 232px
  sidebarCollapsed = false
  constructor() {
    makeObservable(this, {
      language: observable,
      theme: observable,
      adbPath: observable,
      killAdbWhenExit: observable,
      useNativeTitlebar: observable,
      sidebarCollapsed: observable,
      set: action,
    })

    this.init()
  }
  async init() {
    const names = [
      'language',
      'theme',
      'adbPath',
      'killAdbWhenExit',
      'useNativeTitlebar',
      'sidebarCollapsed',
    ]
    for (let i = 0, len = names.length; i < len; i++) {
      const name = names[i]
      const val = await main.getSettingsStore(name)
      if (!isUndef(val)) {
        runInAction(() => (this[name] = val))
      }
    }
  }
  async set(name: string, val: any) {
    runInAction(() => {
      this[name] = val
    })
    await main.setSettingsStore(name, val)
  }
}
