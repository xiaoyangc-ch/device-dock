/**
 * 渲染层可见的 window.main：每个方法对应主进程的一个 IPC 通道。
 * 通道名必须与主进程 handleEvent/ipcMain.handle 一字不差。
 */
import { invoke } from './util'
import types from 'licia/types'
import { ipcRenderer } from 'electron'
import {
  IpcGetCpuAndMem,
  IpcGetFileIcon,
  IpcGetLanguage,
  IpcGetLogs,
  IpcGetOpenFile,
  IpcGetPath,
  IpcGetProcessData,
  IpcGetStore,
  IpcGetTheme,
  IpcIsCustomTitlebar,
  IpcIsTitlebarOverlay,
  IpcKillProcess,
  IpcOpenDevtools,
  IpcOpenExternal,
  IpcOpenPath,
  IpcOpenWindow,
  IpcResolveResources,
  IpcSendToWindow,
  IpcSetStore,
  IpcShowContextMenu,
  IpcShowItemInFolder,
  IpcShowOpenDialog,
  IpcShowSaveDialog,
  IpcShowVideo,
} from '../common/types'

export default {
  getSettingsStore: invoke<IpcGetStore>('getSettingsStore'),
  setSettingsStore: invoke<IpcSetStore>('setSettingsStore'),
  getLanguage: invoke<IpcGetLanguage>('getLanguage'),
  getTheme: invoke<IpcGetTheme>('getTheme'),
  getMemStore: invoke<IpcGetStore>('getMemStore'),
  setMemStore: invoke<IpcSetStore>('setMemStore'),
  openExternal: invoke<IpcOpenExternal>('openExternal'),
  showContextMenu: invoke<IpcShowContextMenu>('showContextMenu'),
  showOpenDialog: invoke<IpcShowOpenDialog>('showOpenDialog'),
  showSaveDialog: invoke<IpcShowSaveDialog>('showSaveDialog'),
  openPath: invoke<IpcOpenPath>('openPath'),
  showItemInFolder: invoke<IpcShowItemInFolder>('showItemInFolder'),
  toggleDevTools: invoke('toggleDevTools'),
  sendToWindow: invoke<IpcSendToWindow>('sendToWindow'),
  relaunch: invoke('relaunch'),
  openWindow: invoke<IpcOpenWindow>('openWindow'),
  getLogs: invoke<IpcGetLogs>('getLogs'),
  clearLogs: invoke('clearLogs'),
  isCustomTitlebar: invoke<IpcIsCustomTitlebar>('isCustomTitlebar'),
  isTitlebarOverlay: invoke<IpcIsTitlebarOverlay>('isTitlebarOverlay'),
  getOpenFile: invoke<IpcGetOpenFile>('getOpenFile'),
  showTerminal: invoke('showTerminal'),
  resolveResources: invoke<IpcResolveResources>('resolveResources'),
  getProcessData: invoke<IpcGetProcessData>('getProcessData'),
  killProcess: invoke<IpcKillProcess>('killProcess'),
  openDevtools: invoke<IpcOpenDevtools>('openDevtools'),
  debugMainProcess: invoke('debugMainProcess'),
  getCpuAndMem: invoke<IpcGetCpuAndMem>('getCpuAndMem'),
  showProcess: invoke('showProcess'),
  getFileIcon: invoke<IpcGetFileIcon>('getFileIcon'),
  showVideo: invoke<IpcShowVideo>('showVideo'),
  closeWin: invoke('closeWin'),
  toggleWinMaximize: invoke('toggleWinMaximize'),
  hideWin: invoke('hideWin'),
  getPath: invoke<IpcGetPath>('getPath'),
  // 事件订阅返回解除函数：React effect 里直接 return 即可
  on: (event: string, cb: types.AnyFn) => {
    const listener = (_e: any, ...args: any[]) => cb(...args)
    ipcRenderer.on(event, listener)
    return () => ipcRenderer.off(event, listener)
  },
}
