/**
 * 主题：settings 里的 theme（system/light/dark）落到 nativeTheme，
 * 系统主题变化时广播 changeTheme 让所有窗口重画。
 */
import { nativeTheme } from 'electron'
import { getSettingsStore } from '../../../main/lib/store'
import { getTheme, handleEvent } from './util'
import * as window from './window'
import log from '../../common/log'
import { IpcGetTheme } from '../../common/types'
import Emitter from 'licia/Emitter'
import types from 'licia/types'

const logger = log('theme')
const store = getSettingsStore()

type Theme = 'system' | 'light' | 'dark'

export const get: IpcGetTheme = () => getTheme()

function apply(theme: Theme) {
  nativeTheme.themeSource = theme
}

const emitter = new Emitter()

export function on(event: string, listener: types.AnyFn) {
  emitter.on(event, listener)
}

emitter.on('change', () => window.sendAll('changeTheme'))

export function init() {
  logger.info('init')

  apply(store.get('theme'))
  handleEvent('getTheme', get)

  // themeSource = system 时，系统切换深色要主动通知（nativeTheme 不会自己广播到渲染层）
  nativeTheme.on('updated', () => {
    if (nativeTheme.themeSource === 'system') emitter.emit('change')
  })

  store.on('change', (name, value) => {
    if (name === 'theme') {
      apply(value)
      emitter.emit('change')
    }
  })
}
