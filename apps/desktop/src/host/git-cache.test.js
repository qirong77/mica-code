import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { cachedWorktreeRead, noteWorktreeChange, repositoryRootOf } from './git-ops'

/**
 * 工作区读取缓存只做一件事：同一仓库在几秒内复用同一份 `status + numstat`。
 * 失效条件必须是「真的可能变了」——切换分支（HEAD 变）、我们自己写过工作区
 * （显式打点）——而不是「工作区里有人动过文件」（那等于不缓存）。
 */
const dirs = []

function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mica-git-cache-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'a'], { cwd: dir })
  writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('cachedWorktreeRead', () => {
  it('reuses the result for the same repository key', async () => {
    const dir = repo()
    let runs = 0
    const read = () => cachedWorktreeRead(dir, 'summary:HEAD', async () => {
      runs += 1
      return { files: runs }
    })
    expect(await read()).toEqual({ files: 1 })
    expect(await read()).toEqual({ files: 1 })
    expect(runs).toBe(1)
  })

  it('recomputes after HEAD moves', async () => {
    const dir = repo()
    let runs = 0
    const read = () =>
      cachedWorktreeRead(dir, 'summary', async () => {
        runs += 1
        return runs
      })
    await read()
    writeFileSync(path.join(dir, 'b.txt'), 'two\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'second'], { cwd: dir })
    expect(await read()).toBe(2)
  })

  it('drops the cached value when the worktree changed explicitly', async () => {
    const dir = repo()
    let runs = 0
    const read = () =>
      cachedWorktreeRead(dir, 'summary', async () => {
        runs += 1
        return runs
      })
    await read()
    // 我们自己 stage / 保存文件之后必须立刻重算，不能等 TTL。
    noteWorktreeChange(dir)
    expect(await read()).toBe(2)
  })

  it('honours refresh to skip the cache outright', async () => {
    const dir = repo()
    let runs = 0
    const read = (options) =>
      cachedWorktreeRead(dir, 'summary', async () => {
        runs += 1
        return runs
      }, options)
    await read()
    expect(await read({ refresh: true })).toBe(2)
  })

  it('does not cache outside a repository', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mica-git-plain-'))
    dirs.push(dir)
    let runs = 0
    const read = () =>
      cachedWorktreeRead(dir, 'summary', async () => {
        runs += 1
        return runs
      })
    await read()
    await read()
    expect(runs).toBe(2)
  })
})

describe('repositoryRootOf', () => {
  it('walks up from a nested directory to the repository root', () => {
    const dir = repo()
    mkdirSync(path.join(dir, 'deep', 'nested'), { recursive: true })
    expect(repositoryRootOf(path.join(dir, 'deep', 'nested'))).toBe(dir)
  })

  it('returns null when no .git is found on the way up', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mica-git-noroot-'))
    dirs.push(dir)
    expect(repositoryRootOf(dir)).toBeNull()
  })
})
