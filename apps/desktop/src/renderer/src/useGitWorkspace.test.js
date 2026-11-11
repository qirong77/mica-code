import { describe, expect, it, mock } from 'bun:test'
import { readGitWorkspace } from './useGitWorkspace'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function api() {
  return {
    summary: mock(async () => ({ repository: { root: '/repo', files: [] } })),
    branchSummary: mock(async () => ({ repository: { root: '/repo', files: [] } })),
    refSummary: mock(async () => ({ repository: { root: '/repo', files: [] } })),
    status: mock(async () => ({ status: { root: '/repo', branch: 'main' } }))
  }
}

describe('editor Git read pipeline', () => {
  it('does not poll branch-summary or status after confirming there is no repository', async () => {
    const git = api()
    git.summary = mock(async () => ({ repository: null, error: null }))
    for (let i = 0; i < 3; i += 1) {
      const value = await readGitWorkspace(git, '/outside')
      expect(value.repository).toBeNull()
      expect(value.compareError).toBeNull()
      expect(value.loading).toBe(false)
    }
    expect(git.branchSummary).not.toHaveBeenCalled()
    expect(git.status).not.toHaveBeenCalled()
  })

  it('can discover a newly initialized repository on the next read and forget a removed one', async () => {
    const git = api()
    let exists = false
    git.summary = mock(async () => ({ repository: exists ? { root: '/repo', files: [] } : null }))
    expect((await readGitWorkspace(git, '/repo')).repository).toBeNull()
    exists = true
    expect((await readGitWorkspace(git, '/repo')).status.branch).toBe('main')
    exists = false
    expect((await readGitWorkspace(git, '/repo')).status).toBeNull()
    expect(git.branchSummary).toHaveBeenCalledTimes(1)
    expect(git.status).toHaveBeenCalledTimes(1)
  })

  it('keeps real summary/status errors visible', async () => {
    const git = api()
    git.summary = mock(async () => ({ repository: null, error: 'permission denied' }))
    expect((await readGitWorkspace(git, '/repo')).compareError).toBe('permission denied')
    git.summary = mock(async () => ({ repository: { root: '/repo', files: [] } }))
    git.status = mock(async () => ({ status: null, error: 'corrupt HEAD' }))
    expect((await readGitWorkspace(git, '/repo')).compareError).toBe('corrupt HEAD')
  })

  it('does not start follow-up reads for an old directory when its summary arrives late', async () => {
    const git = api()
    const old = deferred()
    git.summary = mock((cwd) => cwd === '/old' ? old.promise : Promise.resolve({ repository: { root: cwd } }))
    let cwd = '/old'
    const previous = readGitWorkspace(git, '/old', { isCurrent: () => cwd === '/old' })
    cwd = '/new'
    const next = await readGitWorkspace(git, '/new')
    old.resolve({ repository: { root: '/old' } })
    expect(await previous).toBeNull()
    expect(next.cwd).toBe('/new')
    expect(git.branchSummary).toHaveBeenCalledTimes(1)
    expect(git.branchSummary.mock.calls[0][0]).toBe('/new')
    expect(git.status.mock.calls[0][0]).toBe('/new')
  })

  it('waits for the other read before releasing a rejected refresh', async () => {
    const git = api()
    const branch = deferred()
    const status = deferred()
    git.branchSummary = mock(() => branch.promise)
    git.status = mock(() => status.promise)
    let settled = false
    const result = readGitWorkspace(git, '/repo').then(
      () => { settled = true },
      (error) => { settled = true; return error }
    )
    await Promise.resolve()
    branch.reject(new Error('read failed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    status.resolve({ status: null })
    expect((await result).message).toBe('read failed')
  })

  it('reads explicit commit reviews without a worktree scan or status process', async () => {
    const git = api()
    const value = await readGitWorkspace(git, '/repo', { compare: { base: 'main', head: 'feature' } })
    expect(value.review).toBe(true)
    expect(git.refSummary).toHaveBeenCalledWith('/repo', { base: 'main', head: 'feature' })
    expect(git.summary).not.toHaveBeenCalled()
    expect(git.branchSummary).not.toHaveBeenCalled()
    expect(git.status).not.toHaveBeenCalled()
  })

  it('resolves saved comparison preferences by repository root while retaining checkout status', async () => {
    const git = api()
    const value = await readGitWorkspace(git, '/repo/sub', {
      bases: { '/repo': { ref: 'main' } }, heads: { '/repo': { ref: 'feature' } }
    })
    expect(value.review).toBe(true)
    expect(git.refSummary).toHaveBeenCalledWith('/repo/sub', { base: 'main', head: 'feature' })
    expect(git.status).toHaveBeenCalledTimes(1)
  })
})
