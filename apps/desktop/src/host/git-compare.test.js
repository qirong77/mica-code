import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { getBranchSummary, getFile, getRefs, resolveRef } from './git-compare'
import { EMPTY_TREE, git } from './git-ops'

let root
const write = (name, content) => writeFile(path.join(root, name), content)
const hash = () => git(root, ['rev-parse', 'HEAD']).then((value) => value.trim())
async function commit(message = 'change') {
  await git(root, ['add', '-A', '--'])
  await git(root, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    message,
    '--allow-empty'
  ])
  return hash()
}
const file = (summary, name) => summary.files.find((item) => item.path === name)

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mica-git-compare-'))
  await git(root, ['init', '-q', '-b', 'main'])
  await git(root, ['config', 'core.hooksPath', '/dev/null'])
  await git(root, ['config', 'core.autocrlf', 'false'])
  await write('a.txt', 'original\n')
  await commit('initial')
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('branch snapshots', () => {
  it('compares diverged branches at merge-base or directly using immutable commits', async () => {
    const ancestor = await hash()
    await git(root, ['checkout', '-qb', 'feature'])
    await write('feature.txt', 'feature\n')
    const head = await commit('feature')
    await git(root, ['checkout', '-q', 'main'])
    await write('main.txt', 'upstream\n')
    const main = await commit('main')
    await git(root, ['checkout', '-q', 'feature'])
    await write('a.txt', 'working\n')
    const merged = await getBranchSummary(root)
    expect(merged).toMatchObject({
      base: 'main',
      baseLabel: 'main',
      head,
      mergeBase: ancestor,
      compareRef: ancestor,
      direct: false,
      additions: 2,
      deletions: 1
    })
    expect(merged.files.map((item) => item.path)).toEqual(['a.txt', 'feature.txt'])
    expect(file(merged, 'feature.txt').uncommitted).toBe(false)
    expect(file(merged, 'a.txt').uncommitted).toBe(true)
    const direct = await getBranchSummary(root, { base: 'refs/heads/main', direct: true })
    expect(direct).toMatchObject({ compareRef: main, direct: true })
    expect(file(direct, 'main.txt').status).toBe('deleted')
  })

  it('returns a complete HEAD comparison when automatic base is absent or current', async () => {
    const head = await hash()
    await write('a.txt', 'working\n')
    for (const branch of ['main', 'topic']) {
      if (branch === 'topic') await git(root, ['branch', '-m', 'topic'])
      const summary = await getBranchSummary(root)
      expect(summary).toMatchObject({
        base: 'HEAD',
        baseLabel: 'HEAD',
        head,
        compareRef: head,
        mergeBase: head,
        direct: true,
        additions: 1,
        deletions: 1
      })
      expect(summary.files).toHaveLength(1)
    }
  })

  it('warns on invalid requested refs and rejects options and non-commit objects', async () => {
    const blob = (await git(root, ['rev-parse', 'HEAD:a.txt'])).trim()
    for (const ref of ['missing-branch', '--help', blob]) {
      const response = await resolveRef(root, ref)
      expect(response.ref).toBeNull()
      expect(response.error).toBeTruthy()
      const summary = await getBranchSummary(root, { base: ref })
      expect(summary.base).toBe('HEAD')
      expect(summary.warning).toContain(ref)
      expect(summary.direct).toBe(true)
    }
  })

  it('resolves custom commits and tags and keeps file originals after a branch moves', async () => {
    const original = await hash()
    await git(root, ['tag', 'v1'])
    expect(await resolveRef(root, original.slice(0, 10))).toEqual({
      ref: { hash: original, name: original.slice(0, 10) },
      error: null
    })
    expect((await resolveRef(root, 'refs/tags/v1')).ref.hash).toBe(original)
    await write('a.txt', 'second\n')
    await commit('second')
    const summary = await getBranchSummary(root, { base: 'v1', direct: true })
    expect(summary.compareRef).toBe(original)
    await git(root, ['tag', '-f', 'v1'])
    const diff = await getFile(root, 'a.txt', { mode: 'snapshot', ref: summary.compareRef })
    expect(diff).toMatchObject({
      original: 'original\n',
      modified: 'second\n',
      originalLabel: original,
      modifiedLabel: 'Working Tree',
      binary: false
    })
    expect((await getBranchSummary(root, { base: original, direct: true })).compareRef).toBe(
      original
    )
  })

  it('compares unrelated histories directly', async () => {
    const base = await hash()
    await git(root, ['checkout', '--orphan', 'unrelated'])
    await git(root, ['rm', '-rf', '--', '.'])
    await write('new.txt', 'new\n')
    await commit('orphan')
    const summary = await getBranchSummary(root, { base: 'main' })
    expect(summary).toMatchObject({ mergeBase: null, direct: true, compareRef: base })
    expect(summary.files.map((item) => item.status).sort()).toEqual(['added', 'deleted'])
  })

  it('handles unborn repositories with the empty tree and empty additions', async () => {
    await git(root, ['checkout', '--orphan', 'fresh'])
    await git(root, ['rm', '-rf', '--', '.'])
    await git(root, ['branch', '-D', 'main'])
    await write('empty.txt', '')
    const summary = await getBranchSummary(root)
    expect(summary).toMatchObject({
      base: 'HEAD',
      compareRef: EMPTY_TREE,
      head: EMPTY_TREE,
      direct: true,
      additions: 0,
      deletions: 0
    })
    expect(file(summary, 'empty.txt').status).toBe('added')
    expect(
      (await getFile(root, 'empty.txt', { mode: 'snapshot', ref: summary.compareRef })).original
    ).toBe('')
  })

  it('includes zero-byte tracked additions/deletions and untracked binary files', async () => {
    await write('delete-empty.txt', '')
    await write('delete.txt', 'remove\n')
    await commit()
    await rm(path.join(root, 'delete-empty.txt'))
    await rm(path.join(root, 'delete.txt'))
    await write('added-empty.txt', '')
    await git(root, ['add', '--', 'added-empty.txt'])
    await write('untracked-empty.txt', '')
    await write('binary.dat', Buffer.from([0, 1, 2, 10]))
    const summary = await getBranchSummary(root)
    expect(summary.files).toHaveLength(5)
    expect(file(summary, 'delete-empty.txt')).toMatchObject({
      status: 'deleted',
      additions: 0,
      deletions: 0
    })
    expect(file(summary, 'added-empty.txt')).toMatchObject({
      status: 'added',
      additions: 0,
      deletions: 0
    })
    expect(file(summary, 'untracked-empty.txt')).toMatchObject({
      status: 'added',
      additions: 0,
      deletions: 0
    })
    expect(file(summary, 'binary.dat')).toMatchObject({
      status: 'added',
      binary: true,
      additions: 0
    })
    expect(summary.deletions).toBe(1)
    expect(await getFile(root, 'binary.dat')).toMatchObject({
      original: '',
      modified: '',
      binary: true
    })
    expect(await getFile(root, 'delete.txt')).toMatchObject({ original: 'remove\n', modified: '' })
  })

  it('preserves tabs, newlines, option-like names and nested literal pathspecs', async () => {
    const names = ['tab\tfile.txt', 'line\nfile.txt', '--help', ':(glob)*.txt', 'nested/a.txt']
    await mkdir(path.join(root, 'nested'))
    for (const name of names) await write(name, 'before\n')
    await commit()
    for (const name of names) await write(name, 'after\n')
    const summary = await getBranchSummary(root)
    for (const name of names) {
      expect(file(summary, name)).toMatchObject({ additions: 1, deletions: 1, status: 'modified' })
      expect(
        await getFile(root, name, { mode: 'snapshot', ref: summary.compareRef })
      ).toMatchObject({ original: 'before\n', modified: 'after\n' })
    }
    await expect(getFile(root, '../outside')).rejects.toThrow('Invalid repository path')
  })

  it('fingerprints actual bytes, comparison commits, file modes and symlink targets', async () => {
    await write('a.txt', 'changed1\n')
    const first = await getBranchSummary(root)
    expect((await getBranchSummary(root)).files[0].fingerprint).toBe(first.files[0].fingerprint)
    await write('a.txt', 'changed2\n')
    const second = await getBranchSummary(root)
    expect(second.additions).toBe(first.additions)
    expect(second.deletions).toBe(first.deletions)
    expect(second.files[0].fingerprint).not.toBe(first.files[0].fingerprint)
    await chmod(path.join(root, 'a.txt'), 0o755)
    expect((await getBranchSummary(root)).files[0].fingerprint).not.toBe(
      second.files[0].fingerprint
    )
    await symlink('target1', path.join(root, 'link'))
    const links = await getBranchSummary(root)
    await rm(path.join(root, 'link'))
    await symlink('target2', path.join(root, 'link'))
    expect(file(await getBranchSummary(root), 'link').fingerprint).not.toBe(
      file(links, 'link').fingerprint
    )
    expect((await getFile(root, 'link')).modified).toBe('target2')
    const previous = await hash()
    await commit()
    await write('a.txt', 'changed3\n')
    const earlier = await getBranchSummary(root, { base: previous, direct: true })
    const current = await getBranchSummary(root, { base: 'HEAD', direct: true })
    expect(file(earlier, 'a.txt').fingerprint).not.toBe(file(current, 'a.txt').fingerprint)
  })
})

