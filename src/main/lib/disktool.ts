/**
 * 硬盘检测：把 DiskToolkit CLI 推到设备上，用 su/直接执行拿 SMART 信息。
 *
 * 安全约束：
 * - 所有参数逐项校验字符集 + 单引号包裹（会进 su 0 之后的 sh 命令行）；
 * - 网络设备（ip:port）绝不执行 adb root：adbd 重启会断掉 TCP，门店机没人能连回来。
 */
import fs from 'fs-extra'
import path from 'node:path'
import { spawnAdb } from './adb/base'
import { handleEvent, resolveResources } from 'share/main/lib/util'
import log from 'share/common/log'
import { IpcDiskPrepare, IpcDiskRun, IpcDiskScanAll } from 'common/types'

const logger = log('disktool')
const REMOTE = '/data/local/tmp/shine_disk_cli'
const EMMC_REMOTE = '/data/local/tmp/emmc_health'
const emmcReady = new Set<string>()

function quoteArg(arg: string) {
  const value = String(arg)
  if (!/^[A-Za-z0-9_.:@%+/-]*$/.test(value)) {
    throw new Error('非法参数: ' + value)
  }
  return `'${value}'`
}

function buildCmd(args: string[]) {
  return [REMOTE, ...args].map(quoteArg).join(' ')
}

function shell(serial: string, cmd: string) {
  return spawnAdb(['-s', serial, 'shell', cmd])
}

function outputOf(result: { stdout: string; stderr: string }) {
  return (String(result.stdout || '') + String(result.stderr || '')).trim()
}

const prepare: IpcDiskPrepare = async (serial) => {
  try {
    const abi = outputOf(await shell(serial, 'getprop ro.product.cpu.abi'))
      .toLowerCase()
    const is64 = abi.includes('arm64')
    const local = resolveResources(
      path.join('disktool', is64 ? 'shine_disk_cli_v8a' : 'shine_disk_cli_v7a')
    )
    if (!fs.existsSync(local)) {
      return { ok: false, out: '本地缺少 CLI 二进制: ' + local }
    }

    const push = await spawnAdb(['-s', serial, 'push', local, REMOTE])
    const chmod = await shell(serial, 'chmod 755 ' + REMOTE)
    const su = outputOf(await shell(serial, 'su 0 id'))

    return {
      ok: push.code === 0 && chmod.code === 0,
      out:
        `设备 ABI: ${abi || '(未知)'}\n` +
        `推送: ${outputOf(push) || '(无输出)'}\n` +
        `chmod: ${outputOf(chmod) || 'OK'}\n` +
        `su 0 探测: ${su || '(无输出)'}`,
    }
  } catch (e: any) {
    logger.error('prepare failed', e)
    return { ok: false, out: '初始化失败: ' + (e?.message || e) }
  }
}

const rootTried = new Set<string>()

const run: IpcDiskRun = async (serial, args) => {
  try {
    const cmd = buildCmd(args)

    // 1) 优先 root
    const rooted = await shell(serial, 'su 0 ' + cmd)
    const rootedOut = outputOf(rooted)
    const rootOk =
      rooted.code === 0 &&
      !/Permission denied|not found|inaccessible/i.test(rootedOut.slice(0, 200))
    if (rootOk) return { ok: true, out: rootedOut }

    // 2) 每台设备最多尝试一次 adb root：
    // 网络设备绝不能做，adbd 重启后这条 TCP 就没了，只能到现场救
    let rootOut = ''
    if (!rootTried.has(serial) && !serial.includes(':')) {
      rootTried.add(serial)
      rootOut = outputOf(await spawnAdb(['-s', serial, 'root']))
      if (/restarting adbd as root/i.test(rootOut)) {
        await new Promise((resolve) => setTimeout(resolve, 2500))
        await spawnAdb(['-s', serial, 'wait-for-device'], 20000)
      }
    }

    // 3) 非 root 直接执行
    const direct = await shell(serial, cmd)
    const directOut = outputOf(direct)

    const parts: string[] = []
    if (rootedOut) parts.push('[su 0]', rootedOut)
    if (rootOut) parts.push('[adb root]', rootOut)
    if (directOut) parts.push('[direct]', directOut)
    return { ok: direct.code === 0, out: parts.join('\n') || '(无输出)' }
  } catch (e: any) {
    return { ok: false, out: '执行失败: ' + (e?.message || e) }
  }
}

