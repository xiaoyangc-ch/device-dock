import { makeObservable, observable, runInAction } from 'mobx'
import extend from 'licia/extend'

export class Application {
  itemSize = 48
  sysPackage = true
  listView = false
  // 3.0 一次性迁移：默认用列表视图，旧的图标网格不再作为首屏
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
    const application = await main.getMainStore('application')
    if (application) {
      runInAction(() => extend(this, application))
    }
    if (!application || !application.listViewSynced) {
      runInAction(() => {
        this.listView = true
        this.listViewSynced = true
      })
      await this.set('listView', true)
    }
  }
  async set(key: string, val: any) {
    runInAction(() => {
      this[key] = val
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
