import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement } from '../../../../../node_modules/react/index.js'
import { renderToStaticMarkup } from '../../../../../node_modules/react-dom/server.node.js'
import { ArcoAction } from '@mica-config-ui/web'
import { browserCountBadge } from './browser-control'
import { terminalIconBadge } from './terminal-control'

const source = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
// 浏览器按钮搬进了 BrowserWindowsButton：窗口一多，它仍然是顶栏上的同一枚图标，
// 所以几何断言跟着它走，而不是留在 App.jsx 里。
const browserSource = readFileSync(new URL('./BrowserWindowsButton.jsx', import.meta.url), 'utf8')
const actionsOf = (text) =>
  Array.from(text.matchAll(/<ArcoAction\b[\s\S]*?<\/ArcoAction>/g), ([action]) => action)

const cases = [
  {
    name: 'controlled terminal',
    action: () =>
      actionsOf(source).find((value) =>
        value.includes('onClick={() => toggleTerminalControl(terminal)}')
      )
  },
  {
    name: 'browser windows',
    action: () => actionsOf(browserSource).find((value) => value.includes('place-items-center'))
  },
  {
    name: 'terminal panel toggle',
    action: () =>
      actionsOf(source).find((value) => value.includes('onClick={toggleActiveTerminal}'))
  }
]

describe('App header icon actions', () => {
  for (const { name, action: find } of cases) {
    test(`${name} uses Arco icon-only geometry in idle and pressed states`, () => {
      const action = find()
      expect(action).toBeDefined()
      expect(action).toMatch(/\siconOnly\s/)
      const className = action.match(/className="([^"]+)"/)?.[1]
      expect(className).toContain('size-6')
      expect(className).toContain('place-items-center')

      for (const pressed of [false, true]) {
        for (const badge of ['', '1']) {
          const html = renderToStaticMarkup(
            createElement(
              ArcoAction,
              { iconOnly: true, className, 'aria-pressed': pressed },
              createElement('svg', { width: 14, height: 14 }),
              badge ? createElement('span', { className: 'absolute' }, badge) : null
            )
          )
          expect(html).toContain('arco-btn-icon-only')
          expect(html).toContain(pressed ? 'arco-btn-secondary' : 'arco-btn-text')
          expect(html).toContain(`aria-pressed="${pressed}"`)
          expect(html).not.toContain('<span></span>')
        }
      }
    })
  }

  test('empty control badges do not create a second grid item through Arco string children', () => {
    for (const [action, badgeOf] of [
      [
        actionsOf(source).find((value) =>
          value.includes('onClick={() => toggleTerminalControl(terminal)}')
        ),
        terminalIconBadge
      ],
      [
        actionsOf(browserSource).find((value) => value.includes('place-items-center')),
        browserCountBadge
      ]
    ]) {
      // 两个角标实现在「没内容」时都必须给空串：空串会被 Arco 当成第二格内容。
      // 浏览器那枚有一扇窗口就写 1（见 browser-control 的 browserCountBadge），
      // 所以「没有内容」指的是没有窗口；终端是列表里的序号，一扇时不写。
      expect(badgeOf([], { id: 'one' })).toBe('')
      expect(action).toContain('{badge ? (')
      expect(action).toContain(') : null}')
      expect(action).not.toContain('{badge && (')
    }
  })
})
