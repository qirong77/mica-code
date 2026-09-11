import { describe, expect, it } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createTurnLeaseProbe, isInterruptedSession, isPidAlive } from './session-lease'

function lockDirWith(id, content) {
  const dir = mkdtempSync(join(tmpdir(), 'mica-lease-'))
  mkdirSync(join(dir, '.turn-locks'), { recursive: true })
  if (content !== undefined) {
    writeFileSync(join(dir, '.turn-locks', `${id}.lock`), content, 'utf8')
  }
  return dir
}

describe('createTurnLeaseProbe', () => {
  it('reports a lease whose owner is still alive', () => {
    const dir = lockDirWith('s1', JSON.stringify({ pid: process.pid, token: 't' }))
    const hasLease = createTurnLeaseProbe({ lockDir: () => join(dir, '.turn-locks') })
    expect(hasLease('s1')).toBe(true)
  })

  it('treats a dead owner as released', () => {
    const dir = lockDirWith('s1', JSON.stringify({ pid: 2147483647, token: 't' }))
    const hasLease = createTurnLeaseProbe({ lockDir: () => join(dir, '.turn-locks') })
    expect(hasLease('s1')).toBe(false)
  })

  it('treats a missing, malformed, or pid-less lock as released', () => {
    const empty = lockDirWith('s1')
    const broken = lockDirWith('s2', '{not json')
    const noPid = lockDirWith('s3', JSON.stringify({ token: 't' }))
    const probe = (dir) => createTurnLeaseProbe({ lockDir: () => join(dir, '.turn-locks') })
    expect(probe(empty)('s1')).toBe(false)
    expect(probe(broken)('s2')).toBe(false)
    expect(probe(noPid)('s3')).toBe(false)
    expect(probe(empty)('')).toBe(false)
  })
})

describe('isPidAlive', () => {
  it('accepts the current process and rejects unusable pids', () => {
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
    expect(isPidAlive(1.5)).toBe(false)
    expect(isPidAlive('123')).toBe(false)
  })
})

describe('isInterruptedSession', () => {
  const never = () => false
  const always = () => true

  it('flags an errored turn', () => {
    expect(isInterruptedSession({ id: 's1', turnState: 'error' }, never)).toBe(true)
  })

  it('leaves completed and user-aborted turns alone', () => {
    expect(isInterruptedSession({ id: 's1', turnState: 'completed' }, never)).toBe(false)
    expect(isInterruptedSession({ id: 's1', turnState: 'aborted' }, never)).toBe(false)
  })

  it('flags a running turn only once nobody holds its lease', () => {
    expect(isInterruptedSession({ id: 's1', turnState: 'running' }, always)).toBe(false)
    expect(isInterruptedSession({ id: 's1', turnState: 'running' }, never)).toBe(true)
  })

  it('never probes the lease unless the turn is running', () => {
    let calls = 0
    const probe = () => {
      calls += 1
      return false
    }
    isInterruptedSession({ id: 's1', turnState: 'error' }, probe)
    isInterruptedSession({ id: 's1', turnState: 'completed' }, probe)
    expect(calls).toBe(0)
  })
})
