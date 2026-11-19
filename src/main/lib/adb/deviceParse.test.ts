import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseIpAndMac,
  parseMemory,
  parseScreen,
  parseStorage,
  parseWifiSsid,
} from './deviceParse'

test('Huawei WiFi：兼容 mWifiInfo 前缀和普通 SSID 行', () => {
  assert.equal(
    parseWifiSsid('mWifiInfo SSID: "HUAWEI-5G", BSSID: 00:11:22:33:44:55'),
    'HUAWEI-5G'
  )
  assert.equal(parseWifiSsid('SSID: KirinLab, BSSID: 00:11'), 'KirinLab')
  assert.equal(parseWifiSsid('mWifiInfo SSID: <unknown ssid>, BSSID'), '')
})

test('网络信息：Kirin wlan0 的 IP/MAC 和网络类型', () => {
  const output = [
    '2: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500',
    '    link/ether 02:11:22:33:44:55 brd ff:ff:ff:ff:ff:ff',
    '    inet 192.168.3.22/24 brd 192.168.3.255 scope global wlan0',
  ].join('\n')
  assert.deepEqual(parseIpAndMac(output), {
    ip: '192.168.3.22',
    mac: '02:11:22:33:44:55',
    netType: '无线网络',
  })
})

test('存储：Huawei diskstats 缺失时使用 df -k /data', () => {
  const df = [
    'Filesystem     1K-blocks     Used Available Use% Mounted on',
    '/dev/block/dm-8 104857600 52428800 52428800  50% /data',
  ].join('\n')
  assert.deepEqual(parseStorage('', df), {
    storageTotal: 104857600 * 1024,
    storageUsed: 52428800 * 1024,
  })
})

test('存储：标准 diskstats 仍优先使用', () => {
  assert.deepEqual(parseStorage('Data-Free: 1024K / 4096K'), {
    storageTotal: 4096 * 1024,
    storageUsed: 3072 * 1024,
  })
})

test('内存和屏幕解析保持兼容', () => {
  assert.deepEqual(
    parseMemory('MemTotal: 4096000 kB\nMemAvailable: 2048000 kB'),
    { memTotal: 4096000 * 1024, memUsed: 2048000 * 1024 }
  )
  assert.deepEqual(
    parseScreen('Physical size: 1080x2340\nOverride size: 720x1560', 'Physical density: 480'),
    {
      resolution: '720x1560',
      physicalResolution: '1080x2340',
      density: '480',
      physicalDensity: '480',
    }
  )
})
