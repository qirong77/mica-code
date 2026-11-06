import { beforeEach, describe, expect, it } from 'bun:test'
import {
  CHAT_CACHE_LIMIT,
  cachedChatNodes,
  nextChatCache,
  pruneChatCache,
  pruneCachedTranscripts,
  readCachedTranscript,
  readRestoreTranscript,
  resetTranscriptCache,
  takeCachedTranscript,
  writeCachedTranscript
} from './chat-cache.js'

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
  it('returns cached nodes in workspace order, not cache (MRU) order', () => {
    const nodes = [
      { id: 'a', type: 'terminal' },
      { id: 'b', type: 'terminal' },
      { id: 'c', type: 'terminal' }
    ]
    // 缓存把最近用过的 b 排在了后面；渲染顺序仍按 nodes，切会话才不用移动 DOM 节点
    expect(cachedChatNodes(['b', 'a'], nodes).map((node) => node.id)).toEqual(['a', 'b'])
    expect(cachedChatNodes(['a'], nodes).map((node) => node.id)).toEqual(['a'])
  })

  it('skips ids that are not in the cache', () => {
    const nodes = [{ id: 'a', type: 'terminal' }]
    expect(cachedChatNodes(['gone', 'a'], nodes).map((node) => node.id)).toEqual(['a'])
    expect(cachedChatNodes(null, nodes)).toEqual([])
    expect(cachedChatNodes(['a'], null)).toEqual([])
    expect(cachedChatNodes([], nodes)).toEqual([])
  })
})

describe('unmounted transcript cache', () => {
  beforeEach(resetTranscriptCache)

  it('hands mounted visual history to a same-node restore after the module cache was released', () => {
    const messages = [
      { kind: 'message', role: 'user', text: 'question' },
      { kind: 'reasoning', role: 'assistant', text: 'only in event history' },
      { kind: 'tool', text: 'tool result' },
      { kind: 'message', role: 'assistant', text: 'answer' }
    ]
    const meta = { cwd: '/original', model: 'test' }
    writeCachedTranscript('a', messages, meta)
    const mounted = takeCachedTranscript('a')
    expect(readCachedTranscript('a')).toBeNull()
    const nextRestore = readRestoreTranscript('a', 'a', mounted.messages, mounted.meta)
    expect(nextRestore.messages).toBe(messages)
    expect(nextRestore.meta).toBe(meta)
    expect(readCachedTranscript('a')).toBeNull()
  })

  it('does not reuse mounted rows from another node and keeps a pending restore handoff', () => {
    const cached = [{ kind: 'reasoning', text: 'node b' }]
    writeCachedTranscript('b', cached, null)
    expect(readRestoreTranscript('b', 'a', [{ text: 'node a' }], null).messages).toBe(cached)
    expect(readRestoreTranscript('b', 'b', [], null).messages).toBe(cached)
  })

  it('hands the original visual transcript to one owner without retaining an old snapshot', () => {
    const messages = [{ kind: 'reasoning', text: 'Only available in the event stream' }]
    const meta = { model: 'test' }
    writeCachedTranscript('a', messages, meta)
    const entry = takeCachedTranscript('a')
    expect(entry.messages).toBe(messages)
    expect(entry.meta).toBe(meta)
    expect(takeCachedTranscript('a')).toBeNull()
    writeCachedTranscript('a', messages, meta)
    expect(takeCachedTranscript('a').messages).toBe(messages)
  })

  it('releases closed nodes while preserving evicted views that still have a workspace node', () => {
    writeCachedTranscript('closed', [{ text: 'large history' }], null)
    writeCachedTranscript('open', [{ text: 'visual history' }], null)
    pruneCachedTranscripts(['open', 'mounted'])
    expect(takeCachedTranscript('closed')).toBeNull()
    expect(takeCachedTranscript('open').messages[0].text).toBe('visual history')
  })

  it('keeps eight unmounted transcripts and preserves handoffs during async restore retries', () => {
    for (let index = 0; index < 9; index += 1) {
      writeCachedTranscript(String(index), [{ text: `history ${index}` }], null)
    }
    expect(takeCachedTranscript('0')).toBeNull()
    expect(takeCachedTranscript('1')).not.toBeNull()
    const pending = readCachedTranscript('8')
    writeCachedTranscript('8', [], null)
    expect(readCachedTranscript('8')).toBe(pending)
    expect(takeCachedTranscript('8')).toBe(pending)
    expect(readCachedTranscript('8')).toBeNull()
  })

  /**
   * 只按「最多 8 份」限制时，8 × 一条长会话就是几十 MB 堆——而这些快照只是给
   * 「切回来先用旧内容顶着」用的。再加一道行数预算，超了从最旧的开始丢。
   */
  it('按行数预算淘汰长会话快照，不只看份数', () => {
    const rows = (count) => Array.from({ length: count }, (_, index) => ({ text: `row ${index}` }))
    // 4 份各 2000 行：份数只有 4（远小于 8），但总量已经超过 4000 行的预算。
    for (const id of ['a', 'b', 'c', 'd']) writeCachedTranscript(id, rows(2000), null)
    expect(readCachedTranscript('a')).toBeNull()
    expect(readCachedTranscript('b')).toBeNull()
    expect(readCachedTranscript('d')).not.toBeNull()
    // 被淘汰的槽位仍然可以重新写入，不会因为计数漂移而误删。
    writeCachedTranscript('e', rows(10), null)
    expect(readCachedTranscript('e')).not.toBeNull()
    expect(readCachedTranscript('d')).not.toBeNull()
  })
})
