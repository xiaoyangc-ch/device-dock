import { makeObservable, observable, runInAction } from 'mobx'
import extend from 'licia/extend'

export class Process {
  onlyPackage = false

  constructor() {
    makeObservable(this, {
      onlyPackage: observable,
    })

    this.init()
  }

  async init() {
    const saved = await main.getMainStore('process')
    if (saved) {
      runInAction(() => extend(this, saved))
    }
  }

  async set(key: string, value: any) {
    runInAction(() => {
      this[key] = value
    })
    await main.setMainStore('process', {
      onlyPackage: this.onlyPackage,
    })
  }
}
