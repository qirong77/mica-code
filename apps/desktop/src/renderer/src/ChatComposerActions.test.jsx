import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./ChatView.jsx', import.meta.url), 'utf8')
const composerStart = source.indexOf('<div className="chat-composer-actions">')
const composer = source.slice(composerStart, source.indexOf('{imagePreview &&', composerStart))
const actions = [...composer.matchAll(/<ArcoAction\b[\s\S]*?<\/ArcoAction>/g)].map(([action]) => action)
const actionByLabel = (label) => {
  const matches = actions.filter((action) => action.includes(`aria-label="${label}"`))
  expect(matches).toHaveLength(1)
  return matches[0]
}

describe('chat composer icon actions', () => {
  for (const label of ['更多', '加入发送队列', '停止生成', '发送', '会话设置']) {
    it(`uses Arco icon-only spacing for ${label}`, () => {
      expect(actionByLabel(label)).toMatch(/^\s+iconOnly\s*$/m)
    })
  }

  it('keeps the stop square and stopping spinner in the same icon-only button', () => {
    const stop = actionByLabel('停止生成')
    expect(stop).toContain('className="chat-composer-stop"')
    expect(stop).toContain('onClick={stop}')
    expect(stop).toContain('{stopping ? (')
    expect(stop).toContain('<IconLoader2 size={13} className="animate-spin" />')
    expect(stop).toContain('<IconSquareFilled size={12} />')
  })

  it('keeps labeled composer menu items as text buttons', () => {
    const menu = actions.filter((action) => action.includes('role="menuitem"'))
    expect(menu).toHaveLength(4)
    for (const action of menu) {
      expect(action).not.toMatch(/^\s+iconOnly\s*$/m)
      expect(action).toContain('<span>')
    }
  })
})
