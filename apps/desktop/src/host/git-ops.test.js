import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'
import {
  discardFile,
  getWorkspaceStatus,
  git,
  gitErrorMessage,
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

describe('safeFilePath', () => {
  it('拒绝越出仓库的路径', () => {
    expect(() => safeFilePath('/repo', '../etc/passwd')).toThrow('Invalid repository path')
    expect(() => safeFilePath('/repo', '/etc/passwd')).toThrow('Invalid repository path')
    expect(safeFilePath('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
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
    expect(statusInfo.branch).toBe(
      (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    )
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
