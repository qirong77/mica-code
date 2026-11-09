import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 动效契约测试：`assets/app.css` 末尾的「动效」段是全站入场动画的唯一落脚点。
 *
 * 钉住四件事：
 * - 时长与曲线只走 token，别再往规则里写 `0.3s ease`——同一屏里两种曲线看起来就是「不跟手」；
 * - 只动 `opacity` / `transform` / 颜色：`transition: all` 会连带过渡宽高，而终端高度、
 *   侧栏宽度都是 JS 量出来写进样式的，过渡它们在量到的那一帧会打架；
 * - 每个 `@keyframes motion-*` 都得有规则在用，写完了没人用的动画等于死代码；
 * - `prefers-reduced-motion` 的全局兜底必须是文件最后一条规则（它靠 `!important` 压住全站，
 *   放在中间就会被后面的规则重新打开）。
 *
 * 另外校验 JSX 里的钩子类名：选择器写成 `.notice-card` / `.files-view` 这类，
 * 组件里漏掉那个类名时动画会静默失效，样式表本身看不出任何异常。
 */
const RENDERER_DIR = resolve(dirname(fileURLToPath(import.meta.url)))
const appCss = readFileSync(resolve(RENDERER_DIR, '../assets/app.css'), 'utf8')
const statsCss = readFileSync(resolve(RENDERER_DIR, 'stats/stats.css'), 'utf8')

const MOTION_HEADER = '------------------------------------------------------------------ 动效'
const MOTION_CSS = appCss.slice(appCss.indexOf(MOTION_HEADER))
const GUARD = '@media (prefers-reduced-motion: reduce)'
const source = (file) => readFileSync(resolve(RENDERER_DIR, file), 'utf8')

describe('动效 token', () => {
  it('@theme 里定义默认过渡时长与曲线，Tailwind 工具类跟着走', () => {
    const theme = appCss.match(/@theme \{([\s\S]*?)\n\}/)?.[1]
    expect(theme).toBeDefined()
    expect(theme).toContain('--default-transition-duration: 140ms;')
    expect(theme).toContain(
      '--default-transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1);'
    )
    for (const ease of ['--ease-soft', '--ease-emphasized', '--ease-exit']) {
      expect(theme).toContain(`${ease}:`)
    }
  })

  it(':root 定义三档时长', () => {
    const root = appCss.match(/:root \{([^}]*)\}/)?.[1]
    expect(root).toContain('--motion-fast: 90ms;')
    expect(root).toContain('--motion-base: 140ms;')
    expect(root).toContain('--motion-slow: 200ms;')
  })
})

describe('动效规则', () => {
  const beforeGuard = MOTION_CSS.slice(0, MOTION_CSS.indexOf(GUARD))

  it('动效段的时长只来自 token', () => {
    expect(beforeGuard).not.toMatch(/(?:animation|transition):[^;]*\b\d+(?:\.\d+)?m?s\b/)
    expect(beforeGuard).toMatch(/animation: motion-[a-z-]+ var\(--motion-[a-z]+\)/)
  })

  it('每个 motion-* 关键帧都有规则在用', () => {
    const names = [...appCss.matchAll(/@keyframes (motion-[a-z-]+)/g)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(beforeGuard).toContain(`animation: ${name} `)
    }
  })

  it('不出现 transition: all', () => {
    expect(appCss).not.toMatch(/transition:\s*all\b/)
    expect(statsCss).not.toMatch(/transition:\s*all\b/)
  })

  it('减少动态效果的兜底是文件最后一条规则，并覆盖全站', () => {
    expect(appCss.indexOf(GUARD)).toBeGreaterThan(0)
    const tail = appCss.slice(appCss.indexOf(GUARD))
    expect(tail.slice(0, tail.indexOf('{'))).toContain(GUARD)
    expect(tail).toContain('animation-duration: 1ms !important;')
    expect(tail).toContain('transition-duration: 1ms !important;')
    expect(tail).toContain('animation-delay: 0s !important;')
    // 兜底块之后只剩注释：最后一条规则之后不该再有选择器。
    const afterLastRule = tail.slice(tail.lastIndexOf('}') + 1)
    expect(afterLastRule.replace(/\/\*[\s\S]*?\*\//g, '').trim()).toBe('')
  })
})

describe('JSX 钩子', () => {
  it('文件页、终端面板、设置页、通知、浮动菜单都带上了动效类名', () => {
    expect(source('FilesView.jsx')).toContain('files-view ')
    expect(source('App.jsx')).toContain('terminal-panel ')
    expect(source('App.jsx')).toContain('config-page-overlay ')
    expect(source('NotificationHost.jsx')).toContain('notice-card ')
    expect(source('FloatingMenu.jsx')).toContain('floating-menu ')
  })

  it('统计页卡片入场取同一套 token', () => {
    expect(statsCss).toMatch(
      /\.stats-panel\.arco-card \{[\s\S]*animation: motion-rise-in var\(--motion-slow\) var\(--ease-soft\)/
    )
  })

  it('所有折叠面共用 Collapse，不各写一套高度动画', () => {
    for (const file of [
      'FileExplorerTree.jsx',
      'SessionTree.jsx',
      'FileSidePanels.jsx',
      'GitComparePanel.jsx'
    ]) {
      expect(source(file)).toContain('<Collapse')
      expect(source(file)).toContain("from './Collapse'")
    }
  })

  it('可旋转的箭头都带过渡，`rotate-90` 才有过程', () => {
    expect(source('FileExplorerTree.jsx')).toContain('transition-transform')
    expect(source('FileSidePanels.jsx')).toContain('transition-transform')
    expect(source('GitComparePanel.jsx')).toContain('transition-transform')
  })
})
