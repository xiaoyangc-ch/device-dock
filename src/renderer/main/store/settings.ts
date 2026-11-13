import { action, makeObservable, observable, runInAction } from 'mobx'
import isUndef from 'licia/isUndef'

const NAMES = [
  'language',
  'theme',
  'adbPath',
  'killAdbWhenExit',
  'useNativeTitlebar',
  'sidebarCollapsed',
]

export class Settings {
  language = 'en-US'
  theme = 'light'
  adbPath = ''
  killAdbWhenExit = false
  useNativeTitlebar = false
  // 侧栏可折叠：316px → 84px，1024 窗口下文件表格能多出 232px
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
    for (const name of NAMES) {
      const value = await main.getSettingsStore(name)
      if (!isUndef(value)) {
        runInAction(() => {
          this[name] = value
        })
      }
    }
  }

  async set(name: string, value: any) {
    runInAction(() => {
      this[name] = value
    })
    await main.setSettingsStore(name, value)
  }
}
