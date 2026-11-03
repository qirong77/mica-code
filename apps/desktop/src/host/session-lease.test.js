import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  createTurnLeaseProbe,
  createTurnLeaseRunner,
  isInterruptedSession,
  isPidAlive,
  readTurnLeaseOwner
} from './session-lease'

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

describe('createTurnLeaseRunner', () => {
  let root
  let lockDir
  let withTurnLease

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mica-turn-lease-'))
    lockDir = join(root, 'sessions', '.turn-locks')
    withTurnLease = createTurnLeaseRunner({ lockDir: () => lockDir })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('holds the lease only for the duration of the write', () => {
    const result = withTurnLease('session', () => {
      expect(JSON.parse(readFileSync(join(lockDir, 'session.lock'), 'utf8')).pid).toBe(process.pid)
      return 'written'
    })
    expect(result).toBe('written')
    expect(existsSync(join(lockDir, 'session.lock'))).toBe(false)
  })

  it('refuses to write while another live process holds the lease', () => {
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'session.lock'), JSON.stringify({ pid: process.pid, token: 'other' }))
    let ran = false
    expect(() => withTurnLease('session', () => { ran = true })).toThrow()
    expect(ran).toBe(false)
    // 别人的锁原样留着
    expect(JSON.parse(readFileSync(join(lockDir, 'session.lock'), 'utf8')).token).toBe('other')
  })

  it('reclaims the lease of a process that no longer exists', () => {
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'session.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, token: 'dead' }))
    expect(withTurnLease('session', () => 'written')).toBe('written')
    expect(existsSync(join(lockDir, 'session.lock'))).toBe(false)
  })

  it('releases the lease when the write throws', () => {
    expect(() => withTurnLease('session', () => { throw new Error('boom') })).toThrow('boom')
    expect(existsSync(join(lockDir, 'session.lock'))).toBe(false)
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

describe('readTurnLeaseOwner', () => {
  it('returns the owner record so callers can tell which process is running', () => {
    const dir = lockDirWith('s1', JSON.stringify({ pid: 4242, token: 't', createdAt: 'now' }))
    expect(readTurnLeaseOwner('s1', { lockDir: () => join(dir, '.turn-locks') })).toMatchObject({
      pid: 4242,
      token: 't'
    })
  })

  it('returns null for a missing, malformed, or empty id lookup', () => {
    const empty = lockDirWith('s1')
    const broken = lockDirWith('s2', '{not json')
    const probe = (dir) => ({ lockDir: () => join(dir, '.turn-locks') })
    expect(readTurnLeaseOwner('s1', probe(empty))).toBe(null)
    expect(readTurnLeaseOwner('s2', probe(broken))).toBe(null)
    expect(readTurnLeaseOwner('', probe(empty))).toBe(null)
    expect(readTurnLeaseOwner('s1', {})).toBe(null)
  })

  it('keeps the alive/dead distinction in the probe built on top of it', () => {
    const alive = lockDirWith('s1', JSON.stringify({ pid: process.pid, token: 't' }))
    const dead = lockDirWith('s2', JSON.stringify({ pid: 2147483647, token: 't' }))
    const probe = (dir) => createTurnLeaseProbe({ lockDir: () => join(dir, '.turn-locks') })
    expect(probe(alive)('s1')).toBe(true)
    expect(readTurnLeaseOwner('s2', { lockDir: () => join(dead, '.turn-locks') })?.pid).toBe(
      2147483647
    )
    expect(probe(dead)('s2')).toBe(false)
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
