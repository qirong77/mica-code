import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionParentWriter } from './session-parent'
import { readTopLevelParentId } from './session-file-head'

let root
let directory
let busy
let setParent

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mica-session-parent-'))
  directory = join(root, 'sessions')
  mkdirSync(directory)
  busy = new Set()
  setParent = createSessionParentWriter({
    sessionsDir: () => directory,
    hasLiveTurnLease: (sessionId) => busy.has(sessionId)
  })
  writeSession('parent', { id: 'parent', title: '父会话', snapshot: { history: [] } })
  writeSession('child', { id: 'child', title: '子会话', snapshot: { history: [] } })
  writeSession('grandchild', { id: 'grandchild', parentSessionId: 'child', snapshot: {} })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function writeSession(id, content) {
  writeFileSync(join(directory, `${id}.json`), JSON.stringify(content, null, 2), 'utf8')
}

function readSession(id) {
  return JSON.parse(readFileSync(join(directory, `${id}.json`), 'utf8'))
}

describe('session parent writer', () => {
  it('把父会话写在 snapshot 之前，并保留其余内容', () => {
    expect(setParent({ sessionId: 'child', parentId: 'parent' })).toEqual({
      parentSessionId: 'parent'
    })
    const stored = readSession('child')
    expect(stored.parentSessionId).toBe('parent')
    expect(stored.title).toBe('子会话')
    expect(stored.snapshot).toEqual({ history: [] })
    expect(stored.revision).toBe(1)
    // 头部读取（成环判定与索引都靠它）能直接看到这条关系
    expect(readTopLevelParentId(join(directory, 'child.json'))).toBe('parent')
  })

  it('解除父子关系时把字段整个删掉', () => {
    writeSession('grandchild', { id: 'grandchild', parentSessionId: 'parent', snapshot: {} })
    expect(setParent({ sessionId: 'grandchild', parentId: null })).toEqual({
      parentSessionId: null
    })
    expect('parentSessionId' in readSession('grandchild')).toBe(false)
    expect(readTopLevelParentId(join(directory, 'grandchild.json'))).toBeNull()
  })

  it('不动 updatedAt，避免调整层级把会话顶到 Recent 最前面', () => {
    writeSession('sorted', { id: 'sorted', updatedAt: '2026-01-01T00:00:00.000Z', snapshot: {} })
    setParent({ sessionId: 'sorted', parentId: 'parent' })
    expect(readSession('sorted').updatedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('拒绝挂到自己、自己的后代、不存在的父会话', () => {
    expect(() => setParent({ sessionId: 'parent', parentId: 'parent' })).toThrow(
      'Cannot nest a session into itself'
    )
    // grandchild 的父是 child，把 child 挂到 grandchild 下会成环
    expect(() => setParent({ sessionId: 'child', parentId: 'grandchild' })).toThrow(
      'Cannot nest a session into its own descendant'
    )
    expect(() => setParent({ sessionId: 'child', parentId: 'missing' })).toThrow(
      'Parent session not found'
    )
    expect(() => setParent({ sessionId: 'child', parentId: '../escape' })).toThrow(
      'Invalid parent session id'
    )
    expect(readSession('child').parentSessionId).toBeUndefined()
  })

  it('会话正在跑（持有 turn lease）时拒绝写盘', () => {
    busy.add('child')
    expect(() => setParent({ sessionId: 'child', parentId: 'parent' })).toThrow(
      '该会话正在运行，请等这一轮结束再调整会话层级'
    )
    expect(readSession('child').parentSessionId).toBeUndefined()
    // 父会话在跑不影响挂到它下面
    busy.clear()
    busy.add('parent')
    expect(setParent({ sessionId: 'child', parentId: 'parent' }).parentSessionId).toBe('parent')
  })

  it('拒绝非法 id、缺失与损坏的会话文件', () => {
    expect(() => setParent({ sessionId: '../escape', parentId: 'parent' })).toThrow(
      'Invalid session id'
    )
    expect(() => setParent({ sessionId: 'missing', parentId: 'parent' })).toThrow(
      'Session not found'
    )
    writeFileSync(join(directory, 'broken.json'), '{', 'utf8')
    expect(() => setParent({ sessionId: 'broken', parentId: 'parent' })).toThrow(
      'Cannot read session file'
    )
  })
})
