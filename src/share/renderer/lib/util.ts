/**
 * 渲染层工具：通知、内存存储同步、拖放判断、剪贴板写图片。
 */
import contain from 'licia/contain'
import h from 'licia/h'
import isArrBuffer from 'licia/isArrBuffer'
import convertBin from 'licia/convertBin'
import { isObservable, toJS } from 'mobx'
import LunaNotification, { INotifyOptions } from 'luna-notification'
// LunaNotification 内部用 innerHTML 渲染 content（webSecurity:false 下等于 XSS），
// content 里经常拼设备名/包名/路径，必须转义
import { escapeHtml } from 'common/html'
import { t } from '../../common/i18n'

let notification: LunaNotification | null = null

export function notify(content: string, options?: INotifyOptions) {
  if (!notification) {
    const container = h('div')
    document.body.appendChild(container)
    notification = new LunaNotification(container, {
      position: { x: 'center', y: 'top' },
    })
  }

  notification.notify(escapeHtml(content), options)
}

/** mobx 对象要转成纯 JS 才能走 IPC（结构化克隆不支持 Proxy）。 */
export async function setMemStore(name: string, value: any) {
  await main.setMemStore(name, isObservable(value) ? toJS(value) : value)
}

export function isFileDrop(e: React.DragEvent) {
  return contain(e.dataTransfer.types, 'Files')
}

export function copyData(buf: any, mime: string) {
  const data = isArrBuffer(buf) ? buf : convertBin(buf, 'ArrayBuffer')
  navigator.clipboard
    .write([
      new ClipboardItem({
        [mime]: new Blob([data], { type: mime }),
      }),
    ])
    .catch(() => {
      notify(t('commonErr'), { icon: 'error' })
    })
}
