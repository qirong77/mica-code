import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ignoredEntries, parseIgnoredPaths } from './git-ignore'

let base

function makeRepository() {
  base = mkdtempSync(join(tmpdir(), 'mica-git-ignore-'))
  execFileSync('git', ['init'], { cwd: base, stdio: 'ignore' })
  return base
}

afterEach(() => {
  if (base && existsSync(base)) rmSync(base, { recursive: true, force: true })
  base = null
})

describe('parseIgnoredPaths', () => {
  it('splits NUL separated paths and drops the trailing empty record', () => {
    expect([...parseIgnoredPaths('a.log\0build/\0')]).toEqual(['a.log', 'build/'])
    expect([...parseIgnoredPaths('')]).toEqual([])
  })
})

describe('ignoredEntries', () => {
  it('marks entries matched by .gitignore and leaves the rest alone', async () => {
    const root = makeRepository()
    writeFileSync(join(root, '.gitignore'), 'build/\n*.log\n', 'utf8')
    mkdirSync(join(root, 'build'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'build', 'out.js'), '', 'utf8')
    writeFileSync(join(root, 'src', 'app.js'), '', 'utf8')
    writeFileSync(join(root, 'debug.log'), '', 'utf8')

    const ignored = await ignoredEntries(root, ['build', 'src', 'debug.log', '.gitignore'])
    expect([...ignored].sort()).toEqual(['build', 'debug.log'])
  })

  it('marks children of an ignored directory', async () => {
    const root = makeRepository()
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8')
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '', 'utf8')

    const ignored = await ignoredEntries(join(root, 'node_modules', 'pkg'), ['index.js'])
    expect([...ignored]).toEqual(['index.js'])
  })

  it('returns nothing outside a git repository', async () => {
    base = mkdtempSync(join(tmpdir(), 'mica-git-ignore-plain-'))
    writeFileSync(join(base, 'note.txt'), '', 'utf8')

    const ignored = await ignoredEntries(base, ['note.txt'])
    expect(ignored.size).toBe(0)
  })
})
