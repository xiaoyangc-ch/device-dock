/**
 * 应用图标兜底：设备没返回图标（老固件 / dex 取不到资源）时按包名生成首字母图。
 * 统一绿色默认图会让整页看不出区别，这里用低饱和中色块 + 白字，深浅色都不刺眼。
 */
const cache = new Map<string, string>()

const palette = ['#3b6fd4', '#2f8a52', '#6d4fc4', '#b4632a']

function escapeXml(text: string) {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&apos;'
    }
  })
}

export function fallbackIcon(label: string, key: string) {
  const id = key + '|' + label
  const cached = cache.get(id)
  if (cached) return cached

  const text = label.trim() || key
  const letter = Array.from(text)[0]?.toUpperCase() || '?'

  // 同一个包名每次渲染要拿到同一个颜色：用 id 做简单哈希
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  }
  const bg = palette[hash % palette.length]

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
    `<rect width="64" height="64" rx="14" fill="${bg}"/>` +
    `<text x="32" y="43" font-family="-apple-system,PingFang SC,Microsoft YaHei,sans-serif" ` +
    `font-size="30" font-weight="600" text-anchor="middle" fill="#fff">${escapeXml(
      letter
    )}</text></svg>`

  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  cache.set(id, url)
  return url
}
