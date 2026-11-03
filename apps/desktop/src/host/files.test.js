import { beforeAll, describe, expect, it, mock } from 'bun:test'

// Bun module mocks affect the entire test process. Keep these IPC dependency
// mocks in a separate process so they cannot change other host test files.
if (process.env.MICA_FILES_TEST_CHILD === '1') {
  const handlers = new Map()
  const searches = []

  mock.module('electron', () => ({
    app: {}, clipboard: {}, shell: {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }
  }))
  mock.module('@packages/mica-file-mentions/index.js', () => ({ findFileMentions: mock() }))
  mock.module('./git-ignore', () => ({ ignoredEntries: mock() }))
  mock.module('./git-ops', () => ({ noteWorktreeChange: mock(), repositoryRootOf: mock() }))
  mock.module('./search-files', () => ({ listSearchFiles: mock(() => []) }))
  mock.module('./search-core', () => ({
    asciiNeedle: mock(() => null),
    collectSearchMatches: mock(({ signal }) => new Promise((resolve) => searches.push({ signal, resolve }))),
    compileQuery: mock(() => ({ ok: true })),
    parseGlobList: mock(() => []),
    passesFileFilters: mock(() => true)
  }))

  beforeAll(async () => {
    const { registerFilesIpc } = await import('./files')
    registerFilesIpc()
  })

  describe('search cancellation', () => {
    it('isolates concurrent requests in the same root and ignores stale cancellation', async () => {
      const search = handlers.get('files:search')
      const cancel = handlers.get('files:search-cancel')
      const root = '/workspace'
      const first = search(null, { root, query: 'first', requestId: 'panel-1' })
      const second = search(null, { root, query: 'second', requestId: 'other-1' })
      expect(searches[0].signal.aborted).toBe(false)
      expect(searches[1].signal.aborted).toBe(false)
      expect(cancel(null, { root, requestId: 'panel-1' })).toBe(true)
      expect(searches[0].signal.aborted).toBe(true)
      expect(searches[1].signal.aborted).toBe(false)
      const replacement = search(null, { root, query: 'third', requestId: 'panel-2' })
      expect(cancel(null, { root, requestId: 'panel-1' })).toBe(false)
      expect(cancel(null, { root: '/other', requestId: 'panel-2' })).toBe(false)
      expect(cancel(null, { root })).toBe(false)
      expect(searches[2].signal.aborted).toBe(false)
      searches[0].resolve({ items: [], truncated: false, cancelled: true })
      await first
      expect(cancel(null, { root, requestId: 'panel-2' })).toBe(true)
      expect(searches[2].signal.aborted).toBe(true)
      searches[1].resolve({ items: [], truncated: false, cancelled: false })
      searches[2].resolve({ items: [], truncated: false, cancelled: true })
      expect((await second).cancelled).toBe(false)
      await replacement
    })
  })
} else {
  it('runs search cancellation tests without leaking module mocks', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, MICA_FILES_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 })
  }, 30_000)
}
