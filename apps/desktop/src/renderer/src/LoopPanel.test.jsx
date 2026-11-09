import { describe, expect, mock, test } from 'bun:test'
import * as rootReact from '../../../../../node_modules/react/index.js'
mock.module(import.meta.dir + '/../../../node_modules/react/index.js', () => rootReact)
import { createElement } from '../../../../../node_modules/react/index.js'
import { renderToStaticMarkup } from '../../../../../node_modules/react-dom/server.node.js'
const { LoopPanel } = await import('./LoopPanel')

const render = (props = {}) => renderToStaticMarkup(createElement(LoopPanel, props))

describe('LoopPanel Arco controls', () => {
  test('groups interval and unit at one size, without a second theme wrapper', () => {
    const html = render({ draft: 'Review changes' })
    expect(html).toContain('arco-input-group-compact chat-loop-interval')
    expect(html).toContain('arco-input-size-small chat-loop-amount')
    expect(html).toContain('arco-select-size-small chat-loop-unit')
    expect(html).toContain('aria-label="触发间隔"')
    expect(html).toContain('aria-label="间隔单位"')
    expect(html).toContain('每 1 小时发送一次')
    expect(html).toContain('arco-textarea')
    expect(html).not.toContain('chat-loop-unit mica-config-ui')
    expect(html).not.toContain('ui-select-trigger')
  })

  test('keeps invalid tasks disabled and exposes the existing loop actions', () => {
    expect(render()).toMatch(/arco-btn-primary[^>]*disabled=""/)
    const html = render({
      loop: { intervalMs: 90_000, task: 'Review', status: 'paused', fireCount: 2 }
    })
    expect(html).toContain('value="90"')
    expect(html).toContain('title="秒"')
    for (const action of ['立即执行', '继续', '停止', '保存']) expect(html).toContain(action)
  })
})
