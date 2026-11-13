/**
 * 端口转发列表：直接转发给 adbkit 的 forward/reverse 能力。
 */
import { Client } from '@devicefarmer/adbkit'
import {
  IpcForward,
  IpcListForwards,
  IpcListReverses,
  IpcReverse,
} from 'common/types'
import { handleEvent } from 'share/main/lib/util'

let client: Client

const listForwards: IpcListForwards = async (deviceId) => {
  const device = await client.getDevice(deviceId)
  return (await device.listForwards()).map((item) => ({
    local: item.local,
    remote: item.remote,
  }))
}

const forward: IpcForward = async (deviceId, local, remote) => {
  const device = await client.getDevice(deviceId)
  await device.forward(local, remote)
}

const listReverses: IpcListReverses = async (deviceId) => {
  const device = await client.getDevice(deviceId)
  return (await device.listReverses()).map((item) => ({
    local: item.local,
    remote: item.remote,
  }))
}

const reverse: IpcReverse = async (deviceId, remote, local) => {
  const device = await client.getDevice(deviceId)
  await device.reverse(remote, local)
}

export function init(c: Client) {
  client = c

  handleEvent('listForwards', listForwards)
  handleEvent('listReverses', listReverses)
  handleEvent('forward', forward)
  handleEvent('reverse', reverse)
}
