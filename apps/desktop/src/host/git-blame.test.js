import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFile } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'
import { blameLine, parseBlamePorcelain } from './git-blame'
import { git } from './git-ops'

const execFileAsync = promisify(execFile)

function commit(dir, message, date) {
  const env = date
    ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    : process.env
  return execFileAsync(
    'git',
    ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', message],
    { cwd: dir, env }
  )
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mica-git-blame-'))
  await execFileAsync('git', ['init', '-q'], { cwd: dir })
  await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  await git(dir, ['add', '--', 'a.txt'])
  await commit(dir, 'first', '2024-01-01T10:00:00+08:00')
  return dir
}

describe('parseBlamePorcelain', () => {
  it('解析分组头与元数据，连续多行复用同一份提交信息', () => {
    const output = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2',
      'author Ann',
      'author-mail <ann@example.com>',
      'author-time 1704074400',
      'author-tz +0800',
      'summary first',
      'filename a.txt',
      '\tone',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2',
      '\ttwo'
    ].join('\n')
    const lines = parseBlamePorcelain(output)
    expect(lines.get(1).author).toBe('Ann')
    expect(lines.get(1).authorTime).toBe(1704074400000)
    expect(lines.get(2).author).toBe('Ann')
    expect(lines.get(2).summary).toBe('first')
    expect(lines.get(2).filename).toBe('a.txt')
  })

  it('零哈希标记为未提交', () => {
    const output = [
      '0000000000000000000000000000000000000000 1 1 1',
      'author Not Committed Yet',
      'summary Version of a.txt from a.txt',
      '\tone'
    ].join('\n')
    const lines = parseBlamePorcelain(output)
    expect(lines.get(1).uncommitted).toBe(true)
  })
})

describe('blameLine', () => {
  let dir
  beforeEach(async () => {
    dir = await setup()
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('工作区口径给出提交作者、提交信息与时间', async () => {
    const blame = await blameLine(dir, 'a.txt', { line: 2 })
    expect(blame.error).toBeUndefined()
    expect(blame.author).toBe('T')
    expect(blame.summary).toBe('first')
    expect(blame.source).toBe('worktree')
    expect(blame.uncommitted).toBe(false)
    expect(blame.shortHash.length).toBe(8)
    expect(blame.time).toBe(Date.parse('2024-01-01T10:00:00+08:00'))
  })

  it('未提交的那一行标成未提交，并带上上一版提交', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    const blame = await blameLine(dir, 'a.txt', { line: 2 })
    expect(blame.uncommitted).toBe(true)
    expect(blame.previous?.hash).toBeTruthy()
  })

  it('按提交口径读历史版本', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    await git(dir, ['add', '--', 'a.txt'])
    await commit(dir, 'second', '2024-02-02T10:00:00+08:00')
    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim()
    const atHead = await blameLine(dir, 'a.txt', { ref: 'HEAD', line: 4 })
    expect(atHead.summary).toBe('second')
    expect(atHead.hash).toBe(head)
    const atFirst = await blameLine(dir, 'a.txt', { ref: 'HEAD~1', line: 1 })
    expect(atFirst.summary).toBe('first')
  })

  it('索引口径读暂存区里那份内容', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO staged\nthree\n')
    await git(dir, ['add', '--', 'a.txt'])
    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO staged\nthree\nfour worktree\n')
    const staged = await blameLine(dir, 'a.txt', { index: true, line: 2 })
    expect(staged.source).toBe('index')
    expect(staged.uncommitted).toBe(true)
  })

  it('取不到时回错误而不是抛异常', async () => {
    const missing = await blameLine(dir, 'nope.txt', { line: 1 })
    expect(missing.error).toBeTruthy()
    const outOfRange = await blameLine(dir, 'a.txt', { line: 99 })
    expect(outOfRange.error).toBeTruthy()
  })

  it('不会因为读 blame 改动工作区', async () => {
    await blameLine(dir, 'a.txt', { line: 1 })
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
  })
})
