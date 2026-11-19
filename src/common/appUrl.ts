/**
 * Electron 导航/ IPC 来源校验的纯函数。
 *
 * file:// 只能指向当前应用的 renderer/index.html，不能把任意本地 HTML
 * 当成可信页面；开发模式只额外放行固定端口的 Vite 页面。
 */
export function isTrustedAppUrl(
  input: string,
  rendererFileUrl: string,
  devOrigin = 'http://localhost:8080'
) {
  if (!input) return false

  try {
    const url = new URL(input)
    const renderer = new URL(rendererFileUrl)

    if (url.protocol === 'file:') {
      return (
        renderer.protocol === 'file:' &&
        decodeURIComponent(url.pathname) === decodeURIComponent(renderer.pathname)
      )
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const allowed = new URL(devOrigin)
    return (
      url.origin === allowed.origin &&
      (url.pathname === '/' || url.pathname === '/index.html')
    )
  } catch {
    return false
  }
}
