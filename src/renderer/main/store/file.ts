import { action, makeObservable, observable, runInAction, toJS } from 'mobx'
import extend from 'licia/extend'
import { TransferType } from 'common/types'
import now from 'licia/now'
import splitPath from 'licia/splitPath'

const MAX_DONE_TRANSFERS = 20

export class File {
  // 默认列表视图：和资源管理器一致，支持 Ctrl/Shift 多选
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
    const saved = await main.getMainStore('file')
    if (saved) {
      runInAction(() => extend(this, saved))
    }

    // 一次性迁移：老配置是图标视图，没法 Shift/Ctrl 多选。
    // 强制切列表视图一次；之后用户自己切回图标视图不再覆盖
    if (!saved || !saved.selectionSynced) {
      runInAction(() => {
        this.listView = true
        this.selectionSynced = true
      })
      await this.set('listView', true)
    }
  }

  async set(key: string, value: any) {
    runInAction(() => {
      this[key] = value
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
    main.on(
      'startTransfer',
      (id: string, type: TransferType, src: string, dest: string, size: number) => {
        // 已完成记录只留 20 条：不清理的话长时间用下来列表会无限长
        const done = this.transfers.filter((item) => item.done)
        if (done.length >= MAX_DONE_TRANSFERS) {
          const index = this.transfers.indexOf(done[0])
          if (index >= 0) this.transfers.splice(index, 1)
        }

        this.transfers.push(new Transfer(id, type, src, dest, size))
        // 有传输就自动打开进度面板
        runInAction(() => (this.showTransfer = true))
      }
    )

    main.on('updateTransfer', (id: string, transferred: number) => {
      // 面板隐藏时也要累计进度，否则再打开会丢一段
      const transfer = this.transfers.find((item) => item.id === id)
      transfer?.update(transferred)
    })

    main.on('finishTransfer', (id: string, ok = true) => {
      const transfer = this.transfers.find((item) => item.id === id)
      if (!transfer) return

      runInAction(() => {
        transfer.done = true
        transfer.ok = ok !== false
        // 成功时进度条走满，留在列表里显示「完成」
        if (transfer.ok && transfer.size > 0) {
          transfer.transferred = transfer.size
        }
      })
    })
  }

  clearDone() {
    runInAction(() => {
      this.transfers = this.transfers.filter((item) => !item.done)
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

    // 300ms 内多个进度包只取最后一个算速度：单包算出来抖动太大
    const dt = t - this.lastTime
    if (dt >= 300) {
      const instant = ((transferred - this.lastBytes) * 1000) / dt
      this.speed = this.speed ? this.speed * 0.6 + instant * 0.4 : instant
      this.lastTime = t
      this.lastBytes = transferred
    }

    this.transferred = transferred
  }
}
