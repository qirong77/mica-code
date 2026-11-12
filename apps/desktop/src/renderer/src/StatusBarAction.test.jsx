import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ArcoAction } from '@mica-config-ui/web'
import { StatusBarAction } from './StatusBarAction'

function click({ detail = 1, collapsed = true, contains = true } = {}) {
  const calls = []
  const ref = { current: null }
  const tree = StatusBarAction({
    ref,
    className: 'truncate',
    title: '切换目录',
    onClick: () => calls.push('open'),
    children: '/project/mica'
  })
  const selection = {
    isCollapsed: collapsed,
    containsNode: (node, partial) => node === target && partial && contains
  }
  const target = { ownerDocument: { defaultView: { getSelection: () => selection } } }
  tree.props.onClick({ detail, currentTarget: target })
  return { tree, calls, ref }
}

describe('StatusBarAction', () => {
  test('复用共享按钮，保留 ref、样式与文字', () => {
    const { tree, ref } = click()
    expect(tree.type).toBe(ArcoAction)
    expect(tree.props.ref).toBe(ref)
    expect(tree.props.className).toBe('statusbar-text-action truncate')
    expect(tree.props.children).toBe('/project/mica')
    expect(tree.props.title).toBe('切换目录')
  })

  test('普通单击仍打开选择器', () => {
    expect(click().calls).toEqual(['open'])
  })

  test('拖选当前按钮文字后不打开选择器，跨项选区也保留', () => {
    expect(click({ collapsed: false }).calls).toEqual([])
  })

  test('其它区域的选区不拦截按钮动作', () => {
    expect(click({ collapsed: false, contains: false }).calls).toEqual(['open'])
  })

  test('键盘触发不受文字选区影响', () => {
    expect(click({ detail: 0, collapsed: false }).calls).toEqual(['open'])
  })

  test('底栏按钮显式开启原生文字选择', () => {
    const css = readFileSync(new URL('../assets/app.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.arco-btn\.statusbar-text-action \{[^}]*user-select: text;/)
    expect(css).toMatch(/\.arco-btn\.statusbar-text-action \{[^}]*cursor: text;/)
  })
})
