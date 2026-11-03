import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'
import {
  cachedRepository,
  cachedWorktreeRead,
  discardDirectory,
  discardFile,
  getWorkspaceStatus,
  git,
  gitErrorMessage,
  noteWorktreeChange,
  safeFilePath,
  stageFile,
  unstageFile
} from './git-ops'

const execFileAsync = promisify(execFile)

/** 提交时显式带上身份，免得受宿主机全局 git 配置（签名、模板）影响。 */
function commit(dir, message, extra = []) {
  return execFileAsync(
    'git',
    ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', ...extra, '-m', message],
    { cwd: dir }
  )
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mica-git-ops-'))
  await execFileAsync('git', ['init', '-q'], { cwd: dir })
  await commit(dir, 'init', ['--allow-empty'])
  return dir
}

const status = (dir) => git(dir, ['status', '--porcelain=v1', '--untracked-files=all'])

describe('stageFile / unstageFile', () => {
  let dir
  beforeEach(async () => {
    dir = await setup()
    await writeFile(path.join(dir, 'a.txt'), 'one\n')
    await git(dir, ['add', '--', 'a.txt'])
    await commit(dir, 'add')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('暂存把工作区改动放进索引', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    expect(await status(dir)).toBe(' M a.txt\n')
    await stageFile(dir, 'a.txt')
    expect(await status(dir)).toBe('M  a.txt\n')
  })

  it('取消暂存把索引里的改动退回工作区', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    await stageFile(dir, 'a.txt')
    await unstageFile(dir, 'a.txt')
    expect(await status(dir)).toBe(' M a.txt\n')
    // 内容还在，取消暂存不该动工作区。
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('two\n')
  })

  it('新增文件暂存后再取消暂存，回到未跟踪且文件保留', async () => {
    await writeFile(path.join(dir, 'b.txt'), 'new\n')
    expect(await status(dir)).toBe('?? b.txt\n')
    await stageFile(dir, 'b.txt')
    expect(await status(dir)).toBe('A  b.txt\n')
    await unstageFile(dir, 'b.txt')
    expect(await status(dir)).toBe('?? b.txt\n')
    expect(existsSync(path.join(dir, 'b.txt'))).toBe(true)
  })

  it('仓库还没有第一个提交时也能取消暂存', async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), 'mica-git-ops-fresh-'))
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: fresh })
      await writeFile(path.join(fresh, 'c.txt'), 'c\n')
      await stageFile(fresh, 'c.txt')
      expect(await status(fresh)).toBe('A  c.txt\n')
      await unstageFile(fresh, 'c.txt')
      expect(await status(fresh)).toBe('?? c.txt\n')
      expect(existsSync(path.join(fresh, 'c.txt'))).toBe(true)
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })
})

describe('discardFile', () => {
  let dir
  beforeEach(async () => {
    dir = await setup()
    await writeFile(path.join(dir, 'a.txt'), 'one\n')
    await git(dir, ['add', '--', 'a.txt'])
    await commit(dir, 'add')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('已跟踪文件恢复成索引里的版本', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'changed\n')
    await discardFile(dir, 'a.txt')
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n')
    expect(await status(dir)).toBe('')
  })

  it('删除的已跟踪文件被恢复', async () => {
    await rm(path.join(dir, 'a.txt'))
    expect(await status(dir)).toBe(' D a.txt\n')
    await discardFile(dir, 'a.txt')
    expect(await status(dir)).toBe('')
  })

  it('未跟踪文件被删掉', async () => {
    await writeFile(path.join(dir, 'b.txt'), 'new\n')
    await discardFile(dir, 'b.txt')
    expect(existsSync(path.join(dir, 'b.txt'))).toBe(false)
    expect(await status(dir)).toBe('')
  })
})

