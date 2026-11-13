/**
 * 渲染层公共入口（每个窗口都会执行）：
 * dev 下挂 F5 刷新 / F12 devtools，body 上加平台 class 供样式分支。
 */
import hotKey from 'licia/hotkey'
import { isDev, getPlatform } from '../common/util'

if (isDev()) {
  hotKey.on('f5', () => location.reload())
  hotKey.on('f12', () => main.toggleDevTools())
}

document.body.classList.add(`platform-${getPlatform()}`)
