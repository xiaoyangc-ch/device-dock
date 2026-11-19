import path from 'node:path'
import fs from 'node:fs/promises'
// 真机能力矩阵：通过主窗口 CDP 调用 preload 暴露的只读 IPC。
// 用法：node script/device-matrix-e2e.mjs --port 9444 [--deep]
const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const port = Number(arg('port', 9334))
const deep = argv.includes('--deep')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(1500),
        })
      ).json()
      const page = list.find(
        (item) =>
          item.type === 'page' &&
          (item.url || '').includes('index.html') &&
          !(item.url || '').includes('page=')
      )
      if (page) return page
    } catch {
      // debug port not ready
    }
    await sleep(500)
  }
  throw new Error('主窗口调试目标未就绪')
}

function connect(cdpTarget) {
  const ws = new WebSocket(cdpTarget.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  const errors = []
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id)
      pending.delete(message.id)
      message.error
        ? item.reject(new Error(JSON.stringify(message.error)))
        : item.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails
      errors.push(
        'EXC ' +
          (detail.exception?.description || detail.text).split('\n')[0]
      )
    }
    if (
      message.method === 'Runtime.consoleAPICalled' &&
      message.params.type === 'error'
    ) {
      errors.push(
        'ERR ' +
          message.params.args
            .map((item) => item.value ?? item.description ?? item.type)
            .join(' ')
            .split('\n')[0]
      )
    }
  }

  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      const evaluate = async (expression) => {
        const result = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })
        if (result.exceptionDetails) {
          throw new Error(
            result.exceptionDetails.exception?.description ||
              result.exceptionDetails.text
          )
        }
        return result.result.value
      }
      resolve({ ws, send, evaluate, errors })
    }
    ws.onerror = reject
  })
}

async function check(name, fn) {
  const started = Date.now()
  try {
    const value = await fn()
    return { name, ok: true, ms: Date.now() - started, value }
  } catch (e) {
    return {
      name,
      ok: false,
      ms: Date.now() - started,
      error: e?.message || String(e),
    }
  }
}

async function terminalCheck(evaluate, deviceId) {
  const marker = `DEVICEDOCK_E2E_${Date.now()}`
  return evaluate(`new Promise(async (resolve) => {
    const deviceId = ${JSON.stringify(deviceId)}
    const marker = ${JSON.stringify(marker)}
    let output = ''
    let sessionId = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      off()
      clearTimeout(timer)
      if (sessionId) main.killShell(sessionId)
      resolve(value)
    }
    const off = main.on('shellData', (id, data) => {
      if (id !== sessionId) return
      output += data
      if (output.includes(marker)) finish({ ok: true, output: output.slice(-500) })
    })
    const timer = setTimeout(() => finish({ ok: false, output: output.slice(-500) }), 8000)
    try {
      sessionId = await main.createShell(deviceId)
      main.writeShell(sessionId, 'echo ' + marker + '\\n')
    } catch (e) {
      finish({ ok: false, error: e?.message || String(e) })
    }
  })`)
}

