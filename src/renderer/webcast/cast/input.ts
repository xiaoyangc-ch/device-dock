/**
 * 投屏窗口的输入绑定：指针（鼠标/触摸/滚轮）与物理键盘。
 *
 * 坐标换算按「等比缩放 + 居中黑边」反推，和多指 pointerId 分配一起，
 * 是这块最容易出错的地方，所以单独成文件。
 */
import { AndroidKeyCode } from '@yume-chan/scrcpy'
import { ControlChannel } from './control'
import { TouchAction } from './protocol'

export interface InputDeps {
  control: ControlChannel
  getSize: () => { width: number; height: number }
  getIme: () => string
  onToast: (message: string) => void
  readClipboard: () => Promise<string>
}

/** 这几个键走 keycode，其它单字符走 INJECT_TEXT */
const SPECIAL_KEYS: Record<string, number> = {
  Enter: 66,
  Backspace: 67,
  Tab: 61,
  Escape: 111,
  Delete: 112,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  Insert: 124,
  F1: 131,
  F2: 132,
  F3: 133,
  F4: 134,
  F5: 135,
  F6: 136,
  F7: 137,
  F8: 138,
  F9: 139,
  F10: 140,
  F11: 141,
  F12: 142,
}

const MAX_POINTERS = 31

function hasNonAscii(text: string) {
  for (const ch of text) {
    if (ch.codePointAt(0)! > 127) return true
  }
  return false
}

export function bindPointer(el: HTMLVideoElement, deps: InputDeps) {
  const activePointers = new Map<number, number>()
  const lastPoints = new Map<
    number,
    { x: number; y: number; width: number; height: number }
  >()

  function toDevicePoint(e: { clientX: number; clientY: number }) {
    let { width, height } = deps.getSize()

    // 元数据里的尺寸可能和实际解码尺寸不同（设备旋转/副屏）
    if (el.videoWidth && el.videoHeight) {
      width = el.videoWidth
      height = el.videoHeight
    }
    if (!width || !height) return null

    const rect = el.getBoundingClientRect()
    const scale = Math.min(rect.width / width, rect.height / height)
    const drawnWidth = width * scale
    const drawnHeight = height * scale
    const left = rect.left + (rect.width - drawnWidth) / 2
    const top = rect.top + (rect.height - drawnHeight) / 2

    const x = Math.round((e.clientX - left) / scale)
    const y = Math.round((e.clientY - top) / scale)

    return {
      x: Math.max(0, Math.min(width - 1, x)),
      y: Math.max(0, Math.min(height - 1, y)),
      width,
      height,
    }
  }

  function allocatePointerId() {
    // Android 只接受 0..31；0 留给「主指/鼠标」，多指从 1 开始找空位
    const used = new Set(activePointers.values())
    for (let id = 1; id < MAX_POINTERS; id++) {
      if (!used.has(id)) return id
    }
    return 1
  }

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault()
    el.focus()

    // 右键 = 返回，中键 = 桌面：和常见投屏工具习惯一致
    if (e.button === 2) {
      deps.control.key(AndroidKeyCode.AndroidBack)
      return
    }
    if (e.button === 1) {
      deps.control.key(AndroidKeyCode.AndroidHome)
      return
    }
    if (e.button !== 0) return

    el.setPointerCapture?.(e.pointerId)
    const point = toDevicePoint(e)
    if (!point) return

    const isPrimary = activePointers.size === 0
    const pointerId = isPrimary ? 0 : allocatePointerId()
    activePointers.set(e.pointerId, pointerId)
    lastPoints.set(e.pointerId, point)

    deps.control.touch(
      isPrimary ? TouchAction.Down : TouchAction.PointerDown,
      point.x,
      point.y,
      point.width,
      point.height,
      isPrimary ? undefined : pointerId
    )
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!activePointers.has(e.pointerId)) return

    const point = toDevicePoint(e)
    if (!point) return
    lastPoints.set(e.pointerId, point)

    const pointerId = activePointers.get(e.pointerId)!
    deps.control.touch(
      TouchAction.Move,
      point.x,
      point.y,
      point.width,
      point.height,
      pointerId === 0 ? undefined : pointerId
    )
  }

  const onPointerRelease = (e: PointerEvent) => {
    if (!activePointers.has(e.pointerId)) return

    const pointerId = activePointers.get(e.pointerId)!
    // 手指抬起时可能已经移出画面：退回最后一次有效坐标，
    // 否则漏发 UP 会在设备上留下「卡住的手势」
    const point = toDevicePoint(e) || lastPoints.get(e.pointerId)
    activePointers.delete(e.pointerId)
    lastPoints.delete(e.pointerId)
    if (!point) return

    // 还有别的手指按着就发 POINTER_UP；先抬主指发 UP 会让 Android 直接结束整个手势
    const action =
      activePointers.size === 0 ? TouchAction.Up : TouchAction.PointerUp
    deps.control.touch(
      action,
      point.x,
      point.y,
      point.width,
      point.height,
      pointerId === 0 ? undefined : pointerId
    )
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()

    const point = toDevicePoint(e)
    if (!point) return

    // scrcpy 的滚动量是 [-1, 1] 定点：120 的一格滚轮 ≈ 1.2 个单位，这里缩到 1/100
    deps.control.scroll(
      point.x,
      point.y,
      point.width,
      point.height,
      -e.deltaX / 100,
      -e.deltaY / 100
    )
  }

  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', onPointerRelease)
  el.addEventListener('pointercancel', onPointerRelease)
  el.addEventListener('wheel', onWheel, { passive: false })

  return () => {
    el.removeEventListener('pointerdown', onPointerDown)
    el.removeEventListener('pointermove', onPointerMove)
    el.removeEventListener('pointerup', onPointerRelease)
    el.removeEventListener('pointercancel', onPointerRelease)
    el.removeEventListener('wheel', onWheel)
    activePointers.clear()
    lastPoints.clear()
  }
}

