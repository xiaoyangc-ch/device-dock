import { action, makeObservable, observable, runInAction } from 'mobx'
import isStr from 'licia/isStr'
import find from 'licia/find'
import BaseStore from 'share/renderer/store/BaseStore'
import { Settings } from './settings'
import { Application } from './application'
import { Process } from './process'
import { File } from './file'
import { installPackages, setMainStore } from '../../lib/util'
import { setMemStore } from 'share/renderer/lib/util'
import isEmpty from 'licia/isEmpty'
import { IDevice } from 'common/types'

class Store extends BaseStore {
  devices: IDevice[] = []
  device: IDevice | null = null
  // 3.0 默认落到文件页：这是日常使用频率最高的页面，也让新的壳层直接可见
  panel: string = 'file'
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
      selectDevice: action,
      selectPanel: action,
    })

    this.bindEvent()
    this.init()
  }
  selectDevice = (device: string | IDevice | null) => {
    if (isStr(device)) {
      const d = find(this.devices, ({ id }) => id === device)
      if (d) {
        this.device = d
      }
    } else {
      this.device = device
    }

    setMainStore('device', this.device)
  }
  selectPanel(panel: string) {
    this.panel = panel
    setMainStore('panel', panel)
  }
  private async init() {
    // 3.0 默认打开文件页；没有设备时停在「设备连接」，不要把空文件页当首屏
    const device = await main.getMainStore('device')
    if (device) {
      runInAction(() => (this.device = device))
    }
    try {
      await this.refreshDevices()
    } finally {
      // 取设备列表失败也必须放行 UI，否则启动页永远空白（ready 一直是 false）
      this.ready = true
    }
    if (!this.device) {
      this.selectPanel('connect')
    }

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
      // 事件回调里 throw 会变成 unhandledrejection；保留上一次列表更稳
      console.error('getDevices failed', e)
      return
    }
    runInAction(() => {
      this.devices = devices
      setMemStore('devices', devices)
    })
    if (!isEmpty(devices)) {
      if (!this.device) {
        this.selectDevice(devices[0])
      } else {
        const device = find(devices, ({ id }) => id === this.device!.id)
        if (!device) {
          this.selectDevice(devices[0])
        } else {
          // 用新对象替换：否则在线状态/名称/版本一直停在旧快照
          this.selectDevice(device)
        }
      }
    } else {
      if (this.device) {
        this.selectDevice(null)
      }
    }
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