async function main() {
  const client = await connect(await target())
  await client.send('Runtime.enable')
  await client.send('Page.enable')

  const devices = await client.evaluate('main.getDevices()')
  if (!devices.length) throw new Error('没有在线设备')

  const report = {
    startedAt: new Date().toISOString(),
    deviceCount: devices.length,
    devices: [],
    representatives: {},
    consoleErrors: [],
  }
  let failed = 0

  for (const device of devices) {
    const idLiteral = JSON.stringify(device.id)
    const checks = []
    checks.push(
      await check('latency', async () => {
        const result = await client.evaluate(`main.measureLatency(${idLiteral})`)
        if (result.ms < 0) throw new Error('latency failed')
        return result.ms
      })
    )
    checks.push(
      await check('overview', async () => {
        const value = await client.evaluate(`main.getOverview(${idLiteral})`)
        return {
          name: value.name,
          model: value.model,
          android: device.androidVersion,
          kernel: value.kernelVersion,
          resolution: value.resolution,
          root: value.root,
        }
      })
    )
    checks.push(
      await check('files', async () => {
        const value = await client.evaluate(
          `main.readDirPage(${idLiteral}, '/sdcard/', 0, 10)`
        )
        return { files: value.files.length, total: value.total }
      })
    )
    checks.push(
      await check('packages', async () => {
        const names = await client.evaluate(
          `main.getPackages(${idLiteral}, true)`
        )
        const sample = names.slice(0, 20)
        const infos = await client.evaluate(
          `main.getPackageInfos(${idLiteral}, ${JSON.stringify(sample)})`
        )
        if (infos.length !== sample.length) {
          const returned = new Set(infos.map((info) => info.packageName))
          const missing = sample.filter((name) => !returned.has(name))
          throw new Error(
            `应用详情缺项: ${infos.length}/${sample.length}，缺少 ${missing.join(',')}`
          )
        }
        return {
          count: names.length,
          sample: infos.map((info) => ({
            name: info.packageName,
            label: info.label,
            icon: Boolean(info.icon),
          })),
        }
      })
    )
    checks.push(
      await check('packageApkExport', async () => {
        const names = await client.evaluate(
          `main.getPackages(${idLiteral}, true)`
        )
        const sample = names.slice(0, 30)
        const infos = await client.evaluate(
          `main.getPackageInfos(${idLiteral}, ${JSON.stringify(sample)})`
        )
        const candidates = []
        for (const info of infos) {
          let apkPath = info.apkPath
          if (!apkPath) {
            apkPath = await client.evaluate(
              `main.getPackageApkPath(${idLiteral}, ${JSON.stringify(info.packageName)})`
            )
          }
          if (!apkPath) continue
          let size = Number(info.apkSize) || 0
          if (!size) {
            try {
              const stat = await client.evaluate(
                `main.statFile(${idLiteral}, ${JSON.stringify(apkPath)})`
              )
              size = Number(stat.size) || 0
            } catch {
              // 仍可尝试下载，最终以拉取结果为准
            }
          }
          candidates.push({ info, apkPath, size })
        }
        if (!candidates.length) throw new Error('没有任何应用返回 APK 路径')

        const small = candidates
          .filter((item) => item.size > 0 && item.size <= 16 * 1024 * 1024)
          .sort((a, b) => a.size - b.size)[0]
        const selected = small || candidates[0]
        const dest = path.join(
          '/tmp',
          `devicedock-e2e-${device.id.replace(/[^\w.-]+/g, '_')}-${Date.now()}.apk`
        )
        try {
          await client.evaluate(
            `main.pullFile(${idLiteral}, ${JSON.stringify(selected.apkPath)}, ${JSON.stringify(dest)}, { overwrite: true })`
          )
          const stat = await fs.stat(dest)
          if (!stat.size) throw new Error('下载的 APK 为 0 字节')
          return {
            package: selected.info.packageName,
            path: selected.apkPath,
            bytes: stat.size,
          }
        } finally {
          await fs.rm(dest, { force: true }).catch(() => undefined)
        }
      })
    )
    checks.push(
      await check('processes', async () => {
        const value = await client.evaluate(`main.getProcesses(${idLiteral})`)
        return value.length
      })
    )
    checks.push(
      await check('performance', async () => {
        const value = await client.evaluate(
          `main.getPerformance(${idLiteral})`
        )
        return {
          cpus: value.cpus.length,
          memoryUsed: value.memUsed,
          battery: value.batteryLevel,
          temperature: value.cpuTemperature,
        }
      })
    )
    checks.push(
      await check('screen', async () => {
        const bytes = await client.evaluate(
          `(async () => { const data = await main.screencapRaw(${idLiteral}); return data ? data.byteLength : 0 })()`
        )
        // screencapRaw 在画面和上一帧相同时按设计返回 null，改用 base64 接口确认设备仍能截图。
        if (bytes) return { rawBytes: bytes, unchanged: false }
        const base64 = await client.evaluate(`main.screencap(${idLiteral})`)
        if (!base64) throw new Error('empty screenshot')
        return { rawBytes: 0, unchanged: true, base64Length: base64.length }
      })
    )
    checks.push(
      await check('terminal', () => terminalCheck(client.evaluate, device.id))
    )

    const passed = checks.filter((item) => item.ok).length
    if (passed !== checks.length) failed++
    report.devices.push({
      id: device.id,
      model: device.name,
      android: device.androidVersion,
      sdk: device.sdkVersion,
      passed,
      total: checks.length,
      checks,
    })
  }

  if (deep) {
    const android11 =
      devices.find(
        (device) =>
          device.androidVersion === '11' ||
          Number(device.sdkVersion || 0) >= 30
      ) || devices[0]
    const android8 =
      devices.find((device) => Number(device.sdkVersion || 0) < 30) ||
      devices[0]

    for (const [label, device] of [
      ['android11', android11],
      ['android8', android8],
    ]) {
      const idLiteral = JSON.stringify(device.id)
      report.representatives[label] = {
        device: device.id,
        logcat: await check('logcat', async () => {
          const logcatId = await client.evaluate(
            `main.openLogcat(${idLiteral})`
          )
          await sleep(1200)
          await client.evaluate(
            `main.closeLogcat(${JSON.stringify(logcatId)})`
          )
          return logcatId
        }),
        topPackage: await check('topPackage', () =>
          client.evaluate(`main.getTopPackage(${idLiteral})`)
        ),
        uptime: await check('uptime', () =>
          client.evaluate(`main.getUptime(${idLiteral})`)
        ),
        diskScan: await check('diskScan', async () => {
          const value = await client.evaluate(
            `main.diskScanAll(${idLiteral})`
          )
          return {
            ok: value.ok,
            disks: value.disks?.length || 0,
            out: value.out?.slice(0, 300),
          }
        }),
      }
    }

    report.representatives.searchIndex = await check('searchIndex', async () => {
      const value = await client.evaluate(
        `main.searchDir(${JSON.stringify(android11.id)}, '/sdcard/', 'mp4', true, 0, 20)`
      )
      return {
        files: value.files.length,
        total: value.total,
        partial: Boolean(value.partial),
      }
    })

    report.representatives.directoryPagination = await check(
      'directoryPagination',
      async () => {
        const remoteDir = `/sdcard/Download/devicedock-e2e-${Date.now()}`
        const remoteFile = `${remoteDir}/package.json`
        const localFile = path.resolve(
          import.meta.dirname,
          '../package.json'
        )
        try {
          await client.evaluate(
            `main.createDir(${JSON.stringify(android11.id)}, ${JSON.stringify(remoteDir)})`
          )
          await client.evaluate(
            `main.pushFile(${JSON.stringify(android11.id)}, ${JSON.stringify(localFile)}, ${JSON.stringify(remoteFile)})`
          )
          const page = await client.evaluate(
            `main.readDirPage(${JSON.stringify(android11.id)}, ${JSON.stringify(remoteDir)}, 0, 20)`
          )
          if (
            page.total !== 1 ||
            page.files.length !== 1 ||
            page.files[0]?.name !== 'package.json'
          ) {
            throw new Error(
              `分页结果错误: total=${page.total}, files=${page.files.map((item) => item.name).join(',') || '(empty)'}`
            )
          }
          return { total: page.total, files: page.files.map((item) => item.name) }
        } finally {
          await client
            .evaluate(
              `main.deleteDir(${JSON.stringify(android11.id)}, ${JSON.stringify(remoteDir)})`
            )
            .catch(() => undefined)
        }
      }
    )
  }

  await sleep(300)
  report.consoleErrors = client.errors.splice(0, client.errors.length)
  client.ws.close()
  console.log(JSON.stringify(report, null, 2))
  if (failed || report.consoleErrors.length) process.exitCode = 1
}

main().catch((e) => {
  console.error('设备矩阵测试失败:', e)
  process.exitCode = 1
})
