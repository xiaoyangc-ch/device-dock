import { makeObservable, observable, runInAction } from 'mobx'
import extend from 'licia/extend'

export class Application {
  itemSize = 48
  sysPackage = true
  listView = false
  // 一次性迁移标记：老版本用户默认是图标网格，3.0 改成列表视图
  listViewSynced = false
  dataGridColumns: any[] = []

  constructor() {
    makeObservable(this, {
      itemSize: observable,
      sysPackage: observable,
      listView: observable,
    })

    this.init()
  }

  async init() {
    const saved = await main.getMainStore('application')
    if (saved) {
      runInAction(() => extend(this, saved))
    }

    if (!saved || !saved.listViewSynced) {
      runInAction(() => {
        this.listView = true
        this.listViewSynced = true
      })
      await this.set('listView', true)
    }
  }

  async set(key: string, value: any) {
    runInAction(() => {
      this[key] = value
    })
    await main.setMainStore('application', {
      itemSize: this.itemSize,
      sysPackage: this.sysPackage,
      listView: this.listView,
      listViewSynced: this.listViewSynced,
      dataGridColumns: this.dataGridColumns,
    })
  }
}
