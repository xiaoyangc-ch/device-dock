// 运行时冒烟：逐个侧栏页面点击，收集 console error / 未捕获异常 / ErrorBoundary
// 用法：
//   node script/smoke.mjs --port 9334                     # 连接已启动的实例
//   node script/smoke.mjs --exe release/1.6.9/win-unpacked/设备坞.exe
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}

const port = Number(arg('port', 9334))
const exe = arg('exe', '')
// 应用页首次要拉全量包信息（90 多个包实测 3.2 秒），3.5 秒会卡在边界，
// 表现为「共 0 个应用」被当成正常
const settle = Number(arg('settle', 5000))
// --strict：断言应用/进程页真的加载出数据（需要设备在线）
const strict = argv.includes('--strict')
const waitApp = Number(arg('wait', 40000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let child = null
let profile = ''

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1500),
  })
  return (await res.json()).filter((t) => t.type === 'page')
}

async function waitForApp() {
  const started = Date.now()
  while (Date.now() - started < waitApp) {
    try {
      const targets = await listTargets()
      // 多个窗口共用 index.html（投屏是 ?page=webcast）：必须排除带 page= 的，
      // 否则会连到没有侧栏的投屏窗口，报「页面: []」
      const page = targets.find(
        (t) =>
          (t.url || '').includes('index.html') &&
          !(t.url || '').includes('page='),
      )
      if (page) return page
    } catch {
      // 端口还没起来
    }
    await sleep(500)
  }
  throw new Error(`${waitApp}ms 内没有等到调试端口 ${port}`)
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const errors = []
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id
      pending.set(i, { res, rej })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      errors.push('EXC ' + (d.exception?.description || d.text).split('\n')[0])
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(
        'ERR ' +
          m.params.args
            .map((a) => a.value ?? a.description ?? a.type)
            .join(' ')
            .split('\n')[0],
      )
    }
  }
  await new Promise((r) => (ws.onopen = r))
  await send('Runtime.enable')
  await send('Page.enable')
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description || r.exceptionDetails.text,
      )
    }
    return r.result.value
  }
  return { ws, send, evaluate, errors }
}

// 3.0 壳层没有顶部页签：导航在左侧栏 nav 里的按钮上
function clickNavExpr(label) {
  return `(() => {
    const el = [...document.querySelectorAll('aside nav button')]
      .find((e) => e.innerText.trim() === ${JSON.stringify(label)})
    if (!el) return false
    el.click()
    return true
  })()`
}

const readPanelExpr = `(() => {
  const panels = [...document.querySelectorAll('[class*="panels"] > div')]
  const el = panels.filter((e) => getComputedStyle(e).visibility === 'visible')[0]
  if (!el) return null
  const text = el.innerText.replace(/\\s+/g, ' ').trim()
  return {
    textLen: text.length,
    rows: el.querySelectorAll('[class*="data-grid"] [class*="row"]').length,
    fileItems: el.querySelectorAll('[class*="file-list"] [class*="item"]').length,
    sample: text.slice(0, 60),
    crashed: text.includes('此页面出错'),
  }
})()`

async function main() {
  if (exe) {
    profile = path.join(os.tmpdir(), `devicedock-smoke-${process.pid}`)
    child = spawn(
      path.resolve(exe),
      [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`],
      { stdio: 'ignore', windowsHide: true },
    )
    console.log(`启动 ${exe}（profile: ${profile}）`)
  }

  const target = await waitForApp()
  const c = await connect(target)

  // 界面可能还没渲染完就取导航：轮询等侧栏出现，避免拿到空列表
  const waitNav = async (timeoutMs = 15000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const labels = await c.evaluate(
        `[...document.querySelectorAll('aside nav button')].map((e) => e.innerText.trim()).filter(Boolean)`,
      )
      if (Array.isArray(labels) && labels.length) return labels
      await sleep(500)
    }
    return []
  }

  const labels = await waitNav()
  console.log('页面:', JSON.stringify(labels))

  // 空列表绝不能被当成「全部通过」：侧栏没渲染、选择器改了就完全没测到东西
  if (!labels.length) {
    c.ws.close()
    console.log(
      '\n冒烟失败：侧栏没有发现任何页面（界面未渲染或导航选择器失效）',
    )
    return 1
  }

  let failed = 0
  for (const label of labels) {
    if (!label) continue
    const clicked = await c.evaluate(clickNavExpr(label))
    if (!clicked) {
      console.log(`${label}: 找不到导航项`)
      failed++
      continue
    }
    await sleep(settle)
    const panel = await c.evaluate(readPanelExpr)
    const errors = c.errors.splice(0, c.errors.length)
    // 白屏/导航没生效时 panel 存在但内容为空：不能算通过
    const noDevicePlaceholder =
      panel &&
      (panel.sample === '未连接设备' ||
        panel.sample.startsWith('终端 1 快捷命令'))
    const empty = !panel || (panel.textLen < 10 && !noDevicePlaceholder)
    // --strict：数据页必须真的加载出内容，光「不崩」不算过
    let dataShort = ''
    if (strict && panel && !empty) {
      const m = panel.sample.match(/共 (\d+) (个应用|个进程)/)
      if (m && Number(m[1]) === 0) dataShort = `数据未加载：${m[0]}`
    }
    const bad =
      empty || (panel && panel.crashed) || errors.length > 0 || !!dataShort
    if (bad) failed++
    console.log(
      `${label}: ${JSON.stringify(panel)}${dataShort ? ' ' + dataShort : ''}${errors.length ? ' errors=' + JSON.stringify(errors.slice(0, 4)) : ''}`,
    )
  }
  c.ws.close()

  if (failed) {
    console.log(`\n冒烟失败：${failed} 个页面有问题`)
    return 1
  }
  console.log(
    '\n冒烟通过：所有页面无 console error / 无异常 / 无「此页面出错」',
  )
  return 0
}

let code = 1
try {
  code = await main()
} catch (e) {
  console.error('冒烟失败:', e.message)
} finally {
  if (child && child.pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      })
    } else {
      child.kill('SIGKILL')
    }
  }
  process.exit(code)
}
