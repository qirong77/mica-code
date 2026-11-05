import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

it('keeps the drag hint out of layout and pointer hit testing', () => {
  const source = readFileSync(new URL('./SessionTree.jsx', import.meta.url), 'utf8')
  const hint = source.match(/\{drag && !searching && \(\s*<p className="([^"]+)"/)
  expect(hint).not.toBeNull()
  const classes = hint[1].split(/\s+/)
  expect(classes).toContain('absolute')
  expect(classes).toContain('pointer-events-none')
})
