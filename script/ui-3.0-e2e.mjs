// 3.0 真实交互测试：用 CDP 的鼠标事件点击文件页/侧栏，不走 DOM 伪造事件。
// 覆盖：双击进目录、返回、单击选中、搜索、设备切换。
// 用法：npm run start:debug 之后 node script/ui-3.0-e2e.mjs
const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const port = Number(arg('port', 9334))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(1500),
        })
      ).json()
      const page = list.find(
        (t) => t.type === 'page' && (t.url || '').includes('index.html')
      )
      if (page) return page
    } catch {
      // 端口未就绪
    }
    await sleep(500)
  }
  throw new Error('调试端口没起来')
}

function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
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
      errors.push(
        'EXC ' +
          (m.params.exceptionDetails.exception?.description ||
            m.params.exceptionDetails.text).split('\n')[0]
      )
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

async function main() {
  const c = await connect(await target())
  await c.send('Runtime.enable')
  await c.send('Page.enable')
  await sleep(800)
  let failed = 0

  const box = (expr) =>
    c.evaluate(`(() => {
      const el = ${expr}
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)

  const click = async (expr, count = 1) => {
    const p = await box(expr)
    if (!p) return false
    const hit = await c.evaluate(
      `(() => { const el = document.elementFromPoint(${p.x}, ${p.y}); return el ? el.tagName + '.' + (el.className || '') : null })()`
    )
    console.log('  click', Math.round(p.x), Math.round(p.y), 'hit=', hit)
    await c.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: p.x,
      y: p.y,
      button: 'left',
      clickCount: count,
    })
    await c.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: p.x,
      y: p.y,
      button: 'left',
      clickCount: count,
    })
    return true
  }

  const requiredClick = async (expr, label, count = 1) => {
    const ok = await click(expr, count)
    if (!ok) {
      failed++
      console.error(`缺少可点击元素：${label}`)
    }
    return ok
  }

  // 可见面板里的 DOM 查询（面板保活，隐藏面板还留在 DOM 里）
  const visible = `[...document.querySelectorAll('[class*="panels"] > div')].find((e) => getComputedStyle(e).visibility !== 'hidden')`

  const nav = async (label) => {
    const ok = await requiredClick(
      `[...document.querySelectorAll('aside nav button')].find((e) => ['文件', 'File'].includes(e.innerText.trim()))`,
      label
    )
    await sleep(1800)
    return ok
  }

  const crumbs = () =>
    c.evaluate(
      `(${visible})?.querySelector('[class*="crumbs"]')?.innerText.replace(/\\s+/g, ' ').trim() || ''`
    )
  const status = () =>
    c.evaluate(
      `(${visible})?.querySelector('[class*="statusbar"]')?.innerText.replace(/\\s+/g, ' ').trim() || ''`
    )
  const inspector = () =>
    c.evaluate(
      `(${visible})?.querySelector('[class*="inspector"]')?.innerText.replace(/\\s+/g, ' ').trim().slice(0, 90) || ''`
    )

  // 1. 文件页：双击第一个目录
  if (!(await nav('文件'))) throw new Error('无法进入文件页')

  // 文件页默认进入当前设备的内部存储，不一定在根目录。
  await requiredClick(
    `(${visible}).querySelector('[class*="crumbs"] button')`,
    '根目录'
  )
  await sleep(1500)

  const firstDir = await c.evaluate(`(() => {
    const panel = ${visible}
    const node = [...panel.querySelectorAll('.luna-data-grid-node')]
      .find((n) => n.querySelector('.icon-folder'))
    return node ? node.querySelector('[class*="name-text"]')?.innerText.trim() : null
  })()`)
  if (!firstDir) throw new Error('根目录没有可测试的文件夹')

  const dirClicked = await requiredClick(
    `[...(${visible}).querySelectorAll('.luna-data-grid-node')].find((n) => n.querySelector('.icon-folder'))?.querySelector('[class*="name-text"]')`,
    `文件夹 ${firstDir}`,
    2
  )
  await sleep(2000)
  console.log('双击目录:', firstDir, 'clicked=', dirClicked, '路径=', await crumbs())
  if (!(await crumbs()).includes(firstDir)) {
    failed++
    console.error('双击文件夹后路径没有进入目标目录')
  }

  // 2. 返回
  const backClicked = await requiredClick(
    `(${visible}).querySelector('[class*="navBtns"] button')`,
    '返回'
  )
  await sleep(1500)
  console.log('返回:', backClicked, '路径=', await crumbs())
  if ((await crumbs()).includes(firstDir + '/')) {
    failed++
    console.error('返回后仍停留在子目录')
  }

  // 3. 单击文件，检查器应显示详情
  const hasFile = await c.evaluate(`!![...(${visible}).querySelectorAll('.luna-data-grid-node')]
    .find((n) => !n.querySelector('.icon-folder'))`)
  if (hasFile) {
    await requiredClick(
      `[...(${visible}).querySelectorAll('.luna-data-grid-node')].find((n) => !n.querySelector('.icon-folder'))?.querySelector('[class*="name-text"]')`,
      '文件行'
    )
    await sleep(1200)
    const text = await inspector()
    console.log('选中文件，检查器=', text)
    if (!text) {
      failed++
      console.error('选中文件后检查器为空')
    }
  }

  // 4. 搜索当前目录里确定存在的文件夹名
  await c.evaluate(`(() => {
    const input = (${visible}).querySelector('input[class*="searchInput"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(firstDir)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(2200)
  const searchStatus = await status()
  console.log('搜索', firstDir, ':', searchStatus)
  const resultCount = await c.evaluate(
    `(${visible}).querySelectorAll('.luna-data-grid-node').length`
  )
  if (!resultCount) {
    failed++
    console.error('搜索确定存在的文件夹却没有结果')
  }

  await requiredClick(
    `(${visible}).querySelectorAll('.luna-data-grid-node')[0]?.querySelector('[class*="name-text"]')`,
    '搜索结果'
  )
  await sleep(1200)
  console.log('搜索选中，检查器=', await inspector())
  // 清空搜索
  await c.evaluate(`(() => {
    const input = (${visible}).querySelector('input[class*="searchInput"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(1200)

  // 5. 设备切换：点设备卡名称，选第二台
  const devices = await c.evaluate(`(() => {
    const el = document.querySelector('[class*="nameRow"]')
    return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
  })()`)
  await click(`document.querySelector('[class*="nameRow"]')`)
  await sleep(600)
  const pickerCount = await c.evaluate(
    `document.querySelectorAll('[class*="pickerItem"]').length`
  )
  if (pickerCount > 1) {
    const switchIndex = await c.evaluate(`(() => {
      const items = [...document.querySelectorAll('[class*="pickerItem"]')]
      return items.findIndex(
        (item) => !item.querySelector('[class*="current"]')
      )
    })()`)
    if (switchIndex < 0) throw new Error('没有找到可切换的另一台设备')
    const first = await c.evaluate(
      `document.querySelectorAll('[class*="pickerItem"]')[${switchIndex}].innerText.replace(/\\s+/g, ' ').trim()`
    )
    await requiredClick(
      `document.querySelectorAll('[class*="pickerItem"]')[${switchIndex}]`,
      '另一台设备'
    )
    await sleep(3000)
    const now = await c.evaluate(
      `document.querySelector('[class*="nameRow"]')?.innerText.replace(/\\s+/g, ' ').trim() || ''`
    )
    console.log('切设备: 原来=', devices, '切到=', first, '现在=', now)
    console.log('切设备后文件页:', await status())
    await sleep(1500)

    // 连续两次返回：验证历史索引用 ref 后能各退一步
    await requiredClick(
      `(${visible}).querySelector('[class*="crumbs"] button')`,
      '返回根目录'
    )
    await sleep(1500)
    const subdir = await c.evaluate(`(() => {
      const node = [...(${visible}).querySelectorAll('.luna-data-grid-node')]
        .find((n) => n.querySelector('.icon-folder'))
      return node?.querySelector('[class*="name-text"]')?.innerText.trim() || ''
    })()`)
    const sdcard = await requiredClick(
      `[...(${visible}).querySelectorAll('.luna-data-grid-node')].find((n) => n.querySelector('.icon-folder'))?.querySelector('[class*="name-text"]')`,
      '切换设备后的文件夹',
      2
    )
    await sleep(1800)
    console.log('进入文件夹:', subdir, sdcard, '路径=', await crumbs())
    const sub = await requiredClick(
      `[...(${visible}).querySelectorAll('.luna-data-grid-node')].find((n) => n.querySelector('.icon-folder'))?.querySelector('[class*="name-text"]')`,
      '二级文件夹',
      2
    )
    await sleep(1800)
    console.log('进入子目录:', sub, '路径=', await crumbs())
    await requiredClick(
      `(${visible}).querySelector('[class*="navBtns"] button')`,
      '第一次返回'
    )
    await requiredClick(
      `(${visible}).querySelector('[class*="navBtns"] button')`,
      '第二次返回'
    )
    await sleep(2200)
    console.log('连点两次返回后路径=', await crumbs())
  } else {
    console.log('设备弹层里只有 1 项，跳过切换')
  }

  const errors = c.errors.splice(0, c.errors.length)
  console.log('console errors:', JSON.stringify(errors))
  failed += errors.length
  c.ws.close()
  if (failed) throw new Error(`交互测试失败：${failed} 个检查未通过`)
}

try {
  await main()
} catch (e) {
  console.error('交互测试失败:', e.message)
  process.exit(1)
}
