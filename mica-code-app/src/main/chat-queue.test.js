import { describe, expect, it } from 'bun:test'
import { createChatQueue } from './chat-queue'

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
})