/** CLI 会在 JSON 前后打日志：截取第一个 { 到最后一个 } 再解析。 */
function extractJson(out: string) {
  const clean = out
    .split('\n')
    .filter((line) => !line.startsWith('[ShineDiskToolkit]'))
    .join('\n')

  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    return JSON.parse(clean.slice(start, end + 1))
  } catch {
    return null
  }
}

/** eMMC 检查器是独立的小二进制：只有 1MB 多，按 ABI 推一次就够。 */
async function ensureEmmc(serial: string) {
  if (emmcReady.has(serial)) return true

  try {
    const abi = outputOf(await shell(serial, 'getprop ro.product.cpu.abi'))
      .toLowerCase()
    const local = resolveResources(
      path.join(
        'disktool',
        abi.includes('arm64') ? 'emmc_health_v8a' : 'emmc_health_v7a'
      )
    )
    if (!fs.existsSync(local)) return false

    const push = await spawnAdb(['-s', serial, 'push', local, EMMC_REMOTE])
    const chmod = await shell(serial, 'chmod 755 ' + EMMC_REMOTE)
    if (push.code !== 0 || chmod.code !== 0) return false

    emmcReady.add(serial)
    return true
  } catch {
    return false
  }
}

function emmcPreEolText(value: number) {
  if (value === 0x01) return '正常'
  if (value === 0x02) return '警告（预留块已耗 80%-90%）'
  if (value === 0x03) return '紧急（预留块耗尽 >90%）'
  return '未知'
}

function emmcLifeText(value: number) {
  if (value >= 0x01 && value <= 0x0a) return `${(value - 1) * 10}%-${value * 10}%`
  if (value === 0x0b) return '超过设计寿命'
  return '未知'
}

function emmcVerdictText(value: unknown) {
  switch (value) {
    case 'ok':
      return '正常'
    case 'warning':
      return '警告'
    case 'urgent':
      return '紧急'
    default:
      return '未知'
  }
}

function emmcReport(data: any) {
  const capacity = Number(data.capacity_bytes) || 0
  const gib = capacity / 1024 / 1024 / 1024
  const lines = [
    'eMMC 健康检测',
    `设备: ${data.device || '-'} (${data.node || '-'})`,
    `型号: ${data.name || '未知'}`,
    `厂商: ${data.manufacturer || '未知'}${data.manfid ? ` (MANFID ${data.manfid})` : ''}`,
    `容量: ${gib.toFixed(1)} GiB`,
    `序列号: ${data.serial || '-'}  生产日期: ${data.date || '-'}`,
    `预留块状态(pre_eol_info): ${emmcPreEolText(Number(data.pre_eol))}`,
    `寿命估计A: ${emmcLifeText(Number(data.life_a))}`,
    `寿命估计B: ${emmcLifeText(Number(data.life_b))}`,
    `综合结论: ${emmcVerdictText(data.verdict)}`,
    `数据来源: ${data.source || '-'}`,
  ]

  if (data.error) lines.push(`读取说明: ${data.error}`)
  if (data.os_error) lines.push(`系统返回: ${data.os_error}`)
  return lines.join('\n')
}

/** 读 eMMC 的身份信息 + JEDEC Ext CSD 健康字段；失败返回 null，不阻塞硬盘列表。 */
async function scanEmmc(serial: string) {
  if (!(await ensureEmmc(serial))) return null

  try {
    // 网络设备不做 adb root（会断 TCP）；只尝试 su 0，失败则降级为无健康字段。
    const rooted = await shell(serial, `su 0 ${EMMC_REMOTE} --json`)
    const rootedOut = outputOf(rooted)
    const rootOk =
      rooted.code === 0 &&
      !/Permission denied|not found|inaccessible/i.test(rootedOut.slice(0, 200))

    const out = rootOk
      ? rootedOut
      : outputOf(await shell(serial, `${EMMC_REMOTE} --json`))
    const data = extractJson(out)
    if (!data || !data.device) return null

    const verdict = data.verdict
    const passed =
      verdict === 'ok' ? true : verdict === 'warning' || verdict === 'urgent' ? false : null

    return {
      id: `emmc:${data.device}`,
      model: [data.manufacturer, data.name].filter(Boolean).join(' ') || 'eMMC',
      serial: data.serial || '',
      capacity: Number(data.capacity_bytes) || 0,
      transport: 'emmc',
      system: true,
      temp: null,
      hours: 0,
      cycles: 0,
      passed,
      health: null,
      emmc: data,
      report: emmcReport(data),
    }
  } catch {
    return null
  }
}

