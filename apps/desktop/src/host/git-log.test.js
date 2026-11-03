import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFile, spawn } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'
import { getCommit, getLog, parseDecorations } from './git-log'
import { git } from './git-ops'

const execFileAsync = promisify(execFile)

async function run(dir, args) {
  return execFileAsync('git', args, { cwd: dir })
}

function commit(dir, message) {
  return run(dir, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', message])
}

describe('parseDecorations', () => {
  it('拆出 HEAD、分支、远端与标签', () => {
    expect(parseDecorations('HEAD -> main, origin/main, tag: v1')).toEqual([
      { kind: 'head', name: 'main' },
      { kind: 'remote', name: 'origin/main' },
      { kind: 'tag', name: 'v1' }
    ])
    expect(parseDecorations('HEAD')).toEqual([{ kind: 'head', name: 'HEAD' }])
    expect(parseDecorations('')).toEqual([])
  })
})

describe('getLog / getCommit', () => {
  let dir
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mica-git-log-'))
    await run(dir, ['init', '-q', '-b', 'main'])
    await writeFile(path.join(dir, 'a.txt'), 'one\n')
    await git(dir, ['add', '--', 'a.txt'])
    await commit(dir, 'first')
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n')
    await git(dir, ['add', '--', 'a.txt'])
    await commit(dir, 'second')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('按时间倒序返回提交，父提交拆成数组', async () => {
    const history = await getLog(dir)
    expect(history.commits.map((entry) => entry.subject)).toEqual(['second', 'first'])
    expect(history.commits[0].parents.length).toBe(1)
    expect(history.commits[1].parents.length).toBe(0)
    expect(history.commits[0].refs.some((ref) => ref.name === 'main')).toBe(true)
    expect(history.head).toBeTruthy()
  })

  it('指定分支时只走那条分支的祖先链', async () => {
    await run(dir, ['checkout', '-q', '-b', 'side'])
    await writeFile(path.join(dir, 'b.txt'), 'b\n')
    await git(dir, ['add', '--', 'b.txt'])
    await commit(dir, 'side-only')
    await run(dir, ['checkout', '-q', 'main'])
    const mainOnly = await getLog(dir, { ref: 'main' })
    expect(mainOnly.commits.map((entry) => entry.subject)).toEqual(['second', 'first'])
    const side = await getLog(dir, { ref: 'side' })
    expect(side.commits[0].subject).toBe('side-only')
    const all = await getLog(dir)
    expect(all.commits.some((entry) => entry.subject === 'side-only')).toBe(true)
  })

  it('默认历史包含游离 HEAD 独有的提交，指定分支仍仅包含该分支', async () => {
    await run(dir, ['checkout', '-q', '--detach'])
    await run(dir, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'detached'])
    const all = await getLog(dir)
    expect(all.commits.map((entry) => entry.subject)).toEqual(['detached', 'second', 'first'])
    expect(all.commits[0].refs).toContainEqual({ kind: 'head', name: 'HEAD' })
    expect((await getLog(dir, { ref: 'main' })).commits.map((entry) => entry.subject)).toEqual(['second', 'first'])
  })

  it('按偏移读取超过 2000 条的历史，分页没有重叠或遗漏', async () => {
    const records = Array.from({ length: 2001 }, (_, i) => {
      const message = `generated-${i}`
      return `commit refs/heads/generated\nmark :${i + 1}\ncommitter T <t@e.com> ${1700000000 + i} +0000\ndata ${message.length}\n${message}\n${i ? `from :${i}\n` : ''}\n`
    }).join('')
    await new Promise((resolve, reject) => {
      const child = spawn('git', ['fast-import', '--quiet'], { cwd: dir })
      let error = ''
      child.stderr.on('data', (chunk) => { error += chunk })
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(error)))
      child.stdin.end(records)
    })
    const first = await getLog(dir, { ref: 'generated', max: 2000 })
    const second = await getLog(dir, { ref: 'generated', max: 200, skip: 2000 })
    expect(first.commits).toHaveLength(2000)
    expect(first.more).toBe(true)
    expect(second.commits.map((entry) => entry.subject)).toEqual(['generated-0'])
    expect(second.more).toBe(false)
    expect(new Set([...first.commits, ...second.commits].map((entry) => entry.hash)).size).toBe(2001)
  })

  it('笔记与 stash 不算历史', async () => {
    // `--all` 会把 refs/notes/* 一起读出来，笔记提交的说明是空的、作者是写笔记的工具，
    // 在图谱里就是一串没有意义的空行。
    await run(dir, ['notes', '--ref=ai', 'add', '-m', 'note', 'HEAD'])
    await writeFile(path.join(dir, 'stash.txt'), 'stash\n')
    await git(dir, ['add', '--', 'stash.txt'])
    await run(dir, ['stash', 'push', '-q', '-m', 'wip'])
    const history = await getLog(dir)
    expect(history.commits.map((entry) => entry.subject)).toEqual(['second', 'first'])
  })

  it('提交详情相对第一个父提交列出改动文件', async () => {
    const history = await getLog(dir)
    const detail = await getCommit(dir, history.commits[0].hash)
    expect(detail.commit.subject).toBe('second')
    expect(detail.files).toEqual([
      { path: 'a.txt', status: 'modified', additions: 1, deletions: 0, binary: false }
    ])
    expect(detail.base).toBe(detail.commit.parents[0])
    expect(detail.additions).toBe(1)
  })

  it('根提交与空树比较', async () => {
    const history = await getLog(dir)
    const root = history.commits.at(-1)
    const detail = await getCommit(dir, root.hash)
    expect(detail.files.map((file) => file.path)).toEqual(['a.txt'])
    expect(detail.commit.parents).toEqual([])
  })

  it('空仓库回空历史而不是报错', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'mica-git-log-empty-'))
    try {
      await run(empty, ['init', '-q'])
      const history = await getLog(empty)
      expect(history.commits).toEqual([])
      expect(history.head).toBeNull()
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
