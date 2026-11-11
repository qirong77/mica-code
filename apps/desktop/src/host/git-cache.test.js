import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import {
  cachedWorktreeRead,
  cachedRepository,
  noteWorktreeChange,
  repositoryRootOf,
  summaryScanCostOf,
  worktreeEpochOf,
  worktreeSignature
} from './git-ops'

/**
 * 工作区读取缓存只做一件事：同一仓库在几秒内复用同一份 `status + numstat`。
 * 失效条件必须是「真的可能变了」——切换分支（HEAD 变）、我们自己写过工作区
 * （显式打点）——而不是「工作区里有人动过文件」（那等于不缓存）。
 */
const dirs = []

function temporaryDirectory() {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'mica-git-cache-')))
  dirs.push(dir)
  return dir
}

function repo() {
  const dir = temporaryDirectory()
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'a'], { cwd: dir })
  writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('cachedWorktreeRead', () => {
  it('reuses the result for the same repository key', async () => {
    const dir = repo()
    let runs = 0
    const read = () =>
      cachedWorktreeRead(dir, 'summary:HEAD', async () => {
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
      cachedWorktreeRead(
        dir,
        'summary',
        async () => {
          runs += 1
          return runs
        },
        options
      )
    await read()
    expect(await read({ refresh: true })).toBe(2)
  })

  it('does not refill the cache when a read finishes after its generation was invalidated', async () => {
    const dir = repo()
    const old = deferred()
    const pending = cachedWorktreeRead(dir, 'summary', () => old.promise)
    noteWorktreeChange(dir)
    old.resolve('old')
    expect(await pending).toBe('old')
    expect(await cachedWorktreeRead(dir, 'summary', async () => 'new')).toBe('new')
  })

  it('does not join an invalidated read or let its cleanup remove the replacement', async () => {
    const dir = repo()
    const old = deferred()
    const replacement = deferred()
    let runs = 0
    const read = () =>
      cachedWorktreeRead(dir, 'summary', () => {
        runs += 1
        return runs === 1 ? old.promise : replacement.promise
      })
    const first = read()
    noteWorktreeChange(dir)
    const second = read()
    old.resolve('old')
    await first
    const third = read()
    expect(runs).toBe(2)
    replacement.resolve('new')
    expect(await Promise.all([second, third])).toEqual(['new', 'new'])
    expect(await read()).toBe('new')
    expect(runs).toBe(2)
  })

  it('keeps a manual refresh when an earlier read finishes later', async () => {
    const dir = repo()
    const old = deferred()
    const first = cachedWorktreeRead(dir, 'summary', () => old.promise)
    expect(await cachedWorktreeRead(dir, 'summary', async () => 'new', { refresh: true })).toBe('new')
    old.resolve('old')
    await first
    expect(await cachedWorktreeRead(dir, 'summary', async () => 'unexpected')).toBe('new')
  })

  it('coalesces automatic invalidation while still bypassing a completed cached value', async () => {
    const dir = repo()
    await cachedWorktreeRead(dir, 'summary', async () => 'old')
    const fresh = deferred()
    let runs = 0
    const read = () =>
      cachedWorktreeRead(
        dir,
        'summary',
        () => {
          runs += 1
          return fresh.promise
        },
        { invalidate: true }
      )
    const first = read()
    const second = read()
    expect(runs).toBe(1)
    fresh.resolve('new')
    expect(await Promise.all([first, second])).toEqual(['new', 'new'])
  })

  it('does not reuse an in-flight read from another HEAD', async () => {
    const dir = repo()
    const old = deferred()
    const first = cachedWorktreeRead(dir, 'workspace-status', () => old.promise)
    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: dir })
    expect(await cachedWorktreeRead(dir, 'workspace-status', async () => 'feature')).toBe('feature')
    old.resolve('original')
    await first
    expect(await cachedWorktreeRead(dir, 'workspace-status', async () => 'unexpected')).toBe('feature')
  })

  it('shares cache, in-flight reads and invalidation across symlink aliases', async () => {
    const dir = repo()
    const real = realpathSync.native(dir)
    const alias = path.join(temporaryDirectory(), 'alias')
    symlinkSync(real, alias, 'dir')
    const pending = deferred()
    const first = cachedWorktreeRead(alias, 'summary', () => pending.promise)
    const second = cachedWorktreeRead(real, 'summary', async () => 'unexpected')
    pending.resolve('same repository')
    expect(await Promise.all([first, second])).toEqual(['same repository', 'same repository'])
    expect(worktreeSignature(alias)).toBe(worktreeSignature(real))
    noteWorktreeChange(alias)
    expect(worktreeEpochOf(real)).toBe(1)
    expect(await cachedWorktreeRead(real, 'summary', async () => 'changed')).toBe('changed')
    expect(await cachedWorktreeRead(alias, 'summary', async () => 'unexpected')).toBe('changed')
    expect(summaryScanCostOf(alias)).toBe(summaryScanCostOf(real))
  })

  it('caches packed refs and invalidates when their commit changes without a loose ref', async () => {
    const dir = repo()
    const branch = execFileSync('git', ['symbolic-ref', 'HEAD'], { cwd: dir }).toString().trim()
    const first = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
    writeFileSync(path.join(dir, 'a.txt'), 'two\n')
    execFileSync('git', ['commit', '-qam', 'second'], { cwd: dir })
    const second = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
    execFileSync('git', ['update-ref', branch, first], { cwd: dir })
    execFileSync('git', ['pack-refs', '--all', '--prune'], { cwd: dir })
    expect(existsSync(path.join(dir, '.git', branch))).toBe(false)
    expect(worktreeSignature(dir)).not.toBeNull()
    let runs = 0
    const read = () => cachedWorktreeRead(dir, 'summary', async () => ++runs)
    expect(await read()).toBe(1)
    expect(await read()).toBe(1)
    execFileSync('git', ['update-ref', branch, second], { cwd: dir })
    execFileSync('git', ['pack-refs', '--all', '--prune'], { cwd: dir })
    expect(existsSync(path.join(dir, '.git', branch))).toBe(false)
    expect(await read()).toBe(2)
    expect(await read()).toBe(2)
  })

  it('isolates linked worktrees and reads their packed refs from the common directory', async () => {
    const dir = repo()
    const linked = path.join(temporaryDirectory(), 'linked')
    execFileSync('git', ['worktree', 'add', '-qb', 'feature', linked], { cwd: dir })
    execFileSync('git', ['pack-refs', '--all', '--prune'], { cwd: dir })
    expect(worktreeSignature(linked)).not.toBeNull()
    expect(worktreeSignature(linked)).not.toBe(worktreeSignature(dir))
    expect(await cachedWorktreeRead(dir, 'summary', async () => 'main')).toBe('main')
    expect(await cachedWorktreeRead(linked, 'summary', async () => 'linked')).toBe('linked')
    expect(await cachedWorktreeRead(linked, 'summary', async () => 'unexpected')).toBe('linked')
    noteWorktreeChange(linked)
    expect(await cachedWorktreeRead(dir, 'summary', async () => 'unexpected')).toBe('main')
    expect(await cachedWorktreeRead(linked, 'summary', async () => 'linked changed')).toBe(
      'linked changed'
    )
    writeFileSync(path.join(dir, 'a.txt'), 'two\n')
    execFileSync('git', ['commit', '-qam', 'second'], { cwd: dir })
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
    execFileSync('git', ['update-ref', 'refs/heads/feature', hash], { cwd: dir })
    expect(await cachedWorktreeRead(linked, 'summary', async () => 'new shared ref')).toBe(
      'new shared ref'
    )
    expect((await cachedRepository(linked)).base).toBe(hash)
  })

  it('caches submodules whose .git file points to a relative Git directory', async () => {
    const source = repo()
    const parent = repo()
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'dep'], {
      cwd: parent
    })
    const submodule = path.join(parent, 'dep')
    expect(worktreeSignature(submodule)).not.toBeNull()
    expect(await cachedWorktreeRead(submodule, 'summary', async () => 'submodule')).toBe('submodule')
    expect(await cachedWorktreeRead(submodule, 'summary', async () => 'unexpected')).toBe('submodule')
    expect((await cachedRepository(submodule)).root).toBe(realpathSync.native(submodule))
  })

  it('caches an unborn branch and invalidates after its first commit', async () => {
    const dir = temporaryDirectory()
    execFileSync('git', ['init', '-q'], { cwd: dir })
    expect(worktreeSignature(dir)).not.toBeNull()
    let runs = 0
    const read = () => cachedWorktreeRead(dir, 'summary', async () => ++runs)
    expect(await read()).toBe(1)
    expect(await read()).toBe(1)
    execFileSync(
      'git',
      ['-c', 'user.name=a', '-c', 'user.email=a@b.c', 'commit', '--allow-empty', '-qm', 'first'],
      { cwd: dir }
    )
    expect(await read()).toBe(2)
  })

  it('shares repository resolution across nested directories and symlink aliases', async () => {
    const dir = repo()
    const nested = path.join(dir, 'nested')
    mkdirSync(nested)
    const alias = path.join(temporaryDirectory(), 'alias')
    symlinkSync(realpathSync.native(dir), alias, 'dir')
    const [first, second, third] = await Promise.all([
      cachedRepository(dir),
      cachedRepository(nested),
      cachedRepository(alias)
    ])
    expect(first).toBe(second)
    expect(first).toBe(third)
    expect(first.root).toBe(realpathSync.native(dir))
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

  it('recomputes the workspace status after switching branch', async () => {
    const dir = repo()
    const initial = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
      .toString()
      .trim()
    let runs = 0
    // `git:status` 也走这条缓存：分支名是它的一部分，切分支后必须立刻读到新名字。
    const read = () =>
      cachedWorktreeRead(dir, 'workspace-status', async () => {
        runs += 1
        return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
          .toString()
          .trim()
      })
    expect(await read()).toBe(initial)
    expect(await read()).toBe(initial)
    expect(runs).toBe(1)
    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: dir })
    expect(await read()).toBe('feature')
    expect(runs).toBe(2)
  })

  it('records how long a full-tree scan took, ignoring the cheap ones', async () => {
    const dir = repo()
    const slow = () =>
      cachedWorktreeRead(dir, 'summary', async () => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 30))
        return 1
      })
    await slow()
    expect(summaryScanCostOf(dir)).toBeGreaterThanOrEqual(25)
    // 分支名那种一条 rev-parse 的读取不能把耗时统计拉低，否则工作区推送会变密。
    await cachedWorktreeRead(dir, 'workspace-status', async () => 'main', { refresh: true })
    expect(summaryScanCostOf(dir)).toBeGreaterThanOrEqual(25)
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
