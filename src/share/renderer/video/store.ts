import getUrlParam from 'licia/getUrlParam'
import { action, makeObservable, observable } from 'mobx'
import BaseStore from '../store/BaseStore'

class Store extends BaseStore {
  url = ''

  constructor() {
    super()

    makeObservable(this, {
      url: observable,
      setUrl: action,
    })

    this.setUrl(getUrlParam('videoUrl') || '')
    this.bindEvent()
  }

  setUrl(url: string) {
    this.url = url
    try {
      const parsed = new URL(url)
      const name = decodeURIComponent(
        parsed.pathname.split('/').filter(Boolean).pop() || '',
      )
      preload.setTitle(name || 'Video')
    } catch {
      preload.setTitle('Video')
    }
  }

  private bindEvent() {
    // 窗口复用：已开着的播放器换片源，不重建窗口
    main.on('setVideoUrl', (url: string) => this.setUrl(url))
  }
}

export default new Store()
