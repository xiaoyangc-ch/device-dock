import { makeObservable, observable, runInAction } from 'mobx'

/** 所有页面 store 的基类：主题和语言由主进程推送，变化时重绘。 */
export default class BaseStore {
  theme = 'light'
  language = 'en-US'

  constructor() {
    makeObservable(this, {
      theme: observable,
      language: observable,
    })

    this.updateTheme()
    this.updateLanguage()
    main.on('changeTheme', this.updateTheme)
  }

  private updateTheme = async () => {
    const theme = await main.getTheme()
    runInAction(() => (this.theme = theme))
  }

  private updateLanguage = async () => {
    const language = await main.getLanguage()
    runInAction(() => (this.language = language))
  }
}
