// 样式顺序与真实宿主 main.jsx 一致：共享入口的配置页 / Arco 样式 → app.css → 插件 chunk。
import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { ArcoProvider } from '@mica-config-ui/web'
import '../../src/renderer/assets/app.css'

// 浮窗跟随主题：`?theme=light` 用来对亮色主题下的样子。
const theme = new URLSearchParams(location.search).get('theme')
if (theme) {
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.setAttribute(
    'data-appearance',
    theme.includes('light') || theme === 'latte' ? 'light' : 'dark'
  )
}
document.body.classList.add('mica-arco-theme')

const { Launcher } = await import('plugins/global-search/desktop.jsx')

const items = [
  { path: '/Users/me/Desktop/agent-matrix', name: 'agent-matrix', type: 'directory' },
  { path: '/Users/me/Desktop/VsGo-Projects', name: 'VsGo-Projects', type: 'directory' },
  { path: '/Users/me/Desktop/notes/today.md', name: 'today.md', type: 'file' }
]

/**
 * 探针「全局搜索」：global-search 插件的启动器 + 假 launcher api。
 * 与真实宿主共享 ArcoProvider / Input 和 body 主题。
 * #probe-out 打出真实输入框的计算样式，可以直接 headless 读。
 */
let completeOpen
const api = {
  launcher: {
    status: async () => ({ shortcut: 'Alt+Space', registered: true }),
    request: async () => ({ items, roots: ['/Users/me/Desktop', '/Users/me/Downloads'] }),
    close: async () => ({}),
    configure: async () => ({}),
    // 通过真实「打开结果」状态检查禁用样式；只挂起假 API，不触碰本机文件。
    openPath: () => new Promise((resolve) => {
      completeOpen = resolve
    }),
    retry: async () => ({})
  }
}

function measureInput(input) {
  const style = getComputedStyle(input)
  const placeholder = getComputedStyle(input, '::placeholder')
  const head = input.closest('.global-search-head')
  const headStyle = getComputedStyle(head)
  const row = document.querySelector('.global-search-row')
  return {
    className: input.className,
    font: style.font,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    width: style.width,
    height: style.height,
    minWidth: style.minWidth,
    flex: style.flex,
    padding: style.padding,
    outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    outlineOffset: style.outlineOffset,
    border: `${style.borderStyle} ${style.borderWidth}`,
    borderStyle: style.borderStyle,
    borderWidth: style.borderWidth,
    boxShadow: style.boxShadow,
    background: style.backgroundColor,
    color: style.color,
    focused: input.matches(':focus'),
    focusVisible: input.matches(':focus-visible'),
    hovered: input.matches(':hover'),
    disabled: input.disabled,
    placeholderColor: placeholder.color,
    placeholderOpacity: placeholder.opacity,
    headFont: headStyle.font,
    headFontSize: headStyle.fontSize,
    secondaryColor: getComputedStyle(head.querySelector('svg')).color,
    headHeight: headStyle.height,
    headContentHeight: head.clientHeight - parseFloat(headStyle.paddingTop) - parseFloat(headStyle.paddingBottom),
    rowHeight: row ? getComputedStyle(row).height : null,
    viewportWidth: innerWidth,
    bodyTheme: document.body.classList.contains('mica-arco-theme'),
    sheets: [...document.styleSheets].map((sheet) => sheet.href?.split('/').pop() || 'inline')
  }
}

function Probe() {
  const host = useRef(null)
  const output = useRef(null)
  useEffect(() => {
    let disposed = false
    const publishWhenReady = () => {
      const input = host.current.querySelector('input.global-search-input.arco-input')
      const list = host.current.querySelector('[role="listbox"]')
      if (!input || list?.getAttribute('aria-busy') !== 'false') return
      observer.disconnect()
      // The component is committed and its lazy chunk has loaded; fonts have an
      // explicit readiness promise too. No fixed timer, polling or sleep needed.
      document.fonts.ready.then(() => {
        if (disposed) return
        input.blur()
        const idle = measureInput(input)
        // Reproduce keyboard-shortcut show: programmatic focus on a text input
        // also matches :focus-visible, unlike a mouse-only button focus.
        input.focus()
        input.select()
        const focused = measureInput(input)
        const publish = (sample) => {
          Object.assign(window.__probe, sample)
          output.current.textContent = JSON.stringify(window.__probe, null, 2)
          return sample
        }
        window.__probe = {
          ready: true,
          states: { idle, focused },
          // Call after real pointer hover, or after beginOpen() has disabled
          // the real shared Input, to read and publish another computed sample.
          measure: () => publish(measureInput(input)),
          beginOpen: () => host.current.querySelector('.global-search-row').click(),
          finishOpen: () => completeOpen?.({})
        }
        publish(focused)
      })
    }
    const observer = new MutationObserver(publishWhenReady)
    observer.observe(host.current, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-busy']
    })
    publishWhenReady()
    return () => {
      disposed = true
      observer.disconnect()
      delete window.__probe
    }
  }, [])

  return (
    <ArcoProvider>
      <div ref={host} className="mica-config-ui h-full bg-canvas text-fg">
        <Launcher api={api} />
      </div>
      <pre ref={output} id="probe-out" />
    </ArcoProvider>
  )
}

createRoot(document.getElementById('root')).render(<Probe />)