const abiCache: Record<string, string> = {}

async function ensure(serial: string) {
  const abi = outputOf(await shell(serial, 'getprop ro.product.cpu.abi'))
    .toLowerCase()
  const ls = await shell(serial, `ls -l ${REMOTE}`)
  const lsOut = outputOf(ls)

  const exists = ls.code === 0 && !/No such file/i.test(lsOut)
  const rightArch = abiCache[serial] === abi || !abiCache[serial]

  // 缺失、ABI 变了、或文件大小为 0：重新推
  if (exists && rightArch && /\s[1-9]\d{3,}\s/.test(lsOut)) {
    abiCache[serial] = abi
    return { ok: true, out: 'CLI 已就位' }
  }
  const result = await prepare(serial)
  if (result.ok) abiCache[serial] = abi
  return result
}

const scanAll: IpcDiskScanAll = async (serial) => {
  const rows: any[] = []
  let hardOut = ''

  try {
    const prep = await ensure(serial)
    if (!prep.ok) {
      hardOut = prep.out
    } else {
      const listResult = await run(serial, ['list', '--json'])
      const list = extractJson(listResult.out)
      if (!list || !Array.isArray(list.disks)) {
        hardOut = '无法解析磁盘列表\n' + listResult.out
      } else {
        for (const disk of list.disks) {
          const health = extractJson(
            (await run(serial, ['health', disk.platform_id, '--json'])).out
          ) || {}

          rows.push({
            id: disk.platform_id,
            model: disk.model || '',
            serial: disk.serial || '',
            capacity: disk.capacity_bytes || 0,
            transport: disk.transport,
            system: disk.system_disk === 1,
            temp:
              health.temperature_available === 1 &&
              typeof health.temperature_celsius === 'number'
                ? health.temperature_celsius
                : null,
            hours: health.power_on_hours || 0,
            cycles: health.power_cycle_count || 0,
            // 0/1 之外还有「未上报 SMART」：null 既不是失败也不是健康
            passed:
              health.smart_overall_passed === 1
                ? true
                : health.smart_overall_passed === 0
                  ? false
                  : null,
            health: typeof health.health === 'number' ? health.health : null,
          })
        }
      }
    }
  } catch (e: any) {
    hardOut = '硬盘扫描失败: ' + (e?.message || e)
  }

  // eMMC 与 SATA/USB 是两条独立通道；外接盘工具失败也要把内置 eMMC 显示出来。
  // DiskToolkit 的 list 本身可能也把 mmcblk0 当系统盘列出来：这种情况下用
  // eMMC 的健康数据覆盖那一行，避免同一块盘出现两行（一行还误报异常）。
  const emmc = await scanEmmc(serial)
  if (emmc) {
    const target = String(emmc.emmc?.device || '')
    const index = rows.findIndex((disk) => {
      const id = String(disk.id || '')
      return (
        id === target ||
        disk.transport === 'emmc' ||
        (id.startsWith('mmcblk') && /emmc/i.test(String(disk.model || '')))
      )
    })

    if (index >= 0) {
      rows[index] = {
        ...rows[index],
        ...emmc,
        id: rows[index].id,
      }
    } else {
      rows.push(emmc)
    }
  }

  if (!rows.length) {
    return { ok: false, out: hardOut || '未发现可检测的硬盘或 eMMC' }
  }
  return { ok: true, disks: rows, out: hardOut }
}

export function init() {
  handleEvent('diskPrepare', prepare)
  handleEvent('diskRun', run)
  handleEvent('diskScanAll', scanAll)
}
