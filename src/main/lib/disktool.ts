import fs from 'fs-extra'
import path from 'path'
import { spawnAdb } from './adb/base'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import log from 'share/common/log'
import { IpcDiskPrepare, IpcDiskRun, IpcDiskScanAll } from 'common/types'

const logger = log('disktool')
const REMOTE = '/data/local/tmp/shine_disk_cli'

// 参数会进设备端 sh 命令行（还会被 su 0 前缀执行），必须逐项引号包裹并校验字符集
function quoteArg(arg: string) {
  const s = String(arg)
  if (!/^[A-Za-z0-9_.:@%+/-]*$/.test(s)) {
    throw new Error('非法参数: ' + s)
  }
  return `'${s}'`
}

function buildCmd(args: string[]) {
  return [REMOTE, ...args].map(quoteArg).join(' ')
}

async function sh(serial: string, cmd: string) {
  return spawnAdb(['-s', serial, 'shell', cmd])
}

function join(r: { stdout: string; stderr: string }) {
  return (String(r.stdout || '') + String(r.stderr || '')).trim()
}

const prepare: IpcDiskPrepare = async function (serial) {
  try {
    const abiOut = await sh(serial, 'getprop ro.product.cpu.abi')
    const abi = join(abiOut).toLowerCase()
    const is64 = abi.includes('arm64')
    const local = resolveResources(
      path.join('disktool', is64 ? 'shine_disk_cli_v8a' : 'shine_disk_cli_v7a')
    )
    if (!fs.existsSync(local)) {
      return { ok: false, out: '本地缺少 CLI 二进制: ' + local }
    }
    const push = await spawnAdb(['-s', serial, 'push', local, REMOTE])
    const chmod = await sh(serial, 'chmod 755 ' + REMOTE)
    const su = await sh(serial, 'su 0 id')
    const suOut = join(su)
    return {
      ok: push.code === 0 && chmod.code === 0,
      out:
        `设备 ABI: ${abi || '(未知)'}\n` +
        `推送: ${join(push) || '(无输出)'}\n` +
        `chmod: ${join(chmod) || 'OK'}\n` +
        `su 0 探测: ${suOut || '(无输出)'}`,
    }
  } catch (e: any) {
    logger.error('prepare failed', e)
    return { ok: false, out: '初始化失败: ' + (e && e.message ? e.message : e) }
  }
}

const rootTried = new Set<string>()

const run: IpcDiskRun = async function (serial, args) {
  try {
    const cmd = buildCmd(args)
    // 1) 优先 root（su 0）
    const r = await sh(serial, 'su 0 ' + cmd)
    const out = join(r)
    const okRoot = r.code === 0 && !/Permission denied|not found|inaccessible/i.test(out.slice(0, 200))
    if (okRoot) return { ok: true, out }

    // 2) 每台设备只尝试一次 adb root（adbd 重启会打断一切，不能反复做）
    // 网络设备（ip:port）绝不能 root：adbd 重启后这条 TCP 连接就没了，
    // 门店机没有本地 adb 可以把它连回来，只能等人去现场
    let rootOut = ''
    if (!rootTried.has(serial) && !serial.includes(':')) {
      rootTried.add(serial)
      const root = await spawnAdb(['-s', serial, 'root'])
      rootOut = join(root)
      if (/restarting adbd as root/i.test(rootOut)) {
        await new Promise((res) => setTimeout(res, 2500))
        await spawnAdb(['-s', serial, 'wait-for-device'], 20000)
      }
    }

    // 3) 直接运行（非 root）
    const r2 = await sh(serial, cmd)
    const out2 = join(r2)
    const parts: string[] = []
    if (out) parts.push('[su 0]', out)
    if (rootOut) parts.push('[adb root]', rootOut)
    if (out2) parts.push('[direct]', out2)
    return { ok: r2.code === 0, out: parts.join('\n') || '(无输出)' }
  } catch (e: any) {
    return { ok: false, out: '执行失败: ' + (e && e.message ? e.message : e) }
  }
}

function extractJson(out: string) {
  const clean = out
    .split('\n')
    .filter((l) => !l.startsWith('[ShineDiskToolkit]'))
    .join('\n')
  const i = clean.indexOf('{')
  const j = clean.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try {
    return JSON.parse(clean.slice(i, j + 1))
  } catch {
    return null
  }
}

const abiCache: Record<string, string> = {}

async function ensure(serial: string) {
  const abiR = await sh(serial, 'getprop ro.product.cpu.abi')
  const abi = join(abiR).toLowerCase()
  const ls = await sh(serial, `ls -l ${REMOTE}`)
  const out = join(ls)
  const exists = ls.code === 0 && !/No such file/i.test(out)
  const rightArch = abiCache[serial] === abi || !abiCache[serial]
  // 二进制缺失、或设备 ABI 变了（换过设备/系统）→ 重新推送
  if (exists && rightArch && /\s[1-9]\d{3,}\s/.test(out)) {
    abiCache[serial] = abi
    return { ok: true, out: 'CLI 已就位' }
  }
  const r = await prepare(serial)
  if (r.ok) abiCache[serial] = abi
  return r
}

const scanAll: IpcDiskScanAll = async function (serial) {
  try {
    const prep = await ensure(serial)
    if (!prep.ok) return { ok: false, out: prep.out }
    const listR = await run(serial, ['list', '--json'])
    const list = extractJson(listR.out)
    if (!list || !Array.isArray(list.disks)) {
      return { ok: false, out: '无法解析磁盘列表\n' + listR.out }
    }
    const rows: any[] = []
    for (const d of list.disks) {
      const hr = await run(serial, ['health', d.platform_id, '--json'])
      const h = extractJson(hr.out) || {}
      rows.push({
        id: d.platform_id,
        model: d.model || '',
        serial: d.serial || '',
        capacity: d.capacity_bytes || 0,
        transport: d.transport,
        system: d.system_disk === 1,
        temp:
          h.temperature_available === 1 && typeof h.temperature_celsius === 'number'
            ? h.temperature_celsius
            : null,
        hours: h.power_on_hours || 0,
        cycles: h.power_cycle_count || 0,
        // 0/1 之外还有「未上报 SMART」：不能把 null 当成失败，也不能当成健康
        passed:
          h.smart_overall_passed === 1
            ? true
            : h.smart_overall_passed === 0
              ? false
              : null,
        health: typeof h.health === 'number' ? h.health : null,
      })
    }
    return { ok: true, disks: rows }
  } catch (e: any) {
    logger.error('scanAll failed', e)
    return { ok: false, out: '扫描失败: ' + (e && e.message ? e.message : e) }
  }
}

export function init() {
  handleEvent('diskPrepare', prepare)
  handleEvent('diskRun', run)
  handleEvent('diskScanAll', scanAll)
}
