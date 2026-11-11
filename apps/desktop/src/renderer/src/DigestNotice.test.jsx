import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement } from '../../../../../node_modules/react/index.js'
import { renderToStaticMarkup } from '../../../../../node_modules/react-dom/server.node.js'
import { CollapsiblePanel } from '@mica-config-ui/web'
import { DigestNotice } from './DigestNotice'

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('DigestNotice', () => {
  test('delegates an initially open summary to the shared Arco collapse adapter', () => {
    const children = createElement('div', { className: 'chat-markdown' }, 'Summary')
    const tree = DigestNotice({ children })
    expect(tree.type).toBe('section')
    expect(tree.props['aria-label']).toBe('长回复摘要')
    const panel = tree.props.children
    expect(panel.type).toBe(CollapsiblePanel)
    expect(panel.props.defaultOpen).toBe(true)
    expect(panel.props.title).toBe('长回复摘要')
    expect(panel.props.children).toBe(children)
    expect(panel.props.meta.props.children).toBe('自动整理')
  })

  test('renders a focusable expanded Arco header and preserves rich children', () => {
    const html = renderToStaticMarkup(
      createElement(
        DigestNotice,
        null,
        createElement(
          'div',
          { className: 'chat-markdown' },
          createElement('strong', null, 'Decision'),
          createElement('code', null, '/example/a/long/path/to/summary.jsx'),
          createElement('a', { href: '/example/file.jsx' }, 'Open file')
        )
      )
    )
    expect(html.match(/class="arco-collapse arco-collapse-border collapsible-card"/g)).toHaveLength(
      1
    )
    expect(html).toContain('arco-collapse-item-active')
    expect(html).toContain('role="button"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('arco-collapse-item-content-expanded')
    expect(html).toContain('<strong>Decision</strong>')
    expect(html).toContain('<code>/example/a/long/path/to/summary.jsx</code>')
    expect(html).toContain('<a href="/example/file.jsx">Open file</a>')
    expect(html.match(/长回复摘要/g)).toHaveLength(2)
    expect(html.match(/自动整理/g)).toHaveLength(1)
    for (const legacy of [
      'chat-digest-card',
      'chat-digest-mark',
      'chat-digest-head',
      'chat-digest-body'
    ]) {
      expect(html).not.toContain(legacy)
    }
  })

  test('keeps the original Markdown renderer in the existing notice branch', () => {
    const chat = source('./ChatView.jsx')
    expect(chat).toContain("import { DigestNotice } from './DigestNotice'")
    expect(chat).toMatch(
      /if \(message\.kind === 'notice'\) \{\s*if \(message\.variant === 'digest'\) \{\s*return \(\s*<DigestNotice status=\{message\.status\}>\s*<Markdown text=\{message\.text \|\| ''\} onOpenFile=\{onOpenFile\} \/>\s*<\/DigestNotice>/
    )
    expect(chat).not.toContain('function DigestNotice(')
    const component = source('./DigestNotice.jsx')
    expect(component).not.toMatch(/ReactMarkdown|message\.|onOpenFile|useState/)
  })

  test('shows a busy card immediately without rendering a placeholder as summary Markdown', () => {
    const tree = DigestNotice({ status: 'running', children: 'Not ready' })
    expect(tree.props['aria-busy']).toBe(true)
    const panel = tree.props.children
    expect(panel.props.defaultOpen).toBe(true)
    expect(panel.props.meta.props.role).toBe('status')
    expect(panel.props.meta.props.className).toContain('is-running')
    expect(panel.props.meta.props.children).toBe('正在整理')
    const html = renderToStaticMarkup(tree)
    expect(html).toContain('正在提炼回复要点…')
    expect(html).not.toContain('Not ready')
    expect(html).toContain('aria-expanded="true"')
  })

  test('success and failure stop the running animation and show their content', () => {
    for (const status of ['success', 'warning', 'error']) {
      const children = createElement('div', null, 'Result')
      const tree = DigestNotice({ status, children })
      expect(tree.props['aria-busy']).toBe(false)
      expect(tree.props.children.props.children).toBe(children)
      const html = renderToStaticMarkup(tree)
      expect(html).not.toContain('is-running')
      expect(html).not.toContain('chat-digest-pending')
      expect(html).toContain(status === 'success' ? '自动整理' : '未生成')
      expect(html).toContain('Result')
    }
  })

  test('uses theme tokens, chat typography and wrapping without a custom card skin', () => {
    const css = source('../assets/app.css')
    const start = css.indexOf('.chat-digest-notice {')
    const digest = css.slice(start, css.indexOf('.chat-notice-error', start))
    expect(digest).toContain('--color-bg-2: var(--color-accent-subtle)')
    expect(digest).toContain('--color-fill-1: var(--color-canvas)')
    expect(digest).toContain('font-family: var(--chat-font)')
    expect(digest).toContain('font-size: var(--chat-text-size)')
    expect(digest).toContain('line-height: 1.65')
    expect(digest).toContain('font-size: calc(var(--chat-text-size) - 2px)')
    expect(digest).toContain('min-width: 0')
    expect(digest).toContain('overflow-wrap: anywhere')
    expect(digest).toContain('white-space: normal')
    expect(digest).toContain('prefers-reduced-motion: reduce')
    expect(digest).not.toMatch(/--color-ask|gradient|box-shadow|border:|border-radius:/)
    expect(css).not.toMatch(/\.chat-digest-(card|head|mark|title|body)\b/)
    expect(css).toMatch(
      /\.chat-digest-meta\.is-running,\s*\.chat-digest-pending \{\s*animation: chat-dot-breathe/
    )
    expect(css).toContain('animation-iteration-count: 1 !important')
  })

  test('both probes reuse the production container and C is the selected default', () => {
    const design = source('../../../.probe/digest-design/main.jsx')
    const previous = source('../../../.probe/reply-digest/main.jsx')
    for (const probe of [design, previous]) {
      expect(probe).toContain(
        "import { DigestNotice } from '../../src/renderer/src/DigestNotice.jsx'"
      )
      expect(probe).toContain('<DigestNotice')
      expect(probe).not.toMatch(/<Collapse|chat-digest-card|chat-digest-mark/)
    }
    expect(design).toMatch(/variant:[\s\S]*?params\.get\('variant'\)\s*: 'c'/)
    expect(design).toContain('已选 C · 可收起摘要')
    expect(design).not.toContain('推荐 A')
    expect(design).toContain('<DigestNotice status={digestStatus}>')
    expect(design).toContain("get('status')")
    expect(source('../../../.probe/digest-design/probe.css')).not.toContain(
      'digest-design-collapse'
    )
    expect(previous).not.toContain('function DigestCard(')
  })
})
