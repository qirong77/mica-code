import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Bun 的模块 mock 是进程级的；只在这个测试文件的隔离子进程里替换 IPC 和扫描输出。
if (process.env.MICA_GIT_SUMMARY_TEST_CHILD === '1') {
  const operations = { ...(await import('./git-ops')) }
  const handlers = new Map()
  const queued = []
  const scans = []
  let activeScan
  let root
  let clock
  let clockSpy

  function deferred() {
    let resolve
    const promise = new Promise((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  function scan(additions, gate = null) {
    queued.push({ additions, gate })
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const counts = (options = {}) => handlers.get('git:change-counts')(null, { cwd: root, ...options })
  const summary = (options = {}) => handlers.get('git:summary')(null, { cwd: root, ...options })

  mock.module('electron', () => ({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }
  }))
  mock.module('./git-ops', () => ({
    ...operations,
    cachedRepository: async (cwd) => ({ root: realpathSync.native(cwd), base: 'test-base' }),
    git: async (_cwd, args) => {
      if (args[0] === 'status') {
        activeScan = queued.shift()
        if (!activeScan) throw new Error('Unexpected full-tree scan')
        scans.push(activeScan)
        const job = activeScan
        await job.gate?.promise
        return ' M a.txt\0'
      }
      if (args[0] === 'diff') {
        const job = activeScan
        await job.gate?.promise
        return `${job.additions}\t0\ta.txt\n`
      }
      throw new Error(`Unexpected git command: ${args[0]}`)
    }
  }))

  beforeAll(async () => {
    const { registerGitIpc } = await import('./git')
    registerGitIpc()
  })

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'mica-git-summary-')))
    mkdirSync(path.join(root, '.git'))
    writeFileSync(path.join(root, '.git', 'HEAD'), `${'a'.repeat(40)}\n`)
    clock = Date.now()
    clockSpy = spyOn(Date, 'now').mockImplementation(() => clock)
    queued.length = 0
    scans.length = 0
  })

  afterEach(() => {
    clockSpy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  describe('Git summary and change counts', () => {
    it('shares automatic invalidation across windows and the summary panel', async () => {
      scan(1)
      expect((await counts()).counts.additions).toBe(1)
      const gate = deferred()
      scan(2, gate)
      const first = counts({ invalidate: true })
      const second = counts({ invalidate: true })
      const panel = summary({ invalidate: true })
      await flush()
      expect(scans).toHaveLength(2)
      gate.resolve()
      const [a, b, c] = await Promise.all([first, second, panel])
      expect(a.counts.additions).toBe(2)
      expect(b.counts.additions).toBe(2)
      expect(c.repository.additions).toBe(2)
      expect((await counts()).counts.additions).toBe(2)
    })

    it('keeps the 20s TTL and returns valid stale counts while one background scan runs', async () => {
      scan(1)
      expect((await counts()).counts.additions).toBe(1)
      clock += 19_999
      expect((await counts()).counts.additions).toBe(1)
      expect(scans).toHaveLength(1)
      const gate = deferred()
      scan(2, gate)
      clock += 1
      expect((await counts()).counts.additions).toBe(1)
      expect((await counts()).counts.additions).toBe(1)
      expect(scans).toHaveLength(2)
      gate.resolve()
      await flush()
      expect((await counts()).counts.additions).toBe(2)
    })

    it('does not let a slow background scan overwrite a newer manual refresh', async () => {
      scan(1)
      await counts()
      clock += 20_000
      const background = deferred()
      scan(2, background)
      expect((await counts()).counts.additions).toBe(1)
      scan(3)
      background.resolve()
      // Manual refresh is independent from the automatic request, but the
      // repository FIFO waits for the older scan before starting it.
      expect((await counts({ refresh: true })).counts.additions).toBe(3)
      await flush()
      expect((await counts()).counts.additions).toBe(3)
      expect((await summary()).repository.additions).toBe(3)
      expect(scans).toHaveLength(3)
    })

    it('waits for the current generation and keeps its in-flight scan after an old one finishes', async () => {
      scan(1)
      await counts()
      clock += 20_000
      const background = deferred()
      scan(2, background)
      expect((await counts()).counts.additions).toBe(1)
      operations.noteWorktreeChange(root)
      const replacement = deferred()
      scan(3, replacement)
      let settled = false
      const first = counts().then((value) => {
        settled = true
        return value
      })
      await flush()
      expect(settled).toBe(false)
      // The repository FIFO keeps the replacement behind the old generation;
      // it must not overlap the still-running scan.
      expect(scans).toHaveLength(2)
      background.resolve()
      await flush()
      const second = counts()
      await flush()
      expect(settled).toBe(false)
      expect(scans).toHaveLength(3)
      replacement.resolve()
      expect((await first).counts.additions).toBe(3)
      expect((await second).counts.additions).toBe(3)
      expect((await counts()).counts.additions).toBe(3)
    })

    it('does not return stale counts after HEAD changes', async () => {
      scan(1)
      await counts()
      writeFileSync(path.join(root, '.git', 'HEAD'), `${'b'.repeat(40)}\n`)
      const gate = deferred()
      scan(2, gate)
      let settled = false
      const fresh = counts().then((value) => {
        settled = true
        return value
      })
      await flush()
      expect(settled).toBe(false)
      expect(scans).toHaveLength(2)
      gate.resolve()
      expect((await fresh).counts.additions).toBe(2)
    })

    it('does not cache counts when the repository signature cannot be read', async () => {
      rmSync(path.join(root, '.git', 'HEAD'))
      scan(1)
      expect((await counts()).counts.additions).toBe(1)
      scan(2)
      expect((await counts()).counts.additions).toBe(2)
      expect(scans).toHaveLength(2)
    })
  })
} else {
  it('runs Git IPC cache tests without leaking module mocks', async () => {
    const child = spawn(process.execPath, ['test', '--timeout=20000', import.meta.path], {
      env: { ...process.env, MICA_GIT_SUMMARY_TEST_CHILD: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    const collect = async (stream) => {
      let text = ''
      for await (const chunk of stream) text += chunk
      return text
    }
    const [exitCode, stdout, stderr] = await Promise.all([
      finished,
      collect(child.stdout),
      collect(child.stderr)
    ])
    expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 })
  }, 30_000)
}
