// 3.0 UI 冒烟 + 截图：按左侧导航逐个页面点击，检查 ErrorBoundary / console error，
// 并对文件页做一次「列目录 → 搜索 → 选中 → 检查器」的真实交互。
// 用法：npm run start:debug 之后 node script/ui-3.0.mjs [--port 9334]
import fs from 'node:fs/promises'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const port = Number(arg('port', 9334))
const settle = Number(arg('settle', 2500))
const outDir = path.resolve(arg('out', 'docs/ui-3.0/verify'))
const theme = arg('theme', '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1500),
  })
  return (await res.json()).filter((t) => t.type === 'page')
}

async function waitForApp() {
  const started = Date.now()
  while (Date.now() - started < 40000) {
    try {
      const page = (await listTargets()).find((t) =>
        (t.url || '').includes('index.html')
      )
      if (page) return page
    } catch {
      // 端口还没起来
    }
    await sleep(500)
  }
  throw new Error('40s 内没有等到调试端口')
}

function connect(target) {
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
            .split('\n')[0]
      )
    }
  }
  return new Promise((r) =>
    (ws.onopen = () =>
      r({
        ws,
        send,
        errors,
        evaluate: async (expression) => {
          const res = await send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
          })
          if (res.exceptionDetails) {
            throw new Error(
              res.exceptionDetails.exception?.description ||
                res.exceptionDetails.text
            )
          }
          return res.result.value
        },
      }))
  )
}

const clickNav = (label) => `(() => {
  const el = [...document.querySelectorAll('aside nav button')]
    .find((e) => e.innerText.trim() === ${JSON.stringify(label)})
  if (!el) return false
  el.click()
  return true
})()`

const readPanel = `(() => {
  const panels = [...document.querySelectorAll('[class*="panels"] > div')]
  const el = panels.filter((e) => getComputedStyle(e).visibility === 'visible')[0]
  if (!el) return null
  const text = el.innerText.replace(/\\s+/g, ' ').trim()
  return {
    textLen: text.length,
    rows: el.querySelectorAll('.luna-data-grid-node').length,
    empty: !!el.querySelector('[class*="empty"]'),
    sample: text.slice(0, 80),
    crashed: text.includes('此页面出错'),
  }
})()`

async function shot(c, name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' })
  const prefix = theme ? theme + '-' : ''
  await fs.writeFile(
    path.join(outDir, `${prefix}${name}.png`),
    Buffer.from(r.data, 'base64')
  )
}

async function main() {
  await fs.mkdir(outDir, { recursive: true })
  const target = await waitForApp()
  const c = await connect(target)
  await c.send('Runtime.enable')
  await c.send('Page.enable')
  await sleep(1500)

  // 指定主题：截图前先切，避免拿系统深色当浅色验收
  if (theme) {
    await c.evaluate(`main.setSettingsStore('theme', ${JSON.stringify(theme)})`)
    await sleep(1200)
  }

  const labels = await c.evaluate(
    `[...document.querySelectorAll('aside nav button')].map((e) => e.innerText.trim())`
  )
  console.log('导航:', JSON.stringify(labels))
  if (!labels.length) throw new Error('左侧导航为空，壳层没有渲染')

  let failed = 0
  for (const label of labels) {
    const clicked = await c.evaluate(clickNav(label))
    if (!clicked) {
      console.log(`${label}: 点击失败`)
      failed++
      continue
    }
    await sleep(settle)
    const panel = await c.evaluate(readPanel)
    const errors = c.errors.splice(0, c.errors.length)
    const bad = !panel || panel.crashed || errors.length > 0
    if (bad) failed++
    console.log(
      `${label}: ${JSON.stringify(panel)}${errors.length ? ' errors=' + JSON.stringify(errors.slice(0, 3)) : ''}`
    )
    await shot(c, `page-${labels.indexOf(label) + 1}-${label}`)
  }

  // ---- 文件页专项：列目录 / 搜索 / 选中 ----
  await c.evaluate(clickNav('文件'))
  await sleep(3000)
  const fileState = await c.evaluate(`(() => {
    const rows = document.querySelectorAll('[class*="panels"] .luna-data-grid-node')
    const status = document.querySelector('[class*="statusbar"]')?.innerText || ''
    return { rows: rows.length, status: status.replace(/\\s+/g, ' ').trim().slice(0, 120) }
  })()`)
  console.log('文件页:', JSON.stringify(fileState))

  const searched = await c.evaluate(`(() => {
    const input = document.querySelector('input[class*="searchInput"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'a')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(2500)
  const searchState = await c.evaluate(`(() => {
    const status = document.querySelector('[class*="statusbar"]')?.innerText || ''
    const rows = document.querySelectorAll('[class*="panels"] .luna-data-grid-node').length
    return { rows, status: status.replace(/\\s+/g, ' ').trim().slice(0, 120) }
  })()`)
  console.log('搜索 "a":', JSON.stringify(searchState), 'input=', searched)

  const selected = await c.evaluate(`(() => {
    const row = document.querySelector('[class*="panels"] .luna-data-grid-node')
    if (!row) return false
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })()`)
  await sleep(1200)
  const inspector = await c.evaluate(`(() => {
    const el = document.querySelector('[class*="inspector"]')
    return el ? el.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120) : null
  })()`)
  console.log('选中第一行:', selected, '检查器:', inspector)

  // 清空搜索，恢复目录
  await c.evaluate(`(() => {
    const input = document.querySelector('input[class*="searchInput"]')
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(1500)

  // ---- 主题截图由 --theme 参数控制 ----
  const errors = c.errors.splice(0, c.errors.length)
  if (errors.length) {
    failed++
    console.log('剩余错误:', JSON.stringify(errors.slice(0, 8)))
  }
  c.ws.close()
  console.log(`\n截图目录: ${outDir}`)
  return failed ? 1 : 0
}

let code = 1
try {
  code = await main()
} catch (e) {
  console.error('UI 测试失败:', e.message)
}
process.exit(code)