describe('discardDirectory', () => {
  let dir
  beforeEach(async () => {
    dir = await setup()
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'src/a.txt'), 'one\n')
    await writeFile(path.join(dir, 'src/b.txt'), 'two\n')
    await writeFile(path.join(dir, 'other.txt'), 'keep\n')
    await git(dir, ['add', '.'])
    await commit(dir, 'add')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('目录下已跟踪文件恢复，未跟踪文件与空目录被删掉，目录外不受影响', async () => {
    await writeFile(path.join(dir, 'src/a.txt'), 'changed\n')
    await rm(path.join(dir, 'src/b.txt'))
    await writeFile(path.join(dir, 'src/new.txt'), 'new\n')
    await mkdir(path.join(dir, 'src/nested'), { recursive: true })
    await writeFile(path.join(dir, 'src/nested/deep.txt'), 'deep\n')
    expect(await status(dir)).toBe(
      ' M src/a.txt\n D src/b.txt\n?? src/nested/deep.txt\n?? src/new.txt\n'
    )

    const result = await discardDirectory(dir, 'src')

    expect(result.removed).toBe(2)
    expect(await status(dir)).toBe('')
    expect(await readFile(path.join(dir, 'src/a.txt'), 'utf8')).toBe('one\n')
    expect(existsSync(path.join(dir, 'src/b.txt'))).toBe(true)
    expect(existsSync(path.join(dir, 'src/new.txt'))).toBe(false)
    expect(existsSync(path.join(dir, 'src/nested'))).toBe(false)
    expect(await readFile(path.join(dir, 'other.txt'), 'utf8')).toBe('keep\n')
  })

  it('保留已暂存的改动（与单文件版同语义）', async () => {
    await writeFile(path.join(dir, 'src/a.txt'), 'staged\n')
    await stageFile(dir, 'src/a.txt')
    await writeFile(path.join(dir, 'src/a.txt'), 'staged\nworktree\n')
    await discardDirectory(dir, 'src')
    expect(await readFile(path.join(dir, 'src/a.txt'), 'utf8')).toBe('staged\n')
    expect(await status(dir)).toBe('M  src/a.txt\n')
  })

  it('目录名中的 pathspec 通配符按字面匹配，不影响其他目录', async () => {
    for (const name of ['group[1]', 'group1']) {
      await mkdir(path.join(dir, name))
      await writeFile(path.join(dir, name, 'tracked.txt'), 'original\n')
    }
    await git(dir, ['add', '.'])
    await commit(dir, 'add groups')
    for (const name of ['group[1]', 'group1']) {
      await writeFile(path.join(dir, name, 'tracked.txt'), 'changed\n')
      await writeFile(path.join(dir, name, 'new.txt'), 'untracked\n')
    }

    expect((await discardDirectory(dir, 'group[1]')).removed).toBe(1)
    expect(await readFile(path.join(dir, 'group[1]', 'tracked.txt'), 'utf8')).toBe('original\n')
    expect(existsSync(path.join(dir, 'group[1]', 'new.txt'))).toBe(false)
    expect(await readFile(path.join(dir, 'group1', 'tracked.txt'), 'utf8')).toBe('changed\n')
    expect(await readFile(path.join(dir, 'group1', 'new.txt'), 'utf8')).toBe('untracked\n')
  })

  it('纯未跟踪目录只删除其中未忽略的文件，保留忽略文件和目录外文件', async () => {
    await writeFile(path.join(dir, '.gitignore'), '*.ignored\n')
    await mkdir(path.join(dir, 'parent/new/nested'), { recursive: true })
    await writeFile(path.join(dir, 'parent/new/nested/file.txt'), 'remove\n')
    await writeFile(path.join(dir, 'parent/new/keep.ignored'), 'keep\n')
    await writeFile(path.join(dir, 'parent/outside.txt'), 'keep\n')

    expect((await discardDirectory(dir, 'parent/new')).removed).toBe(1)
    expect(existsSync(path.join(dir, 'parent/new/nested'))).toBe(false)
    expect(await readFile(path.join(dir, 'parent/new/keep.ignored'), 'utf8')).toBe('keep\n')
    expect(await readFile(path.join(dir, 'parent/outside.txt'), 'utf8')).toBe('keep\n')
  })

  it('清理纯未跟踪目录时保留所选目录外的空父目录', async () => {
    await mkdir(path.join(dir, 'parent/new'), { recursive: true })
    await writeFile(path.join(dir, 'parent/new/file.txt'), 'remove\n')

    expect((await discardDirectory(dir, 'parent/new')).removed).toBe(1)
    expect(existsSync(path.join(dir, 'parent/new'))).toBe(false)
    expect(existsSync(path.join(dir, 'parent'))).toBe(true)
  })

  it('整个仓库不能当文件夹回退，越界路径一律拒绝', async () => {
    await expect(discardDirectory(dir, '')).rejects.toThrow('缺少要回退的文件夹')
    await expect(discardDirectory(dir, '.')).rejects.toThrow('不能回退整个仓库')
    await expect(discardDirectory(dir, '../outside')).rejects.toThrow('Invalid repository path')
  })
})

