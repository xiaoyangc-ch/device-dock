import { action, makeObservable, observable, runInAction, toJS } from 'mobx'
import extend from 'licia/extend'
import { TransferType } from 'common/types'
import now from 'licia/now'
import splitPath from 'licia/splitPath'

export class File {
  // 默认列表视图：和 Windows 资源管理器一致，支持 Ctrl/Shift 多选
  listView = true
  // 上次批量下载目录：第二次批量下载不再重复弹目录选择
  lastDownloadDir = ''
  selectionSynced = false
  showTransfer = false
  showPreview = true
  weights = [70, 30]
  transferWeight = 30
  transfers: Transfer[] = []
  constructor() {
    makeObservable(this, {
      listView: observable,
      showTransfer: observable,
      showPreview: observable,
      transferWeight: observable,
      transfers: observable,
      weights: observable,
      lastDownloadDir: observable,
    })

    this.init()
    this.bindEvent()
  }
  async init() {
    const file = await main.getMainStore('file')
    if (file) {
      runInAction(() => extend(this, file))
    }
    // 一次性迁移：老配置默认是图标视图，没法 Shift/Ctrl 多选。
    // 强制切到列表视图一次，之后用户自己切回图标视图不再覆盖。
    if (!file || !file.selectionSynced) {
      runInAction(() => {
        this.listView = true
        this.selectionSynced = true
      })
      await this.set('listView', true)
    }
  }
  async set(key: string, val: any) {
    runInAction(() => {
      this[key] = val
    })
    await main.setMainStore('file', {
      listView: this.listView,
      showTransfer: this.showTransfer,
      transferWeight: this.transferWeight,
      showPreview: this.showPreview,
      weights: toJS(this.weights),
      lastDownloadDir: this.lastDownloadDir,
      selectionSynced: this.selectionSynced,
    })
  }
  private bindEvent() {
    main.on('startTransfer', (id, type, src, dest, size) => {
      // 新任务进来时，把较早的已完成记录挤掉，避免列表无限增长
      const doneList = this.transfers.filter((t) => t.done)
      if (doneList.length >= 20) {
        const idx = this.transfers.indexOf(doneList[0])
        if (idx >= 0) this.transfers.splice(idx, 1)
      }
      this.transfers.push(new Transfer(id, type, src, dest, size))
      // 有传输就自动打开进度面板
      runInAction(() => (this.showTransfer = true))
    })
    main.on('updateTransfer', (id, transferred) => {
      // 无论面板是否可见都要累计进度（原来隐藏时不更新，再打开就丢进度）
      const transfer = this.transfers.find((t) => t.id === id)
      if (transfer) {
        transfer.update(transferred)
      }
    })
    main.on('finishTransfer', (id, ok = true) => {
      const transfer = this.transfers.find((t) => t.id === id)
      if (!transfer) return
      runInAction(() => {
        transfer.done = true
        transfer.ok = ok !== false
        if (transfer.ok && transfer.size > 0) {
          // 成功时进度条走满，保留在列表里展示「完成」
          transfer.transferred = transfer.size
        }
      })
    })
  }

  clearDone() {
    runInAction(() => {
      this.transfers = this.transfers.filter((t) => !t.done)
    })
  }
}

class Transfer {
  name: string
  id: string
  type: TransferType
  src: string
  dest: string
  startTime = new Date()
  duration = 0
  size = 0
  transferred = 0
  done = false
  ok = true
  speed = 0
  private lastTime = 0
  private lastBytes = 0
  constructor(
    id: string,
    type: TransferType,
    src: string,
    dest: string,
    size: number
  ) {
    this.name = splitPath(src).name
    this.id = id
    this.type = type
    this.src = src
    this.dest = dest
    this.size = size

    makeObservable(this, {
      transferred: observable,
      duration: observable,
      done: observable,
      ok: observable,
      speed: observable,
      update: action,
    })
  }
  update(transferred: number) {
    const t = now()
    if (!this.lastTime) {
      this.lastTime = t
      this.lastBytes = transferred
    }
    this.duration = t - this.startTime.getTime()
    const dt = t - this.lastTime
    if (dt >= 300) {
      const inst = ((transferred - this.lastBytes) * 1000) / dt
      // 平滑一下，避免数字跳动
      this.speed = this.speed ? this.speed * 0.6 + inst * 0.4 : inst
      this.lastTime = t
      this.lastBytes = transferred
    }
    this.transferred = transferred
  }
}
