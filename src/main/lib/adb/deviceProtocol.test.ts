import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEVICE_PROTOCOL_VERSION,
  isDeviceServerCompatible,
} from './deviceProtocol'

test('设备服务握手：版本和协议版本都一致才复用旧进程', () => {
  assert.equal(
    isDeviceServerCompatible(
      { version: '4.0.2', protocolVersion: DEVICE_PROTOCOL_VERSION },
      '4.0.2',
    ),
    true,
  )
  assert.equal(
    isDeviceServerCompatible(
      { version: '4.0.1', protocolVersion: DEVICE_PROTOCOL_VERSION },
      '4.0.2',
    ),
    false,
  )
  assert.equal(isDeviceServerCompatible({ version: '4.0.2' }, '4.0.2'), false)
})

test('设备服务握手：空结果与畸形协议版本均判定不兼容', () => {
  assert.equal(isDeviceServerCompatible(null, '4.0.2'), false)
  assert.equal(
    isDeviceServerCompatible(
      { version: '4.0.2', protocolVersion: 'invalid' },
      '4.0.2',
    ),
    false,
  )
})
