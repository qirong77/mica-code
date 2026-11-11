import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import * as gitOperations from './git-ops'

const actualGitOperations = { ...gitOperations }
const { git, noteWorktreeChange } = actualGitOperations
const commands = []
// Count dispatched commands while still executing real Git in isolated repositories.
// Trace2 targets in repository-local config are not honored by all Git versions.
mock.module('./git-ops', () => ({
  ...actualGitOperations,
  git(cwd, args, options) {
    commands.push({ cwd, args: [...args] })
    return git(cwd, args, options)
  }
}))
afterAll(() => mock.module('./git-ops', () => actualGitOperations))

const handlers = new Map()
mock.module('electron', () => ({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) } }))
const { registerGitIpc } = await import('./git')
registerGitIpc()
const invoke = (name, payload) => handlers.get(`git:${name}`)({}, payload)

let dir
beforeEach(async () => {
  commands.length = 0
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'mica-git-ipc-')))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function repository() {
  await git(dir, ['init', '-q', '-b', 'main'])
  await writeFile(path.join(dir, 'tracked.txt'), 'one\n')
  await git(dir, ['add', '.'])
  await git(dir, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'init'])
  const trace = path.join(dir, '.git', 'read-trace.jsonl')
  return trace
}

async function scans(trace) {
  const root = path.dirname(path.dirname(trace))
  return commands.filter((command) => command.cwd === root && ['status', 'diff'].includes(command.args[0]))
    .map((command) => command.args[0]).sort()
}

describe('Git IPC reads', () => {
  it('non-repository polling returns an empty state, while missing directories and corrupt metadata stay errors', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(await invoke('status', { cwd: dir })).toEqual({ status: null, error: null })
      expect(await invoke('summary', { cwd: dir })).toEqual({ repository: null, error: null })
      expect(await invoke('change-counts', { cwd: dir })).toEqual({ counts: null, error: null })
    }
    expect((await invoke('status', { cwd: path.join(dir, 'missing') })).error).toContain('ENOENT')
    await repository()
    await writeFile(path.join(dir, '.git', 'HEAD'), 'corrupt HEAD\n')
    const broken = await invoke('status', { cwd: dir })
    expect(broken.status).toBeNull()
    expect(broken.error).toBeTruthy()
  })

  it('shares one actual scan between concurrent summary and badge requests', async () => {
    const trace = await repository()
    await writeFile(path.join(dir, 'tracked.txt'), 'one\ntwo\n')
    const [summary, a, b] = await Promise.all([
      invoke('summary', { cwd: dir }),
      invoke('change-counts', { cwd: dir }),
      invoke('change-counts', { cwd: dir, invalidate: true })
    ])
    expect(a.error).toBeNull()
    expect(b.counts).toEqual(a.counts)
    expect(a.counts.additions).toBe(summary.repository.additions)
    expect(a.counts.files).toBe(summary.repository.files.length)
    expect(await scans(trace)).toEqual(['diff', 'status'])
  })

  it('does not reuse the outer workspace inside Git metadata or an embedded bare repository', async () => {
    await repository()
    expect((await invoke('summary', { cwd: dir })).repository.root).toBe(dir)
    expect((await invoke('status', { cwd: dir })).status.root).toBe(dir)
    const bare = path.join(dir, 'embedded.git')
    await git(dir, ['init', '--bare', '-q', bare])
    for (const cwd of [path.join(dir, '.git'), bare]) {
      for (const channel of ['status', 'summary', 'change-counts']) {
        const result = await invoke(channel, { cwd })
        expect(result.error).toContain('work tree')
        expect(result.status || result.repository || result.counts || null).toBeNull()
      }
    }
  })

  it('reuses a completed current-generation editor scan after a watcher change and immediately reads new content', async () => {
    const trace = await repository()
    expect((await invoke('change-counts', { cwd: dir })).counts.additions).toBe(0)
    await writeFile(path.join(dir, 'tracked.txt'), 'one\ntwo\nthree\n')
    noteWorktreeChange(dir)
    const summary = await invoke('summary', { cwd: dir })
    // git:changed already advanced the host epoch; its caller must not invalidate a second time.
    const counts = await invoke('change-counts', { cwd: dir })
    expect(counts.counts.additions).toBe(2)
    expect(counts.counts.additions).toBe(summary.repository.additions)
    expect(await scans(trace)).toEqual(['diff', 'diff', 'status', 'status'])
  })

  it('turn-end invalidation still detects an external edit without a watcher notification', async () => {
    const trace = await repository()
    await invoke('change-counts', { cwd: dir })
    await writeFile(path.join(dir, 'tracked.txt'), 'replacement\n')
    const counts = await invoke('change-counts', { cwd: dir, invalidate: true })
    expect(counts.counts.additions).toBe(1)
    expect(counts.counts.deletions).toBe(1)
    expect(await scans(trace)).toEqual(['diff', 'diff', 'status', 'status'])
  })

  it('an external edit missed by watchers is discovered by TTL background refresh', async () => {
    await repository()
    const first = await invoke('change-counts', { cwd: dir })
    await writeFile(path.join(dir, 'tracked.txt'), 'one\nexternal\n')
    const realNow = Date.now
    const clock = realNow() + 21_000
    Date.now = () => clock
    try {
      const stale = await invoke('change-counts', { cwd: dir })
      expect(stale.counts).toEqual(first.counts)
      // summary shares (or sees the result of) the background scan, without starting another.
      const summary = await invoke('summary', { cwd: dir })
      expect(summary.repository.additions).toBe(1)
      expect((await invoke('change-counts', { cwd: dir })).counts.additions).toBe(1)
    } finally {
      Date.now = realNow
    }
  })

  it('manual refresh starts a fresh scan and deleted/recreated metadata cannot reuse old values', async () => {
    const trace = await repository()
    const before = await invoke('change-counts', { cwd: dir })
    await invoke('change-counts', { cwd: dir, refresh: true })
    expect(await scans(trace)).toEqual(['diff', 'diff', 'status', 'status'])
    await rm(path.join(dir, '.git'), { recursive: true })
    expect(await invoke('change-counts', { cwd: dir })).toEqual({ counts: null, error: null })
    await git(dir, ['init', '-q', '-b', 'new-main'])
    const after = await invoke('change-counts', { cwd: dir })
    expect(after.counts.root).toBe(before.counts.root)
    expect(after.counts.additions).toBe(1)
    expect((await invoke('status', { cwd: dir })).status.branch).toBe('new-main')
  })
})
