import { describe, expect, it } from 'vitest'
import { resolveWarmAction } from './chat-warm'

function alive() {
  return { child: { stdin: { writable: true } } }
}

function dead() {
  return { child: { stdin: { writable: false } } }
}

describe('resolveWarmAction', () => {
  it('spawns when nothing is running', () => {
    expect(resolveWarmAction(new Map(), 'node-1')).toBe('spawn')
  })

  it('reuses the host already running for this node', () => {
    const runs = new Map([['node-1', alive()]])
    expect(resolveWarmAction(runs, 'node-1')).toBe('reused')
  })

  it('skips when another node already keeps a host alive', () => {
    // 预热只保证「至少有一个宿主」：切页签不该各自养一个 app-server。
    const runs = new Map([['node-2', alive()]])
    expect(resolveWarmAction(runs, 'node-1')).toBe('skipped')
  })

  it('ignores hosts that already exited', () => {
    const runs = new Map([
      ['node-2', dead()],
      ['node-1', dead()]
    ])
    expect(resolveWarmAction(runs, 'node-1')).toBe('spawn')
  })

  it('prefers reusing its own host over skipping for another node', () => {
    const runs = new Map([
      ['node-2', alive()],
      ['node-1', alive()]
    ])
    expect(resolveWarmAction(runs, 'node-1')).toBe('reused')
  })

  it('spawns without a node id or a real map', () => {
    expect(resolveWarmAction(new Map(), '')).toBe('spawn')
    expect(resolveWarmAction(null, 'node-1')).toBe('spawn')
  })
})
