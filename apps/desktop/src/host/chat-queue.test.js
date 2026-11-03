import { describe, expect, it } from 'bun:test'
import {
  createChatQueue,
  mergeQueuedItems,
  resolveBusyDispatch,
  resolveMaintenanceDispatch
} from './chat-queue'

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

    // 忙时排队只有一种时机：Enter/Tab/Shift+Tab（含未显式指定 queueMode 的
    // Enter）都按 after_iteration 交给 host 的 turn/steer。
    it('steers every busy queue input into the active turn', () => {
      for (const queueMode of [null, 'after_iteration']) {
        expect(resolveBusyDispatch({ running: true, queueMode, queuedCount: 0 })).toEqual({
          action: 'steer'
        })
      }
    })

    it('keeps the local after_turn queue for an explicit request only', () => {
      expect(
        resolveBusyDispatch({ running: true, queueMode: 'after_turn', queuedCount: 0 })
      ).toEqual({ action: 'enqueue' })
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

  // 宿主占着会话做维护工作（自动压缩：轮次之外的空闲压缩，或轮内的模型摘要）：
  // 那段时间宿主读不到 stdin，所以这一条只能先进本地队列，窗口收尾后再补发。
  describe('resolveMaintenanceDispatch (host occupies the session)', () => {
    it('queues the send while the maintenance window is open', () => {
      expect(
        resolveMaintenanceDispatch({
          maintenance: { reason: 'compaction', label: '自动压缩' },
          queuedCount: 0
        })
      ).toEqual({ action: 'enqueue' })
      // 宿主没给 label 时同样是排队：文案由页面兜底（「整理结束后发送」）。
      expect(
        resolveMaintenanceDispatch({ maintenance: { reason: 'compaction' }, queuedCount: 0 })
      ).toEqual({ action: 'enqueue' })
    })

    it('rejects a second message while the window already holds one (single slot)', () => {
      expect(
        resolveMaintenanceDispatch({ maintenance: { reason: 'compaction' }, queuedCount: 1 })
      ).toEqual({
        action: 'reject',
        message: '已有一条排队消息，等待发送或重新编辑'
      })
    })

    it('starts a fresh turn once the window is closed', () => {
      expect(resolveMaintenanceDispatch({ maintenance: null, queuedCount: 0 })).toEqual({
        action: 'start'
      })
      // 窗口关闭时队列里还留着的那条（中止后等撤回）不能挡住新的发送。
      expect(resolveMaintenanceDispatch({ maintenance: null, queuedCount: 1 })).toEqual({
        action: 'start'
      })
    })
  })

  // host 侧 after_iteration 槽（mica/queue/*）与本地 after_turn 队列必须合并成
  // 同一份展示列表：漏掉 host 槽会让切换 chat 节点后等待中的消息消失。
  describe('mergeQueuedItems (host after_iteration slot + local after_turn queue)', () => {
    // 两个槽里的条目都是真实队列项、都能撤回（host 侧走 mica/queue/recall）：
    // 只有渲染层乐观行（还没被任何队列确认）才带 pending。
    it('puts host items first without marking them unreachable', () => {
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
          queueMode: 'after_iteration'
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
          queueMode: 'after_iteration'
        }
      ])
    })

    // 宿主占着会话做维护工作时，这条排队消息等的是那段工作收尾，不是迭代边界：
    // 排队行要能说清区别，并带上宿主给它的名字（「自动压缩结束后发送」）。
    it('carries the maintenance hold and its label so the dock can name it', () => {
      expect(
        mergeQueuedItems(
          'node-a',
          [
            {
              id: 'msg-1',
              text: 'after maintenance',
              queueMode: 'after_iteration',
              waitingFor: 'maintenance',
              waitingLabel: '自动压缩'
            }
          ],
          []
        )
      ).toEqual([
        {
          id: 'msg-1',
          text: 'after maintenance',
          position: 1,
          queueMode: 'after_iteration',
          waitingFor: 'maintenance',
          waitingLabel: '自动压缩'
        }
      ])
    })

    it('keeps local maintenance entries shaped like host ones', () => {
      expect(
        mergeQueuedItems('node-a', [], [
          {
            id: 'msg-2',
            text: 'queued',
            position: 1,
            queueMode: 'after_turn',
            waitingFor: 'maintenance',
            waitingLabel: '自动压缩'
          }
        ])
      ).toEqual([
        {
          id: 'msg-2',
          text: 'queued',
          position: 1,
          queueMode: 'after_turn',
          waitingFor: 'maintenance',
          waitingLabel: '自动压缩'
        }
      ])
    })

    it('returns only the local queue when no host slot is pending', () => {
      expect(mergeQueuedItems('node-a', [], [{ id: 'msg-1' }])).toEqual([{ id: 'msg-1' }])
      expect(mergeQueuedItems('node-a', undefined, undefined)).toEqual([])
    })
  })
})
