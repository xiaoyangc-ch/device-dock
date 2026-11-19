/**
 * 右键菜单：模板交给主进程用原生 Menu 弹（比自绘准，也不受窗口边界裁切）。
 * 回调函数不能过 IPC：转成 uuid，主进程点中后回发 clickContextMenu。
 */
import LunaMenu from 'luna-menu'
import isFn from 'licia/isFn'
import types from 'licia/types'

let callbacks: types.PlainObj<types.AnyFn> = {}

function transTpl(template: any[]) {
  for (const item of template as any[]) {
    if (isFn(item.click)) {
      const id = crypto.randomUUID()
      callbacks[id] = item.click
      item.click = id
    }
    if (item.type === 'submenu') {
      item.submenu = transTpl(item.submenu)
    }
  }
  return template
}

// 接管 LunaMenu.build：模板仍然在这里转换，但弹出交给主进程
const originalBuild = LunaMenu.build
LunaMenu.build = function (template) {
  const menu = originalBuild([])
  // 上一次菜单没点就关掉时回调会一直挂着：构建新菜单时清空
  callbacks = {}
  transTpl(template)
  menu.show = (x: number, y: number) => main.showContextMenu(x, y, template)
  return menu
}

export default function contextMenu(
  e: { clientX: number; clientY: number },
  template: any,
) {
  const menu = LunaMenu.build(template)
  // 等当前 click 事件结束再弹：否则菜单会被这次点击直接关掉
  setTimeout(() => menu.show(e.clientX, e.clientY), 150)
}

main.on('clickContextMenu', (id: string) => {
  const fn = callbacks[id]
  if (fn) {
    fn()
    callbacks = {}
  }
})
