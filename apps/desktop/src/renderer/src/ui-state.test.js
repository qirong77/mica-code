import { describe, expect, it } from 'bun:test'

/**
 * 广播回声的认领必须只在 store 的广播入口发生。
 *
 * 回归的是这个场景：`drafts` 这类键同时被多个组件读取（每个挂载中的 ChatView 一个，
 * 最多 5 个）。认领一旦散在各个组件里，就是「谁先跑到谁吃掉」——活跃实例的 effect
 * 排在最后，永远拿不到计数，于是把运行时那份滞后的广播值当成外部改动写回输入框，
 * 打字越快丢字越明显（实测 36 个字符只剩 18 个）。
 *
 * 这里直接对着 store 验证：自己的回声不会把本地值拽回去，别处来的改动照常应用。
 */

const listeners = []
const windowListeners = new Map()
let getSnapshot = async () => ({})

globalThis.window = {
  addEventListener: (name, handler) => windowListeners.set(name, handler),
  mica: {
    uiState: {
      get: () => getSnapshot(),
      patch: async (patch) => ({ ok: true, changed: patch }),
      onChanged: (handler) => {
        listeners.push(handler)
        return () => {}
      }
    }
  }
}

const { ensureUiState, flushUiState, setUiState, uiStateKeys } = await import('./ui-state')

function broadcast(keys) {
  for (const handler of listeners) handler({ keys })
}

describe('ui-state 回声认领', () => {
  it('按会话独立保存并同步 By The Way 抽屉状态', async () => {
    await ensureUiState()
    setUiState('btwOpen:session-a', true)
    setUiState('btwOpen:session-b', true)
    await flushUiState()
    broadcast({ 'btwOpen:session-a': null })
    expect(uiStateKeys()['btwOpen:session-a']).toBeUndefined()
    expect(uiStateKeys()['btwOpen:session-b']).toBe(true)
  })

  it('丢掉自己的回声，不让它把本地值拽回去', async () => {
    await ensureUiState()
    setUiState('drafts', { a: '1' })
    await flushUiState()

    // 本地已经继续往前打了，广播回来的还是上一步那个值
    setUiState('drafts', { a: '12' })
    broadcast({ drafts: { a: '1' } })
    expect(uiStateKeys().drafts).toEqual({ a: '12' })
  })

  it('别处来的改动照常应用', async () => {
    setUiState('drafts', { a: '12' })
    await flushUiState()

    broadcast({ drafts: { a: 'from-other-window' } })
    expect(uiStateKeys().drafts).toEqual({ a: 'from-other-window' })
  })

  it('同一条回声只吃掉一次，值相同的后续广播仍按外部改动应用', async () => {
    setUiState('drafts', { a: 'b' })
    await flushUiState()

    setUiState('drafts', { a: 'bc' })
    broadcast({ drafts: { a: 'b' } })
    expect(uiStateKeys().drafts).toEqual({ a: 'bc' })

    // 计数已被消耗：再一次同样的广播就是真的外部改动了
    broadcast({ drafts: { a: 'b' } })
    expect(uiStateKeys().drafts).toEqual({ a: 'b' })
  })
})

describe('ui-state 恢复同步', () => {
  it('读取遗漏的变化，同时保留待写值和读取期间收到的广播', async () => {
    await ensureUiState()
    let resolveSnapshot
    getSnapshot = () => new Promise((resolve) => { resolveSnapshot = resolve })
    setUiState('resync-pending', 'local')
    windowListeners.get('mica:transport-resync')()
    await Promise.resolve()
    broadcast({ 'resync-event': 'new' })
    resolveSnapshot({ 'resync-pending': 'old', 'resync-event': 'old', 'resync-other': 'remote' })
    await Promise.resolve()
    expect(uiStateKeys()['resync-pending']).toBe('local')
    expect(uiStateKeys()['resync-event']).toBe('new')
    expect(uiStateKeys()['resync-other']).toBe('remote')
    await flushUiState()
  })

  it('并发恢复只应用最后一次快照', async () => {
    const requests = []
    getSnapshot = () => new Promise((resolve) => requests.push(resolve))
    windowListeners.get('mica:transport-resync')()
    windowListeners.get('mica:transport-resync')()
    await Promise.resolve()
    requests[1]({ 'resync-order': 'new' })
    await Promise.resolve()
    requests[0]({ 'resync-order': 'old' })
    await Promise.resolve()
    expect(uiStateKeys()['resync-order']).toBe('new')
  })
})
