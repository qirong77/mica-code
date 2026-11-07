// 浮窗跟随主题：`?theme=light` 用来对亮色主题下的样子。
const theme = new URLSearchParams(location.search).get('theme')
if (theme) {
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.setAttribute('data-appearance', theme.includes('light') ? 'light' : 'dark')
}

// 样式顺序与 index.html 一致：配置页样式先、app.css 后，插件 chunk 的 CSS 最后加载。
import '../../../../packages/mica-config-ui/web/styles.css'
import '../../src/renderer/assets/app.css'
import { createRoot } from 'react-dom/client'
const { Launcher } = await import('plugins/global-search/desktop.jsx')

const items = [
  { path: '/Users/me/Desktop/agent-matrix', name: 'agent-matrix', type: 'directory' },
  { path: '/Users/me/Desktop/VsGo-Projects', name: 'VsGo-Projects', type: 'directory' },
  { path: '/Users/me/Desktop/notes/today.md', name: 'today.md', type: 'file' }
]

/**
 * 探针「全局搜索」：global-search 插件的启动器 + 假 launcher api。
 * 页面右下的 #probe-out 打出真实输入框的计算样式，可以直接 headless 读。
 */
const api = {
  launcher: {
    status: async () => ({ shortcut: 'Alt+Space', registered: true }),
    request: async () => ({ items, roots: ['/Users/me/Desktop', '/Users/me/Downloads'] }),
    close: async () => ({}),
    configure: async () => ({}),
    openPath: async () => ({}),
    retry: async () => ({})
  }
}

function Probe() {
  return (
    <div className="mica-config-ui h-full bg-canvas text-fg">
      <Launcher api={api} />
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Probe />)

// Reproduce the real show path: the launcher is opened from a keyboard shortcut, so the
// programmatic focus counts as keyboard focus and `:focus-visible` matches.
setTimeout(() => {
  const input = document.querySelector('input')
  input?.focus()
  input?.select()
  const style = getComputedStyle(input)
  window.__probe = {
    outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
    outlineOffset: style.outlineOffset,
    border: `${style.borderStyle} ${style.borderWidth}`,
    background: style.backgroundColor,
    color: style.color,
    height: style.height,
    focusVisible: input?.matches(':focus-visible'),
    placeholderColor: getComputedStyle(input, '::placeholder').color,
    headHeight: getComputedStyle(document.querySelector('.global-search-head')).height,
    rowHeight: getComputedStyle(document.querySelector('.global-search-row')).height,
    sheets: [...document.styleSheets].map((sheet) => sheet.href?.split('/').pop() || 'inline')
  }
  const out = document.createElement('pre')
  out.id = 'probe-out'
  out.textContent = JSON.stringify(window.__probe, null, 2)
  document.body.append(out)
}, 300)