function pasteFromHost(deps: InputDeps) {
  deps
    .readClipboard()
    .then((text) => {
      if (!text) {
        deps.onToast('剪贴板为空')
        return
      }
      deps.control.paste(text)
    })
    .catch(() => {
      deps.onToast('读取剪贴板失败')
    })
}

export function bindKeyboard(deps: InputDeps) {
  const onKeyDown = (e: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    if (!deps.control.ready) return

    // Ctrl 组合：沿用 scrcpy 的快捷键，投入成本最低
    if (e.ctrlKey && !e.metaKey && !e.altKey) {
      const key = e.key.toLowerCase()
      e.preventDefault()

      switch (key) {
        case 'h':
          deps.control.key(AndroidKeyCode.AndroidHome)
          return
        case 'b':
          deps.control.key(AndroidKeyCode.AndroidBack)
          return
        case 's':
          deps.control.key(AndroidKeyCode.AndroidAppSwitch)
          return
        case 'm':
          deps.control.key(AndroidKeyCode.ContextMenu)
          return
        case 'p':
          deps.control.key(AndroidKeyCode.Power)
          return
        case 'o':
          deps.control.screenPower(e.shiftKey ? 2 : 0)
          return
        case 'r':
          deps.control.command(11)
          return
        case 'n':
          deps.control.command(e.shiftKey ? 7 : 5)
          return
        case 'v':
          pasteFromHost(deps)
          return
        case 'c':
          // 设备端复制：复制结果由剪贴板同步回传
          deps.control.key(AndroidKeyCode.AndroidCopy)
          return
        case 'x':
          deps.control.key(AndroidKeyCode.AndroidCut)
          return
        case 'a':
          deps.control.chord(
            AndroidKeyCode.ControlLeft,
            AndroidKeyCode.KeyA,
            0x1000
          )
          return
        default:
          return
      }
    }

    if (e.metaKey || e.altKey) return

    const special = SPECIAL_KEYS[e.key]
    if (special) {
      e.preventDefault()
      deps.control.key(special, e.shiftKey ? 1 : 0, e.repeat ? 1 : 0)
      return
    }

    // 输入法/键盘布局会把 Shift、CapsLock 下的小写字母报成 e.key='a'：
    // 用 e.code 兜底，再按 Shift XOR CapsLock 还原大小写
    let char = e.key
    const letter = /^Key([A-Z])$/.exec(e.code)
    if (letter && (char.length !== 1 || /^[a-z]$/i.test(char))) {
      char = letter[1]
    }
    if (/^[a-z]$/i.test(char)) {
      const capsLock = e.getModifierState('CapsLock')
      char = e.shiftKey !== capsLock ? char.toUpperCase() : char.toLowerCase()
    }
    if (char.length !== 1) return

    e.preventDefault()

    // 非 ASCII、或中文输入法下的大写字母：走剪贴板粘贴绕开输入法
    const ime = deps.getIme()
    const usePaste =
      hasNonAscii(char) ||
      (/^[A-Z]$/.test(char) && ime !== '' && !ime.includes('latin'))

    if (usePaste) {
      deps.control.paste(char)
    } else {
      deps.control.text(char)
    }
  }

  document.addEventListener('keydown', onKeyDown)
  return () => document.removeEventListener('keydown', onKeyDown)
}

export { hasNonAscii }
