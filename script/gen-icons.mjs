// 从 Lucide（ISC 许可）生成应用图标 CSS。
// 用 CSS mask + currentColor，图标跟随文字颜色，不再依赖自绘 SVG / 图标字体。
// 用法：node script/gen-icons.mjs
import fs from 'fs-extra'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const lucideDir = path.join(root, 'node_modules/lucide-static/icons')
const outFile = path.join(root, 'src/renderer/icon.css')

// 应用里的图标名 -> Lucide 图标名
const mapping = {
  add: 'plus',
  activity: 'activity',
  brand: 'award',
  'chevron-down': 'chevron-down',
  'chevron-right': 'chevron-right',
  download: 'download',
  'file-text': 'file-text',
  folder: 'folder',
  image: 'image',
  link: 'link',
  monitor: 'monitor',
  more: 'ellipsis',
  'panel-right': 'panel-right',
  package: 'package',
  radio: 'radio',
  search: 'search',
  sliders: 'sliders-horizontal',
  upload: 'upload',
  x: 'x',
  kernel: 'code',
  mac: 'network',
  name: 'tag',
  resolution: 'ruler',
  android: 'bot',
  'arrow-left': 'arrow-left',
  'arrow-right': 'arrow-right',
  'arrow-up': 'arrow-up',
  back: 'corner-up-left',
  bidirection: 'arrow-left-right',
  browser: 'globe',
  camera: 'camera',
  check: 'check',
  circle: 'circle',
  clear: 'eraser',
  collapse: 'chevrons-down',
  copy: 'copy',
  debug: 'bug',
  delete: 'trash-2',
  disconnect: 'unplug',
  expand: 'chevrons-up',
  editor: 'pencil',
  eye: 'eye',
  font: 'type',
  fullscreen: 'maximize',
  grid: 'layout-grid',
  info: 'info',
  list: 'list',
  manage: 'sliders-horizontal',
  memory: 'memory-stick',
  model: 'box',
  'open-file': 'file',
  original: 'scan',
  pause: 'pause',
  phone: 'smartphone',
  pin: 'pin',
  play: 'play',
  power: 'power',
  processor: 'cpu',
  refresh: 'refresh-cw',
  'remote-controller': 'gamepad-2',
  reset: 'refresh-ccw',
  'rotate-left': 'rotate-ccw',
  'rotate-right': 'rotate-cw',
  save: 'save',
  'screen-off': 'monitor-off',
  'screen-on': 'monitor',
  screencast: 'cast',
  'scroll-end': 'arrow-down-to-line',
  'serial-number': 'hash',
  setting: 'settings',
  'soft-wrap': 'wrap-text',
  square: 'square',
  storage: 'hard-drive',
  terminal: 'square-terminal',
  text: 'type',
  unlock: 'lock-open',
  'video-recorder': 'video',
  volume: 'volume-2',
  'volume-down': 'volume-1',
  wifi: 'wifi',
  'zoom-in': 'zoom-in',
  'zoom-out': 'zoom-out',
}

const missing = []
const rules = []
for (const [name, lucide] of Object.entries(mapping)) {
  const file = path.join(lucideDir, lucide + '.svg')
  if (!fs.existsSync(file)) {
    missing.push(`${name} -> ${lucide}`)
    continue
  }
  let svg = fs.readFileSync(file, 'utf8')
  // 统一交给 currentColor 着色；去掉固定宽高，交给 CSS 控制
  svg = svg
    .replace(/width="[^"]*"/, 'width="24"')
    .replace(/height="[^"]*"/, 'height="24"')
  const url = `url("data:image/svg+xml;base64,${Buffer.from(svg).toString(
    'base64'
  )}")`
  rules.push(`.icon-${name} { -webkit-mask-image: ${url}; mask-image: ${url}; }`)
}

if (missing.length) {
  console.error('缺少 Lucide 图标：\n' + missing.join('\n'))
  process.exit(1)
}

const names = Object.keys(mapping)
const base = `${names.map((n) => '.icon-' + n).join(',\n')} {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  vertical-align: -0.125em;
  flex-shrink: 0;
}

${names.map((n) => '.icon-' + n).join(',\n')} {
  content: '';
  width: 1em;
  height: 1em;
  background-color: currentColor;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-size: contain;
  mask-size: contain;
}`

const css = `/* 由 script/gen-icons.mjs 生成，图标来自 Lucide（ISC License） */
/* https://lucide.dev · 不要手改 */

${base}

${rules.map((rule) => rule.replace(/mask-image/g, 'mask-image')).join('\n')}
`

fs.outputFileSync(outFile, css)
console.log(`生成 ${outFile}：${names.length} 个图标`)
