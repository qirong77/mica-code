import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const stats = readFileSync(new URL('./StatsView.jsx', import.meta.url), 'utf8')
const detail = readFileSync(new URL('./SessionDetailModal.jsx', import.meta.url), 'utf8')
const actions = (source) =>
  Array.from(source.matchAll(/<Button\b[\s\S]*?<\/Button>/g), ([action]) => action)

describe('stats controls', () => {
  it('uses shared compact actions without a second button skin', () => {
    const buttons = [...actions(stats), ...actions(detail)]
    expect(buttons).toHaveLength(6)
    for (const button of buttons) {
      expect(button).toContain('size="compact"')
      const className = button.match(/className="([^"]+)"/)?.[1] || ''
      expect(className).not.toMatch(/(?:^|\s)(?:px-|py-|gap-|text-|bg-|border|rounded)/)
    }
    expect(stats + detail).not.toMatch(/<(?:button|ArcoAction)\b/)
  })

  it('puts the clear-day icon in the shared icon slot instead of spacing button children', () => {
    const clearDay = actions(stats).find((button) => button.includes('title="清除单日筛选"'))
    expect(clearDay).toBeDefined()
    expect(clearDay).toContain('icon={<IconX size={12} />}')
    expect(clearDay).toContain('variant="ghost"')
    expect(clearDay).not.toContain('<span')
  })

  it('only embeds shared layouts, not individual stats controls', () => {
    expect(stats.match(/className="mica-config-ui is-embed"/g)).toHaveLength(3)
    expect(stats).not.toMatch(/className="mica-config-ui is-embed">\s*<(?:Segmented|SelectMenu)/)
    expect(detail).not.toMatch(/className="mica-config-ui is-embed">\s*<(?:Segmented|SelectMenu)/)
    expect(detail).toContain('className="mica-config-ui is-embed session-detail-embed"')
  })
})
