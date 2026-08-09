import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { isDirectory, resolveUsableCwd } from './cwd-utils'

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mica-cwd-utils-'))
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('isDirectory', () => {
  it('returns true for an existing directory', () => {
    expect(isDirectory(root)).toBe(true)
  })

  it('returns false for a non-existent path', () => {
    expect(isDirectory(join(root, 'nope'))).toBe(false)
  })

  it('returns false for a regular file', () => {
    const file = join(root, 'a.txt')
    require('fs').writeFileSync(file, 'x')
    expect(isDirectory(file)).toBe(false)
  })

  it('returns false for empty / non-string input', () => {
    expect(isDirectory('')).toBe(false)
    expect(isDirectory('   ')).toBe(false)
    expect(isDirectory(null)).toBe(false)
    expect(isDirectory(undefined)).toBe(false)
  })
})

describe('resolveUsableCwd', () => {
  it('returns the cwd unchanged when it exists', () => {
    const result = resolveUsableCwd(root)
    expect(result).toEqual({ cwd: root, original: root, changed: false })
  })

  it('walks up to the nearest existing ancestor when the cwd is gone', () => {
    const child = join(root, 'a', 'b')
    mkdirSync(child, { recursive: true })
    rmSync(join(root, 'a'), { recursive: true, force: true })
    const result = resolveUsableCwd(join(child, 'deep'))
    expect(result.changed).toBe(true)
    expect(result.cwd).toBe(root)
    expect(result.original).toBe(join(child, 'deep'))
  })

  it('falls back to an existing ancestor when given a deep missing path', () => {
    const result = resolveUsableCwd(join(root, 'missing', 'deeper'))
    expect(result.changed).toBe(true)
    expect(result.cwd).toBe(root)
  })

  it('normalizes a missing dir back to its existing parent', () => {
    const parent = join(root, 'parent')
    mkdirSync(parent)
    const result = resolveUsableCwd(join(parent, 'gone'))
    expect(result.changed).toBe(true)
    expect(result.cwd).toBe(parent)
  })
})