describe('safeFilePath', () => {
  it('拒绝越出仓库的路径', () => {
    expect(() => safeFilePath('/repo', '../etc/passwd')).toThrow('Invalid repository path')
    expect(() => safeFilePath('/repo', '/etc/passwd')).toThrow('Invalid repository path')
    expect(safeFilePath('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
  })

  it('仓库根是符号链接时按真实路径认，不把同一目录判成越界', async () => {
    // macOS 上临时目录本身就是符号链接（`/var/...` → `/private/var/...`），
    // 用户从地址栏 / `?cwd=` 拿到的常常是链接那条写法，而 git 给的是真实路径。
    const dir = await setup()
    const link = path.join(tmpdir(), `mica-git-link-${Date.now()}`)
    await symlink(dir, link, 'dir')
    try {
      const { root } = await cachedRepository(link)
      expect(root).not.toBe(link)
      expect(safeFilePath(root, path.join(link, 'a.txt'))).toBe(path.join(root, 'a.txt'))
      expect(safeFilePath(link, path.join(root, 'a.txt'))).toBe(path.join(root, 'a.txt'))
    } finally {
      await rm(link, { force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('写操作也会挡住越界路径', async () => {
    const dir = await setup()
    try {
      await expect(stageFile(dir, '../outside.txt')).rejects.toThrow('Invalid repository path')
      await expect(discardFile(dir, '../outside.txt')).rejects.toThrow('Invalid repository path')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('索引锁', () => {
  let dir
  const indexFile = () => path.join(dir, '.git', 'index')
  const lockFile = () => path.join(dir, '.git', 'index.lock')
  const indexSnapshot = async () => (await readFile(indexFile())).toString('base64')

  beforeEach(async () => {
    dir = await setup()
    await writeFile(path.join(dir, 'a.txt'), 'one\n')
    await git(dir, ['add', '--', 'a.txt'])
    await commit(dir, 'add')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('读命令不写回索引，因此不会占用 .git/index.lock', async () => {
    // 不把「裸 git status 一定写回索引」当对照：git 只在 stat 信息过期时刷新，
    // 同一版本/文件系统下也可能跳过。这里只断言桌面轮询真正依赖的保证。
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    // 轮询走的读命令一律带 GIT_OPTIONAL_LOCKS=0：索引原封不动。
    await writeFile(path.join(dir, 'a.txt'), 'three\n')
    const stale = await indexSnapshot()
    await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])
    await git(dir, ['diff', 'HEAD', '--numstat', '--no-renames', '--'])
    expect(await indexSnapshot()).toBe(stale)
  })

  it('锁被短暂占着时写操作会重试成功', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    await writeFile(lockFile(), '')
    const timer = setTimeout(() => rm(lockFile(), { force: true }), 150)
    try {
      await discardFile(dir, 'a.txt')
    } finally {
      clearTimeout(timer)
      await rm(lockFile(), { force: true })
    }
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n')
  })

  it('锁一直不放时报出可操作的中文提示', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    await writeFile(lockFile(), '')
    try {
      const error = await discardFile(dir, 'a.txt').catch((failure) => failure)
      expect(String(error)).toContain('index.lock')
      const message = gitErrorMessage(error)
      expect(message).toContain('另一个 git 进程')
      expect(message).toContain('.git/index.lock')
    } finally {
      await rm(lockFile(), { force: true })
    }
  })

  it('其它错误原样透出', () => {
    expect(gitErrorMessage({ stderr: 'fatal: not a git repository\n' })).toBe(
      'fatal: not a git repository'
    )
  })
})

describe('getWorkspaceStatus', () => {
  let dir
  beforeEach(async () => {
    dir = await setup()
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('普通仓库给出根目录、分支名与项目名', async () => {
    const statusInfo = await getWorkspaceStatus(dir)
    expect(statusInfo.branch).toBe((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim())
    expect(statusInfo.projectName).toBe(path.basename(dir))
    expect(statusInfo.root).toBe((await git(dir, ['rev-parse', '--show-toplevel'])).trim())
  })

  it('还没有第一个提交时仍能报出分支名', async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), 'mica-git-unborn-'))
    try {
      await execFileAsync('git', ['init', '-q', '-b', 'trunk'], { cwd: fresh })
      const statusInfo = await getWorkspaceStatus(fresh)
      expect(statusInfo.branch).toBe('trunk')
      // macOS 的 tmpdir 是 /var/... 的符号链接，git 报的是 /private/var/...
      expect(statusInfo.root).toBe((await git(fresh, ['rev-parse', '--show-toplevel'])).trim())
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })

  it('游离 HEAD 报 detached 加短提交号', async () => {
    await git(dir, ['checkout', '-q', '--detach', 'HEAD'])
    const statusInfo = await getWorkspaceStatus(dir)
    expect(statusInfo.branch).toMatch(/^detached@[0-9a-f]{7,}$/)
  })

  it('不在仓库里时抛出 git 的原始错误', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'mica-git-none-'))
    try {
      const error = await getWorkspaceStatus(outside).catch((failure) => failure)
      expect(String(error)).toContain('not a git repository')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('cachedRepository', () => {
  let dir
  beforeEach(async () => {
    dir = await setup()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('同一 HEAD 下不重跑 rev-parse，直接复用结果', async () => {
    const first = await cachedRepository(dir)
    const second = await cachedRepository(dir)
    // 命中缓存拿到的是同一个对象；每次真的跑 rev-parse 会构造一个新的。
    expect(second).toBe(first)
  })

  it('提交之后 base 跟着 HEAD 更新', async () => {
    const before = await cachedRepository(dir)
    await commit(dir, 'second', ['--allow-empty'])
    const after = await cachedRepository(dir)
    expect(after.root).toBe(before.root)
    expect(after.base).not.toBe(before.base)
    expect(after.base).toBe((await git(dir, ['rev-parse', 'HEAD'])).trim())
  })

  it('不在仓库里时照常抛出，不缓存失败结果', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'mica-git-nocache-'))
    try {
      await expect(cachedRepository(outside)).rejects.toThrow(/not a git repository/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('cachedWorktreeRead', () => {
  let dir
  beforeEach(async () => {
    dir = await setup()
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  /** 一个能被计数的「读取」：慢一点，确保同时发起的调用真的重叠。 */
  function counter(delay = 30) {
    const state = { runs: 0 }
    state.run = async () => {
      state.runs += 1
      const mine = state.runs
      await new Promise((resolve) => setTimeout(resolve, delay))
      return `value-${mine}`
    }
    return state
  }

  it('同时发起的同一 key 只真正跑一次', async () => {
    const probe = counter()
    const results = await Promise.all([
      cachedWorktreeRead(dir, 'status', probe.run),
      cachedWorktreeRead(dir, 'status', probe.run),
      cachedWorktreeRead(dir, 'status', probe.run)
    ])
    expect(probe.runs).toBe(1)
    expect(results).toEqual(['value-1', 'value-1', 'value-1'])
  })

  it('跑完之后仍按 TTL 复用缓存', async () => {
    const probe = counter(0)
    await cachedWorktreeRead(dir, 'status', probe.run)
    await cachedWorktreeRead(dir, 'status', probe.run)
    expect(probe.runs).toBe(1)
  })

  it('不同 key 并发时各自的结果都留在缓存里', async () => {
    const probe = counter()
    const [a, b] = await Promise.all([
      cachedWorktreeRead(dir, 'status', probe.run),
      cachedWorktreeRead(dir, 'counts', probe.run)
    ])
    expect(probe.runs).toBe(2)
    expect(new Set([a, b]).size).toBe(2)
    // 两个 key 都能命中缓存：再读一次不会重新跑。
    expect(await cachedWorktreeRead(dir, 'status', probe.run)).toBe(a)
    expect(await cachedWorktreeRead(dir, 'counts', probe.run)).toBe(b)
    expect(probe.runs).toBe(2)
  })

  it('refresh 跳过缓存与在跑的读取', async () => {
    const probe = counter(80)
    const first = cachedWorktreeRead(dir, 'status', probe.run)
    const forced = await cachedWorktreeRead(dir, 'status', probe.run, { refresh: true })
    await first
    expect(probe.runs).toBe(2)
    expect(forced).toBe('value-2')
  })

  it('打点失效后重新跑', async () => {
    const probe = counter(0)
    await cachedWorktreeRead(dir, 'status', probe.run)
    noteWorktreeChange(dir)
    await cachedWorktreeRead(dir, 'status', probe.run)
    expect(probe.runs).toBe(2)
  })
})