describe('file comparison modes and refs', () => {
  it('uses HEAD → index for staged and index → disk for worktree', async () => {
    await write('a.txt', 'staged\n')
    await git(root, ['add', '--', 'a.txt'])
    await write('a.txt', 'unstaged\n')
    expect(await getFile(root, 'a.txt', { mode: 'staged' })).toMatchObject({
      original: 'original\n',
      modified: 'staged\n',
      originalLabel: 'HEAD',
      modifiedLabel: 'Index'
    })
    expect(await getFile(root, 'a.txt', { mode: 'worktree' })).toMatchObject({
      original: 'staged\n',
      modified: 'unstaged\n',
      originalLabel: 'Index',
      modifiedLabel: 'Working Tree'
    })
    expect(await getFile(root, 'a.txt', 'head')).toMatchObject({
      original: 'original\n',
      modified: 'unstaged\n'
    })
    expect(await getFile(root, 'a.txt', { mode: 'branch' })).toMatchObject({
      original: 'original\n',
      modified: 'unstaged\n'
    })
    expect(await getFile(root, 'a.txt', { mode: 'ref', ref: 'HEAD', direct: true })).toMatchObject({
      original: 'original\n',
      modified: 'unstaged\n'
    })
  })

  it('handles staged addition/deletion and binary in the correct side', async () => {
    await write('new.txt', '')
    await git(root, ['add', '--', 'new.txt'])
    await write('new.txt', 'worktree\n')
    expect(await getFile(root, 'new.txt', { mode: 'staged' })).toMatchObject({
      original: '',
      modified: ''
    })
    expect(await getFile(root, 'new.txt', { mode: 'worktree' })).toMatchObject({
      original: '',
      modified: 'worktree\n'
    })
    await git(root, ['rm', '--', 'a.txt'])
    await write('a.txt', 'recreated\n')
    expect(await getFile(root, 'a.txt', { mode: 'staged' })).toMatchObject({
      original: 'original\n',
      modified: ''
    })
    expect(await getFile(root, 'a.txt', { mode: 'worktree' })).toMatchObject({
      original: '',
      modified: 'recreated\n'
    })
    await write('binary', Buffer.from([0, 1]))
    await git(root, ['add', '--', 'binary'])
    await write('binary', 'text\n')
    expect((await getFile(root, 'binary', { mode: 'staged' })).binary).toBe(true)
    expect((await getFile(root, 'binary', { mode: 'worktree' })).binary).toBe(true)
  })

  it('lists remote short names alongside local branches, excludes symbolic HEAD and keeps tags', async () => {
    const head = await hash()
    await git(root, ['update-ref', 'refs/remotes/origin/main', head])
    await git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    await git(root, ['tag', 'v1'])
    const refs = await getRefs(root)
    expect(refs.branches).toHaveLength(2)
    expect(refs.branches[0]).toMatchObject({ kind: 'branch', name: 'main', current: true })
    expect(refs.branches[1]).toMatchObject({
      kind: 'remote',
      name: 'origin/main',
      ref: 'refs/remotes/origin/main',
      current: false
    })
    expect(refs.tags[0]).toMatchObject({ kind: 'tag', name: 'v1' })
    expect((await resolveRef(root, 'origin/main')).ref.hash).toBe(head)
  })
})
