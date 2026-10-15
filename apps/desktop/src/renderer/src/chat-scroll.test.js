import { describe, expect, it } from 'bun:test'

import {
  SCROLL_CACHE_LIMIT,
  readScrollEntry,
  resolveScrollRestore,
  writeScrollEntry
} from './chat-scroll.js'

const fresh = () => new Map()

describe('writeScrollEntry', () => {
  it('按节点存起来，读得到', () => {
    const entries = writeScrollEntry(fresh(), 'node-a', { top: 120, stick: false })

    expect(readScrollEntry(entries, 'node-a')).toEqual({ top: 120, stick: false })
  })

  it('同一个节点再写一次是覆盖，不是追加', () => {
    let entries = writeScrollEntry(fresh(), 'node-a', { top: 120, stick: false })
    entries = writeScrollEntry(entries, 'node-a', { top: 40, stick: false })

    expect(entries.size).toBe(1)
    expect(readScrollEntry(entries, 'node-a')).toEqual({ top: 40, stick: false })
  })

  it('没有 nodeId 时不记录', () => {
    const entries = writeScrollEntry(fresh(), null, { top: 1, stick: false })

    expect(entries.size).toBe(0)
  })

  it('超过上限时淘汰最久没用的那个', () => {
    let entries = fresh()
    for (let index = 0; index < SCROLL_CACHE_LIMIT; index += 1) {
      entries = writeScrollEntry(entries, `node-${index}`, { top: index, stick: false })
    }

    entries = writeScrollEntry(entries, 'node-extra', { top: 99, stick: false })

    expect(entries.size).toBe(SCROLL_CACHE_LIMIT)
    expect(readScrollEntry(entries, 'node-0')).toBeNull()
    expect(readScrollEntry(entries, 'node-extra')).toEqual({ top: 99, stick: false })
  })
})

describe('readScrollEntry', () => {
  it('没记录过就是 null', () => {
    expect(readScrollEntry(fresh(), 'node-a')).toBeNull()
    expect(readScrollEntry(fresh(), null)).toBeNull()
  })

  it('命中之后变成最近使用的，不会被先淘汰', () => {
    let entries = fresh()
    for (let index = 0; index < SCROLL_CACHE_LIMIT; index += 1) {
      entries = writeScrollEntry(entries, `node-${index}`, { top: index, stick: false })
    }

    readScrollEntry(entries, 'node-0')
    entries = writeScrollEntry(entries, 'node-extra', { top: 99, stick: false })

    expect(readScrollEntry(entries, 'node-0')).toEqual({ top: 0, stick: false })
    expect(readScrollEntry(entries, 'node-1')).toBeNull()
  })
})

describe('resolveScrollRestore', () => {
  it('第一次进这个会话时跟随底部', () => {
    expect(resolveScrollRestore(null)).toEqual({ stick: true, top: 0 })
  })

  it('上次停在底部就继续跟随底部', () => {
    expect(resolveScrollRestore({ top: 300, stick: true })).toEqual({ stick: true, top: 0 })
  })

  it('上次读到一半就恢复那个偏移', () => {
    expect(resolveScrollRestore({ top: 300, stick: false })).toEqual({ stick: false, top: 300 })
  })

  it('停在最顶上也是有效位置，不能当成「跟随底部」', () => {
    expect(resolveScrollRestore({ top: 0, stick: false })).toEqual({ stick: false, top: 0 })
  })

  it('坏掉的偏移收敛成 0 而不是 NaN', () => {
    expect(resolveScrollRestore({ top: Number.NaN, stick: false })).toEqual({
      stick: false,
      top: 0
    })
    expect(resolveScrollRestore({ top: -50, stick: false })).toEqual({ stick: false, top: 0 })
    expect(resolveScrollRestore({ stick: false })).toEqual({ stick: false, top: 0 })
  })
})
