import { describe, expect, it } from 'bun:test'
import { CHAT_CACHE_LIMIT, cachedChatNodes, nextChatCache, pruneChatCache } from './chat-cache.js'

describe('nextChatCache', () => {
  it('records the active id as most recent', () => {
    expect(nextChatCache([], 'a')).toEqual(['a'])
    expect(nextChatCache(['a'], 'b')).toEqual(['a', 'b'])
    // 重复激活只是把它移到末尾，不新增条目
    expect(nextChatCache(['a', 'b'], 'a')).toEqual(['b', 'a'])
  })

  it('returns the same reference when nothing changes', () => {
    const current = ['a', 'b']
    expect(nextChatCache(current, 'b')).toBe(current)
    expect(nextChatCache(current, null)).toBe(current)
  })

  it('keeps at most the limit, dropping the least recently used', () => {
    let cache = []
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) cache = nextChatCache(cache, id)
    expect(cache).toHaveLength(CHAT_CACHE_LIMIT)
    expect(cache).toEqual(['b', 'c', 'd', 'e', 'f'])
    // 回到 b：它还在缓存里，从「最旧」变成「最新」
    cache = nextChatCache(cache, 'b')
    expect(cache).toEqual(['c', 'd', 'e', 'f', 'b'])
    // 淘汰掉 a 之后再回来，a 需要重新挂载（走 restore）
    expect(cache).not.toContain('a')
  })

  it('tolerates a junk input', () => {
    expect(nextChatCache(null, 'a')).toEqual(['a'])
    expect(nextChatCache(undefined, 'a')).toEqual(['a'])
    expect(nextChatCache(['a'], 'a', 1)).toEqual(['a'])
  })
})

describe('pruneChatCache', () => {
  it('drops ids whose tab is gone', () => {
    expect(pruneChatCache(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'c'])
    expect(pruneChatCache(['a'], new Set(['a']))).toEqual(['a'])
  })

  it('returns the same reference when nothing is dropped', () => {
    const current = ['a', 'b']
    expect(pruneChatCache(current, ['a', 'b', 'c'])).toBe(current)
  })
})

describe('cachedChatNodes', () => {
  it('maps the cache to live nodes, keeping the cache order', () => {
    const nodes = [
      { id: 'a', type: 'terminal' },
      { id: 'b', type: 'terminal' },
      { id: 'c', type: 'terminal' }
    ]
    expect(cachedChatNodes(['b', 'a'], nodes).map((node) => node.id)).toEqual(['b', 'a'])
  })

  it('skips ids that are not in the workspace any more', () => {
    const nodes = [{ id: 'a', type: 'terminal' }]
    expect(cachedChatNodes(['gone', 'a'], nodes).map((node) => node.id)).toEqual(['a'])
    expect(cachedChatNodes(null, nodes)).toEqual([])
    expect(cachedChatNodes(['a'], null)).toEqual([])
  })
})
