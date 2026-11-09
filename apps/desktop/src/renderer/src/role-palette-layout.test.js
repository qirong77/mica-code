import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

it('aligns only the role picker with the left composer trigger', () => {
  const source = readFileSync(new URL('./ChatView.jsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../assets/app.css', import.meta.url), 'utf8')
  expect(source).toContain('kind={picker.kind}')
  expect(source).toContain("kind === 'role' ? ' chat-role-palette' : ''")
  const roleStyle = css.match(/\.chat-role-palette\s*\{([^}]+)\}/)?.[1]
  expect(roleStyle).toContain('left: 8px')
  expect(roleStyle).toContain('right: auto')
  const defaultStyle = css.match(/^\.chat-popover\s*\{([^}]+)\}/m)?.[1]
  expect(defaultStyle).toContain('right: 8px')
})
