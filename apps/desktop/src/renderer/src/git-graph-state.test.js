import { describe, expect, it, mock } from 'bun:test'
import { createGitGraphRequest } from './git-graph-state'
// Monaco's worker loader belongs to Vite; this lifecycle test does not render a diff editor.
mock.module('./GitDiffEditor', () => ({ GitDiffEditor: () => null }))
const { GitGraphView } = await import('./GitGraphView')

describe('Git graph directory lifecycle', () => {
  it('gives every directory a separate React state lifetime, including switching back', () => {
    const a = GitGraphView({ cwd: '/a' })
    const b = GitGraphView({ cwd: '/b' })
    expect(a.type).toBe(b.type)
    expect(a.key).toBe('/a')
    expect(b.key).toBe('/b')
    expect(GitGraphView({ cwd: null }).key).toBe('')
    expect(GitGraphView({ cwd: '/a' }).key).not.toBe(b.key)
  })

  it('does not launch reads queued for a directory that has already unmounted', async () => {
    const read = mock(async () => ({ history: { commits: ['old'] } }))
    const request = createGitGraphRequest(read)
    request.cancel()
    expect(await request.promise).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  for (const kind of ['history', 'refs', 'detail']) {
    it(`ignores late ${kind} from the previous directory`, async () => {
      let finish
      const old = createGitGraphRequest(() => new Promise((resolve) => { finish = resolve }))
      await Promise.resolve()
      old.cancel()
      const current = createGitGraphRequest(async () => ({ [kind]: 'new' }))
      expect(await current.promise).toEqual({ [kind]: 'new' })
      finish({ [kind]: 'old' })
      expect(await old.promise).toBeNull()
      expect(old.current).toBe(false)
      expect(current.current).toBe(true)
    })
  }

  it('does not conceal a read failure in the active directory', async () => {
    const request = createGitGraphRequest(async () => { throw new Error('bad object') })
    await expect(request.promise).rejects.toThrow('bad object')
  })
})
