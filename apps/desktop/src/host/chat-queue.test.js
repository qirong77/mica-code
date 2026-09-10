import { describe, expect, it } from 'bun:test'
import { createChatQueue, mergeQueuedItems, resolveBusyDispatch } from './chat-queue'

describe('chat run queue', () => {
  it('keeps queued prompts FIFO and isolated by node', () => {
    const queue = createChatQueue()
    queue.enqueue('node-a', 'first')
    queue.enqueue('node-b', 'other')
    queue.enqueue('node-a', 'second')

    expect(queue.values('node-a')).toEqual(['first', 'second'])
    expect(queue.take('node-a')).toBe('first')
    expect(queue.values('node-a')).toEqual(['second'])
    expect(queue.take('node-a')).toBe('second')
    expect(queue.take('node-a')).toBeUndefined()
    expect(queue.take('node-b')).toBe('other')
  })

  it('rejects entries after reaching the queue limit and can clear a node', () => {
    const queue = createChatQueue(2)
    expect(queue.enqueue('node-a', 'first')).toEqual({ ok: true, position: 1 })
    expect(queue.enqueue('node-a', 'second')).toEqual({ ok: true, position: 2 })
    expect(queue.enqueue('node-a', 'third')).toEqual({ ok: false, position: 2 })

    queue.clear('node-a')
    expect(queue.size('node-a')).toBe(0)
    expect(queue.enqueue('node-a', 'after-clear')).toEqual({ ok: true, position: 1 })
  })

  it('removes one queued entry without changing the order of the others', () => {
    const queue = createChatQueue()
    queue.enqueue('node-a', { id: 'first' })
    queue.enqueue('node-a', { id: 'second' })
    queue.enqueue('node-a', { id: 'third' })

    expect(queue.remove('node-a', (item) => item.id === 'second')).toEqual({ id: 'second' })
    expect(queue.values('node-a')).toEqual([{ id: 'first' }, { id: 'third' }])
    expect(queue.remove('node-a', (item) => item.id === 'missing')).toBeUndefined()
    expect(queue.remove('node-b', () => true)).toBeUndefined()
  })

  // 与 CLI 单槽排队语义对齐（MessageQueueService + TerminalInput）：
  // 运行中已有排队消息时，Enter/Tab/Shift+Tab 一律拒绝新的排队输入。
  describe('resolveBusyDispatch (aligns with CLI single-slot queue)', () => {
    it('starts a fresh turn when the host is idle', () => {
      expect(resolveBusyDispatch({ running: false, queueMode: null, queuedCount: 0 })).toEqual({
        action: 'start'
      })
    })

    it('enqueues plain Enter/Tab as after_turn when nothing is queued', () => {
      expect(resolveBusyDispatch({ running: true, queueMode: null, queuedCount: 0 })).toEqual({
        action: 'enqueue'
      })
      expect(
        resolveBusyDispatch({ running: true, queueMode: 'after_turn', queuedCount: 0 })
      ).toEqual({ action: 'enqueue' })
    })

    it('steers Shift+Tab (after_iteration) into the active turn when nothing is queued', () => {
      expect(
        resolveBusyDispatch({ running: true, queueMode: 'after_iteration', queuedCount: 0 })
      ).toEqual({ action: 'steer' })
    })

    it('rejects any further queue input once a message is already queued (single slot)', () => {
      for (const queueMode of [null, 'after_turn', 'after_iteration']) {
        expect(resolveBusyDispatch({ running: true, queueMode, queuedCount: 1 })).toEqual({
          action: 'reject',
          message: '已有一条排队消息，等待发送或重新编辑'
        })
      }
    })
  })

  // host 侧 after_iteration 槽（mica/queue/*）与本地 after_turn 队列必须合并成
  // 同一份展示列表：漏掉 host 槽会让切换 chat 节点后等待中的消息消失。
  describe('mergeQueuedItems (host after_iteration slot + local after_turn queue)', () => {
    it('puts host items first and flags them pending so recall stays local-only', () => {
      const items = mergeQueuedItems(
        'node-a',
        [{ id: 'msg-1', text: 'steered', queueMode: 'after_iteration' }],
        [{ id: 'msg-2', text: 'queued', position: 1, queueMode: 'after_turn' }]
      )

      expect(items).toEqual([
        {
          id: 'msg-1',
          text: 'steered',
          position: 1,
          queueMode: 'after_iteration',
          pending: true
        },
        { id: 'msg-2', text: 'queued', position: 1, queueMode: 'after_turn' }
      ])
    })

    it('synthesizes a stable id and defaults for host items without one', () => {
      expect(mergeQueuedItems('node-a', [{ text: 'no id' }], [])).toEqual([
        {
          id: 'host:node-a:0',
          text: 'no id',
          position: 1,
          queueMode: 'after_iteration',
          pending: true
        }
      ])
    })

    it('returns only the local queue when no host slot is pending', () => {
      expect(mergeQueuedItems('node-a', [], [{ id: 'msg-1' }])).toEqual([{ id: 'msg-1' }])
      expect(mergeQueuedItems('node-a', undefined, undefined)).toEqual([])
    })
  })
})
