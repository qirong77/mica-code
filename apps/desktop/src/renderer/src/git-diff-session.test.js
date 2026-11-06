import { describe, expect, test } from 'bun:test'
import { createGitDiffSession, gitDiffKey } from './git-diff-session'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function harness(read, options = {}) {
  const updates = []
  const models = []
  const requests = []
  const attachments = []
  const listeners = new Set()
  let attached = null
  const editor = {
    view: { line: 1 },
    getModel: () => attached,
    setModel(value) {
      attached = value
      attachments.push(value)
      this.view = { line: 1 }
    },
    saveViewState() {
      return this.view
    },
    restoreViewState(value) {
      this.view = value
    },
    revealFirstDiff() {
      this.view = { line: 7 }
    },
    onDidUpdateDiff(listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    layout() {},
    finishDiff() {
      for (const listener of [...listeners]) listener()
    }
  }
  const session = createGitDiffSession({
    editor,
    onChange: (state) => updates.push(state),
    readFile: (...args) => {
      requests.push(args)
      return read(...args)
    },
    createModel(value, _path, metadata) {
      // Monaco excludes BOM and normalizes line endings; it is not a source-byte snapshot.
      const normalized = value.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n')
      const model = {
        metadata,
        getValue: () => normalized,
        disposed: 0,
        dispose() {
          expect(attached?.original).not.toBe(model)
          expect(attached?.modified).not.toBe(model)
          this.disposed += 1
        }
      }
      models.push(model)
      return model
    },
    ...options
  })
  return { editor, session, updates, models, requests, attachments, listeners }
}

const file = (path, fingerprint = 'v1') => ({
  path,
  fingerprint,
  base: { mode: 'snapshot', ref: 'commit' }
})
const text = (modified = 'after', original = 'before') => ({ original, modified })

describe('Git diff session', () => {
  test('keys separate repositories, files, refs and index/worktree while ignoring object identity', () => {
    const first = { path: 'a.js', base: { mode: 'snapshot', ref: 'abc', label: 'main' } }
    const copied = { ...first, base: { label: 'main', ref: 'abc', mode: 'snapshot' } }
    expect(gitDiffKey('/repo', first)).toBe(gitDiffKey('/repo', copied))
    expect(gitDiffKey('/other', first)).not.toBe(gitDiffKey('/repo', first))
    expect(gitDiffKey('/repo', first)).not.toBe(gitDiffKey('/repo', { ...first, path: 'b' }))
    expect(gitDiffKey('/repo', first)).not.toBe(
      gitDiffKey('/repo', { ...first, base: { ...first.base, ref: 'def' } })
    )
    expect(gitDiffKey('/repo', { path: 'a', base: 'staged' })).not.toBe(
      gitDiffKey('/repo', { path: 'a', base: 'worktree' })
    )
  })

  test('refs comparisons with different heads have separate keys', () => {
    const first = { path: 'a.js', base: { mode: 'refs', ref: 'base', head: 'first' } }
    const second = { ...first, base: { ...first.base, head: 'second' } }
    expect(gitDiffKey('/repo', first)).not.toBe(gitDiffKey('/repo', second))
    expect(gitDiffKey('/repo', first)).toBe(
      gitDiffKey('/repo', { ...first, base: { ...first.base } })
    )
  })

  test('unchanged snapshot polls reuse models without another read or model reset', async () => {
    const h = harness(() => text())
    await h.session.select('/repo', file('a'))
    h.editor.finishDiff()
    h.editor.view = { line: 80 }
    const count = h.attachments.length
    await h.session.select('/repo', { ...file('a'), preview: false })
    expect(h.requests).toHaveLength(1)
    expect(h.models).toHaveLength(2)
    expect(h.attachments).toHaveLength(count)
    expect(h.editor.view.line).toBe(80)
    h.session.dispose()
  })

  test('keeps the previous content attached until the next file arrives; cached return is immediate', async () => {
    const next = deferred()
    const h = harness((_cwd, path) => (path === 'a' ? text('a') : next.promise))
    await h.session.select('/repo', file('a'))
    h.editor.finishDiff()
    h.editor.view = { line: 83 }
    const first = h.editor.getModel()
    const switching = h.session.select('/repo', file('b'))
    expect(h.editor.getModel()).toBe(first)
    expect(h.updates.at(-1)).toMatchObject({ phase: 'loading', hasModel: true })
    next.resolve(text('b'))
    await switching
    h.editor.finishDiff()
    expect(h.editor.getModel().modified.getValue()).toBe('b')
    expect(first.original.disposed).toBe(0)
    const returning = h.session.select('/repo', file('a'))
    expect(h.editor.getModel()).toBe(first)
    expect(h.editor.view.line).toBe(83)
    await returning
    h.editor.finishDiff()
    expect(h.editor.view.line).toBe(83)
    expect(h.requests).toHaveLength(2)
    h.session.dispose()
  })

  test('slow stale reads and errors cannot replace a newer file, including A → B → A', async () => {
    const a = deferred()
    const b = deferred()
    const h = harness((_cwd, path) => (path === 'a' ? a.promise : b.promise))
    const first = h.session.select('/repo', file('a'))
    const second = h.session.select('/repo', file('b'))
    const third = h.session.select('/repo', file('a'))
    a.resolve(text('selected a'))
    await Promise.all([first, third])
    expect(h.requests).toHaveLength(2)
    b.reject(new Error('stale failure'))
    await second
    expect(h.editor.getModel().modified.getValue()).toBe('selected a')
    expect(h.updates.at(-1).phase).toBe('ready')
    expect(h.models).toHaveLength(2)
    h.session.dispose()
  })

  test('source-control polling revalidates bytes without resetting unchanged models or position', async () => {
    let modified = 'one line'
    const h = harness(() => text(modified))
    const source = { path: 'a', base: { mode: 'worktree' } }
    await h.session.select('/repo', source)
    h.editor.finishDiff()
    h.editor.view = { line: 90 }
    const previous = h.editor.getModel()
    const count = h.attachments.length
    await h.session.select('/repo', { ...source })
    expect(h.updates.at(-1).phase).toBe('ready')
    expect(h.attachments).toHaveLength(count)
    expect(h.models).toHaveLength(2)
    modified = 'new text'
    await h.session.select('/repo', { ...source })
    h.editor.finishDiff()
    expect(h.editor.getModel().modified.getValue()).toBe('new text')
    expect(h.editor.view.line).toBe(90)
    expect(previous.original.disposed).toBe(1)
    expect(previous.modified.disposed).toBe(1)
    expect(h.requests).toHaveLength(3)
    h.session.dispose()
  })

  test('changed fingerprints reload but byte-identical refreshes retain the attached models', async () => {
    const h = harness(() => text())
    await h.session.select('/repo', file('a'))
    const previous = h.editor.getModel()
    await h.session.select('/repo', file('a', 'v2'))
    expect(h.requests).toHaveLength(2)
    expect(h.editor.getModel()).toBe(previous)
    await h.session.select('/repo', file('a', 'v2'))
    expect(h.requests).toHaveLength(2)
    await h.session.select('/repo', file('a', 'v2'), { force: true })
    expect(h.requests).toHaveLength(3)
    expect(h.editor.getModel()).toBe(previous)
    h.session.dispose()
  })

  test.each(['original', 'modified'])(
    'byte-identical refreshes rebuild models when %s blame ref changes',
    async (side) => {
      let blame = {
        original: { kind: 'commit', ref: 'base' },
        modified: { kind: 'commit', ref: 'head' }
      }
      const h = harness(() => ({ ...text(), blame }))
      await h.session.select('/repo', file('a'))
      const previous = h.editor.getModel()
      blame = { ...blame, [side]: { ...blame[side], ref: 'new-commit' } }
      await h.session.select('/repo', file('a'), { force: true })
      const current = h.editor.getModel()
      expect(current).not.toBe(previous)
      expect(h.models).toHaveLength(4)
      expect(previous.original.disposed).toBe(1)
      expect(previous.modified.disposed).toBe(1)
      for (const modelSide of ['original', 'modified']) {
        expect(current[modelSide].metadata).toEqual({
          cwd: '/repo',
          side: modelSide,
          blame: blame[modelSide]
        })
      }
      h.session.dispose()
    }
  )

  test('byte-identical refreshes reuse models with unchanged blame metadata', async () => {
    const h = harness(() => ({
      ...text(),
      blame: {
        original: { kind: 'commit', ref: 'base' },
        modified: { kind: 'commit', ref: 'head' }
      }
    }))
    await h.session.select('/repo', file('a'))
    const previous = h.editor.getModel()
    const count = h.attachments.length
    await h.session.select('/repo', file('a'), { force: true })
    expect(h.requests).toHaveLength(2)
    expect(h.editor.getModel()).toBe(previous)
    expect(h.models).toHaveLength(2)
    expect(h.attachments).toHaveLength(count)
    expect(previous.original.disposed).toBe(0)
    expect(previous.modified.disposed).toBe(0)
    h.session.dispose()
  })

  test.each(['\uFEFFa\nb\n', 'a\r\nb\nc\n'])(
    'unchanged polling preserves models when Monaco normalizes %j',
    async (source) => {
      const h = harness(() => text(source, source))
      const selected = { path: 'a', base: 'worktree' }
      await h.session.select('/repo', selected)
      const previous = h.editor.getModel()
      expect(previous.modified.getValue()).not.toBe(source)
      const attachments = h.attachments.length
      await h.session.select('/repo', { ...selected })
      await h.session.select('/repo', { ...selected }, { force: true })
      expect(h.editor.getModel()).toBe(previous)
      expect(h.attachments).toHaveLength(attachments)
      expect(h.models).toHaveLength(2)
      expect(previous.original.disposed).toBe(0)
      expect(previous.modified.disposed).toBe(0)
      h.session.dispose()
    }
  )

  test('binary, failed and retried reads preserve useful state and never reuse another comparison', async () => {
    let response = { binary: true }
    const h = harness(() => {
      if (response instanceof Error) throw response
      return response
    })
    await h.session.select('/repo', file('a'))
    expect(h.updates.at(-1).phase).toBe('binary')
    expect(h.models).toHaveLength(0)
    response = new Error('read failed')
    await h.session.select('/repo', file('a'), { force: true })
    expect(h.updates.at(-1)).toMatchObject({ phase: 'error', error: 'read failed' })
    response = text('added', '')
    await h.session.select('/repo', file('a'), { force: true })
    expect(h.updates.at(-1).phase).toBe('ready')
    expect(h.editor.getModel().original.getValue()).toBe('')
    await h.session.select('/repo', null)
    expect(h.updates.at(-1).phase).toBe('empty')
    response = text('', 'deleted')
    await h.session.select('/other', file('a'))
    expect(h.editor.getModel().modified.getValue()).toBe('')
    expect(h.requests.at(-1)[0]).toBe('/other')
    h.session.dispose()
  })

  test('evicts old models within bounds but retains their scroll position', async () => {
    const h = harness((_cwd, path) => text(path), { maxEntries: 1 })
    await h.session.select('/repo', file('a'))
    h.editor.finishDiff()
    h.editor.view = { line: 120 }
    const previous = h.editor.getModel()
    await h.session.select('/repo', file('b'))
    h.editor.finishDiff()
    expect(previous.original.disposed).toBe(1)
    expect(previous.modified.disposed).toBe(1)
    await h.session.select('/repo', file('a'))
    h.editor.finishDiff()
    expect(h.editor.view.line).toBe(120)
    expect(h.requests).toHaveLength(3)
    h.session.dispose()
    expect(h.models.every((model) => model.disposed === 1)).toBe(true)
    expect(h.listeners.size).toBe(0)
  })

  test('character budget evicts cached pairs and teardown invalidates outstanding requests', async () => {
    const slow = deferred()
    const h = harness((_cwd, path) => (path === 'slow' ? slow.promise : text(path)), {
      maxCharacters: 13
    })
    await h.session.select('/repo', file('a'))
    await h.session.select('/repo', file('b'))
    expect(h.models[0].disposed).toBe(1)
    const pending = h.session.select('/repo', file('slow'))
    const count = h.updates.length
    h.session.dispose()
    h.session.dispose()
    slow.resolve(text('too late'))
    await pending
    expect(h.updates).toHaveLength(count)
    expect(h.models).toHaveLength(4)
    expect(h.models.every((model) => model.disposed === 1)).toBe(true)
  })
})
