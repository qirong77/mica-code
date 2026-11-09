import { describe, expect, test } from 'bun:test'
import { createElement } from '../../../../../node_modules/react/index.js'
import { renderToStaticMarkup } from '../../../../../node_modules/react-dom/server.node.js'
import { ArcoAction } from '@mica-config-ui/web'
import { ShortcutButton } from './ShortcutButton'

const shortcut = { label: 'Run', action: 'run' }
const render = (props = {}) =>
  renderToStaticMarkup(createElement(ShortcutButton, { shortcut, ...props }))

describe('ShortcutButton', () => {
  test('uses the shared Arco action and keeps ordinary buttons neutral', () => {
    const tree = ShortcutButton({ shortcut, panelLabel: 'Tools' })
    expect(tree.type).toBe(ArcoAction)
    expect(tree.props.appearance).toBe('outline')
    expect(tree.props.tone).toBeUndefined()
    expect(tree.props.title).toBe('Tools · Run')
    const html = render()
    expect(html).toContain('arco-btn-outline')
    expect(html).toContain('chat-plugin-quickbar-button')
    expect(html).toContain('Run')
    expect(html).not.toContain('arco-btn-primary')
  })

  test('maps every plugin color and shape consistently', () => {
    for (const [color, tone] of [
      [undefined, undefined],
      ['accent', 'accent'],
      ['danger', 'danger'],
      ['success', 'success'],
      ['warn', 'warning']
    ]) {
      for (const [shape, appearance] of [
        [undefined, 'outline'],
        ['pill', 'outline'],
        ['soft', 'secondary'],
        ['plain', 'text']
      ]) {
        const value = { ...shortcut, style: { color, shape } }
        const tree = ShortcutButton({ shortcut: value })
        expect(tree.props.tone).toBe(tone)
        expect(tree.props.appearance).toBe(appearance)
        const html = render({ shortcut: value })
        expect(html).toContain(`arco-btn-${appearance}`)
        if (tone && tone !== 'accent') expect(html).toContain(`arco-btn-status-${tone}`)
      }
    }
  })

  test('keeps icons, icon-only labels, badges, busy feedback and menu carets', () => {
    const html = render({
      shortcut: { ...shortcut, menu: 'choices', style: { icon: 'search', iconOnly: true } },
      loading: true,
      badge: '3',
      'aria-expanded': true
    })
    expect(html).toContain('is-icon-only')
    expect(html).toContain('arco-btn-icon-only')
    expect(html).toContain('<svg')
    expect(html).toContain('width="13"')
    expect(html).toContain('aria-label="Run"')
    expect(html).not.toContain('>Run<')
    expect(html).toContain('is-busy')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('\u2026')
    expect(html).toContain('chat-plugin-quickbar-badge')
    expect(html).toContain('>3</span>')
    expect(html).toContain('chat-plugin-quickbar-caret')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="true"')

    const fallback = render({ shortcut: { ...shortcut, style: { iconOnly: true } } })
    expect(fallback).not.toContain('is-icon-only')
    expect(fallback).toContain('Run')
  })

  test('uses the selected appearance without losing section and menu state', () => {
    const value = {
      label: 'Settings',
      section: 'settings',
      items: [{ label: 'Item', action: 'run' }]
    }
    const tree = ShortcutButton({ shortcut: value, active: true })
    expect(tree.props.appearance).toBe('secondary')
    const html = render({ shortcut: value, active: true, 'aria-expanded': false, disabled: true })
    expect(html).toContain('is-active')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('arco-btn-disabled')
  })

  test('forwards mouse, focus, click, accessibility and positioning props unchanged', () => {
    const events = []
    const handlers = Object.fromEntries(
      [
        'onMouseEnter',
        'onMouseLeave',
        'onPointerEnter',
        'onPointerLeave',
        'onFocus',
        'onBlur',
        'onClick'
      ].map((name) => [name, (event) => events.push([name, event])])
    )
    const style = { width: 26, height: 26 }
    const ref = { current: null }
    const tree = ShortcutButton({
      shortcut,
      ...handlers,
      ref,
      style,
      className: 'custom-anchor',
      title: 'Disabled reason',
      'aria-label': 'Custom label',
      'aria-describedby': 'details',
      'data-anchor': 'shortcut'
    })
    const event = { currentTarget: { id: 'button' } }
    for (const [name, handler] of Object.entries(handlers)) {
      expect(tree.props[name]).toBe(handler)
      tree.props[name](event)
    }
    expect(events).toHaveLength(Object.keys(handlers).length)
    expect(events.every(([, value]) => value === event)).toBe(true)
    expect(tree.props.ref).toBe(ref)
    expect(tree.props.style).toBe(style)
    const html = render({
      style,
      className: 'custom-anchor',
      title: 'Disabled reason',
      'aria-label': 'Custom label',
      'aria-describedby': 'details',
      'data-anchor': 'shortcut'
    })
    expect(html).toContain('custom-anchor')
    expect(html).toContain('title="Disabled reason"')
    expect(html).toContain('aria-label="Custom label"')
    expect(html).toContain('aria-describedby="details"')
    expect(html).toContain('data-anchor="shortcut"')
    expect(html).toContain('width:26px;height:26px')
  })
})
