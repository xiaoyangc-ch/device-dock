import BaseStore from '../store/BaseStore'
import { IProcess } from '../../common/types'
import { action, makeObservable, observable, runInAction } from 'mobx'

class Store extends BaseStore {
  processes: IProcess[] = []
  process: IProcess | null = null
  filter = ''

  constructor() {
    super()

    makeObservable(this, {
      processes: observable,
      process: observable,
      filter: observable,
      setFilter: action,
      select: action,
    })

    this.init()
  }

  select(process: IProcess | null) {
    this.process = process
  }

  setFilter(filter: string) {
    this.filter = filter
  }

  async init() {
    void this.refresh()
    // 2 秒一刷：进程 CPU 是采样值，太密会在任务管理器里看倒自己
    setInterval(() => void this.refresh(), 2000)
  }

  async refresh() {
    try {
      const processes = await main.getProcessData()
      runInAction(() => {
        this.processes = processes
      })
    } catch {
      // 采样失败时保留上一份快照，下一轮继续。
    }
  }
}

export default new Store()
