/**
 * 主进程 ↔ 渲染层的 IPC 类型。通道名在 preload/main.ts，
 * 这里只描述参数和返回值，改接口时两边一起改。
 */
import {
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from 'electron'

export interface IModalProps {
  visible: boolean
  onClose: () => void
}

export type IpcGetLanguage = () => string
export type IpcGetTheme = () => string
export type IpcGetStore = (name: string) => any
export type IpcSetStore = (name: string, value: any) => void
export type IpcShowContextMenu = (
  x: number,
  y: number,
  template: any,
  // 发起菜单的 webContents：主进程内部透传，渲染层不会传
  sender?: any
) => void
export type IpcShowOpenDialog = (
  options: OpenDialogOptions
) => Promise<OpenDialogReturnValue>
export type IpcShowSaveDialog = (
  options: SaveDialogOptions
) => Promise<SaveDialogReturnValue>
export type IpcSendToWindow = (
  name: string,
  channel: string,
  ...args: any[]
) => void
export type IpcOpenExternal = (url: string) => void
export type IpcReadClipboard = () => Promise<string>
export type IpcWriteClipboard = (text: string) => Promise<void>
export type IpcOpenPath = (path: string) => void
export type IpcShowItemInFolder = IpcOpenPath
export type IpcOpenWindow = (
  url: string,
  name?: string,
  options?: {
    width?: number
    height?: number
    minWidth?: number
    minHeight?: number
  }
) => void
export type IpcGetLogs = () => string[]
export type IpcIsCustomTitlebar = () => boolean
export type IpcIsTitlebarOverlay = () => boolean
export type IpcGetOpenFile = (ext: string) => string | void
export type IpcResolveResources = (p: string) => string

export interface IProcess {
  name: string
  pid: number
  cpu: number
  memory: number
  type: string
  webContentsId?: number
}
export type IpcGetProcessData = () => Promise<Array<IProcess>>
export type IpcKillProcess = (pid: number) => void
export type IpcOpenDevtools = (webContentsId: number) => void
export type IpcGetCpuAndMem = () => Promise<{ cpu: number; memory: number }>
export type IpcGetFileIcon = (ext: string) => Promise<string>
export type IpcShowVideo = (url: string) => void
export type IpcGetPath = (
  name: Parameters<Electron.App['getPath']>[0]
) => string
export type IpcGetInputMethod = (deviceId: string) => Promise<string>
