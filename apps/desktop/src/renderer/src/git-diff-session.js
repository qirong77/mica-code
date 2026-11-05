/** Model identity follows the comparison, never the object returned by a Git poll. */
export function gitDiffKey(cwd, file) {
  if (!cwd || !file?.path) return null
  const base = file.base
  const options = base && typeof base === 'object' ? base : { mode: base || 'head' }
  return JSON.stringify([
    cwd,
    file.path,
    options.mode || 'head',
    options.ref || null,
    options.head || null,
    !!options.direct,
    options.label || null
  ])
}

/**
 * Keep a small set of comparisons ready to revisit. Reads may finish out of order; only the
 * latest selection can attach models. Monaco must detach before a model is disposed.
 */
export function createGitDiffSession({
  editor,
  readFile,
  createModel,
  onChange,
  maxEntries = 8,
  maxCharacters = 4 * 1024 * 1024
}) {
  const entries = new Map()
  const pending = new Map()
  const views = new Map()
  let generation = 0
  let disposed = false
  let attached = null
  let initialDiff = null

  const disposeModels = (entry) => {
    entry?.models?.original.dispose()
    entry?.models?.modified.dispose()
  }
  const saveView = () => {
    if (!attached || !editor.getModel()) return
    const view = editor.saveViewState()
    if (!view) return
    views.delete(attached.key)
    views.set(attached.key, view)
    if (views.size > 100) views.delete(views.keys().next().value)
  }
  const cancelInitialDiff = () => {
    initialDiff?.dispose()
    initialDiff = null
  }
  const detach = () => {
    cancelInitialDiff()
    editor.setModel(null)
    attached = null
  }
  const touch = (entry) => {
    entries.delete(entry.key)
    entries.set(entry.key, entry)
  }
  const prune = () => {
    let characters = [...entries.values()].reduce((sum, entry) => sum + entry.characters, 0)
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries && characters <= maxCharacters) break
      if (entry === attached) continue
      entries.delete(key)
      characters -= entry.characters
      disposeModels(entry)
    }
  }
  const attach = (entry) => {
    if (attached === entry) return
    saveView()
    detach()
    if (!entry.models) return
    attached = entry
    const view = views.get(entry.key)
    initialDiff = editor.onDidUpdateDiff(() => {
      cancelInitialDiff()
      if (editor.getModel() !== entry.models) return
      if (view) editor.restoreViewState(view)
      else editor.revealFirstDiff()
    })
    editor.setModel(entry.models)
    if (view) editor.restoreViewState(view)
    editor.layout()
  }
  const publish = (key, entry, loading = false) => {
    onChange({
      key,
      phase: entry?.phase || 'loading',
      refreshing: loading,
      hasModel: !!editor.getModel(),
      originalLabel: entry?.originalLabel,
      modifiedLabel: entry?.modifiedLabel
    })
  }
  const fetchContent = (key, cwd, file, force) => {
    const previous = pending.get(key)
    if (!force && previous && previous.fingerprint === file.fingerprint) return previous.promise
    const promise = Promise.resolve().then(() => readFile(cwd, file.path, file.base ?? null))
    const request = { fingerprint: file.fingerprint, promise }
    pending.set(key, request)
    // Use both handlers so rejected reads do not leave an unhandled finally() promise behind.
    const clear = () => {
      if (pending.get(key) === request) pending.delete(key)
    }
    promise.then(clear, clear)
    return promise
  }

  return {
    async select(cwd, file, { force = false } = {}) {
      if (disposed) return
      const request = ++generation
      const key = gitDiffKey(cwd, file)
      if (!key) {
        saveView()
        onChange({ key: null, phase: 'empty', hasModel: !!editor.getModel() })
        return
      }
      let entry = entries.get(key)
      // Fingerprinted snapshots can be reused without I/O. Source-control summaries have no
      // content fingerprint: revalidate them quietly, including edits with unchanged line counts.
      const valid = entry && file.fingerprint && file.fingerprint === entry.fingerprint
      if (entry) {
        touch(entry)
        attach(entry)
      }
      if (valid && !force) {
        publish(key, entry)
        return
      }
      publish(key, entry, true)
      try {
        const content = await fetchContent(key, cwd, file, force)
        if (disposed || request !== generation) return
        if (!content || content.error) throw new Error(content?.error || '未收到文件内容')
        const binary = !!(content.binary || file.binary)
        const original = content.original ?? ''
        const modified = content.modified ?? ''
        const blameIdentity = JSON.stringify(content.blame || null)
        const unchanged =
          entry &&
          entry.blameIdentity === blameIdentity &&
          binary === (entry.phase === 'binary') &&
          (binary || (entry.original === original && entry.modified === modified))
        if (unchanged) {
          Object.assign(entry, {
            fingerprint: file.fingerprint,
            originalLabel: content.originalLabel,
            modifiedLabel: content.modifiedLabel
          })
        } else {
          let models = null
          if (!binary) {
            // 两侧各自带上「这一侧是哪份内容」的说明，行悬停的 blame 才知道该读
            // 提交、索引还是工作区（见 host/git-compare.js 的 `blame`）。
            const info = { cwd, blame: content.blame || null }
            const originalModel = createModel(original, file.path, {
              ...info,
              side: 'original',
              blame: content.blame?.original || null
            })
            try {
              models = {
                original: originalModel,
                modified: createModel(modified, file.path, {
                  ...info,
                  side: 'modified',
                  blame: content.blame?.modified || null
                })
              }
            } catch (error) {
              originalModel.dispose()
              throw error
            }
          }
          const previous = entry
          entry = {
            key,
            models,
            original: binary ? null : original,
            modified: binary ? null : modified,
            characters: binary ? 0 : original.length + modified.length,
            fingerprint: file.fingerprint,
            phase: binary ? 'binary' : 'ready',
            blameIdentity,
            originalLabel: content.originalLabel,
            modifiedLabel: content.modifiedLabel
          }
          // Keep the old comparison attached until its replacement is completely available.
          attach(entry)
          disposeModels(previous)
        }
        touch(entry)
        prune()
        publish(key, entry)
      } catch (error) {
        if (disposed || request !== generation) return
        onChange({
          key,
          phase: 'error',
          hasModel: !!editor.getModel(),
          error: error instanceof Error ? error.message : String(error)
        })
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      detach()
      for (const entry of entries.values()) disposeModels(entry)
      entries.clear()
      pending.clear()
      views.clear()
    }
  }
}
