import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement } from '../../../../../node_modules/react/index.js'
import { renderToStaticMarkup } from '../../../../../node_modules/react-dom/server.node.js'
import { ArcoAction } from '@mica-config-ui/web'

const source = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
const actions = Array.from(source.matchAll(/<ArcoAction\b[\s\S]*?<\/ArcoAction>/g), ([action]) => action)

describe('App header icon actions', () => {
  for (const [name, onClick] of [
    ['controlled terminal', '() => toggleTerminalControl(terminal)'],
    ['controlled browser', '() => toggleBrowser(browser)'],
    ['terminal panel toggle', 'toggleActiveTerminal']
  ]) {
    test(`${name} uses Arco icon-only geometry in idle and pressed states`, () => {
      const action = actions.find((value) => value.includes(`onClick={${onClick}}`))
      expect(action).toBeDefined()
      expect(action).toMatch(/\siconOnly\s/)
      const className = action.match(/className="([^"]+)"/)?.[1]
      expect(className).toContain('size-6')
      expect(className).toContain('place-items-center')

      for (const pressed of [false, true]) {
        for (const badge of [null, '1']) {
          const html = renderToStaticMarkup(
            createElement(
              ArcoAction,
              { iconOnly: true, className, 'aria-pressed': pressed },
              createElement('svg', { width: 14, height: 14 }),
              badge && createElement('span', { className: 'absolute' }, badge)
            )
          )
          expect(html).toContain('arco-btn-icon-only')
          expect(html).toContain(pressed ? 'arco-btn-secondary' : 'arco-btn-text')
          expect(html).toContain(`aria-pressed="${pressed}"`)
        }
      }
    })
  }
})
