import { action, makeObservable, observable, runInAction } from 'mobx'
import isStr from 'licia/isStr'
import find from 'licia/find'
import isEmpty from 'licia/isEmpty'
import BaseStore from 'share/renderer/store/BaseStore'
import { Settings } from './settings'
import { Application } from './application'
import { Process } from './process'
import { File } from './file'
import { installPackages, setMainStore } from '../../lib/util'
import { isOnlineDevice } from '../lib/util'
import { IDevice } from 'common/types'

class Store extends BaseStore {
  devices: IDevice[] = []
  device: IDevice | null = null
  // 默认落到文件页：日常用得最多，也让新壳层一进来就有内容
  panel = 'file'
  // 同一时刻只允许一个弹窗：设置/端口映射/遥控器各自独立开关会叠在一起
  activeModal = ''
  settings = new Settings()
  application = new Application()
  process = new Process()
  file = new File()
  ready = false

  constructor() {
    super()

    makeObservable(this, {
      devices: observable,
      device: observable,
      panel: observable,
      settings: observable,
      ready: observable,
      activeModal: observable,
      selectDevice: action,
      selectPanel: action,
      openModal: action,
      closeModal: action,
    })

    this.bindEvent()
    this.init()
  }

  selectDevice = (device: string | IDevice | null) => {
    if (isStr(device)) {
      const found = find(this.devices, ({ id }) => id === device)
      if (found && isOnlineDevice(found)) this.device = found
    } else {
      this.device = device && isOnlineDevice(device) ? device : null
    }
    setMainStore('device', this.device)
  }

  selectPanel(panel: string) {
    this.panel = panel
    setMainStore('panel', panel)
  }

  openModal(name: string) {
    this.activeModal = name
  }

  closeModal(name?: string) {
    // 传 name 时只有当前弹窗是自己才关：避免 A 的关闭回调把 B 关掉
    if (!name || this.activeModal === name) this.activeModal = ''
  }

  private async init() {
    const cached = await main.getMainStore('device')
    if (cached && isOnlineDevice(cached)) {
      runInAction(() => (this.device = cached))
    }

    try {
      await this.refreshDevices()
    } finally {
      // 取设备列表失败也必须放行 UI：否则启动页永远停在「正在连接…」
      this.ready = true
    }

    if (!this.device) this.selectPanel('connect')

    const openFile = await main.getOpenFile('.apk')
    if (openFile && this.device) {
      installPackages(this.device.id, [openFile])
    }
  }

  refreshDevices = async () => {
    let devices: IDevice[]
    try {
      devices = await main.getDevices()
    } catch (e) {
      // 事件回调里 throw 会变成 unhandledrejection：保留上一次列表更稳
      console.error('getDevices failed', e)
      return
    }

    runInAction(() => {
      this.devices = devices
    })

    if (isEmpty(devices)) {
      if (this.device) this.selectDevice(null)
      return
    }

    if (!this.device) {
      this.selectDevice(devices.find(isOnlineDevice) || null)
      return
    }

    const current = find(devices, ({ id }) => id === this.device!.id)
    // 用新对象替换：否则在线状态/名称/版本一直停在旧快照
    this.selectDevice(
      current && isOnlineDevice(current)
        ? current
        : devices.find(isOnlineDevice) || null,
    )
  }

  private bindEvent() {
    main.on('changeDevice', this.refreshDevices)
    main.on('refreshDevices', this.refreshDevices)
    main.on('selectDevice', this.selectDevice)
    main.on('installPackage', async (path: string) => {
      if (this.device) {
        await installPackages(this.device.id, [path])
      }
    })
  }
}

export default new Store()
