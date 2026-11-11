import '@arco-design/web-react/es/_util/react-19-adapter'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArcoProvider, SelectMenu } from '@mica-config-ui/web'
import NotebookPage from '../../../../plugins/notebook/desktop.jsx'
import {
  parseNotebookDocument,
  validateNodeId,
  validateNotebookIndex
} from '../../../../plugins/notebook/model'
import { THEMES } from '../../../../packages/mica-web-shared/theme'
import { applyResolvedTheme } from '../../src/renderer/src/theme'
import { previewNotes, primaryNoteId } from '../notebook-design/fixture'
import '../../src/renderer/assets/app.css'
import './probe.css'

const clone = (value) => structuredClone(value)
const themeOptions = THEMES.map(({ id, label }) => ({ value: id, label }))
const requestedTheme = new URLSearchParams(location.search).get('theme')
const initialTheme = THEMES.some(({ id }) => id === requestedTheme) ? requestedTheme : 'light'
applyResolvedTheme(initialTheme)

function fixtureIndex() {
  const folders = new Map()
  const nodes = []
  for (const note of previewNotes) {
    if (!folders.has(note.folder)) {
      const id = `fixture-folder-${folders.size + 1}`
      folders.set(note.folder, id)
      nodes.push({
        id, kind: 'folder', parentId: null, title: note.folder,
        createdAt: note.updatedAt, updatedAt: note.updatedAt
      })
    }
    nodes.push({
      id: note.id, kind: 'note', parentId: folders.get(note.folder), title: note.title,
      createdAt: note.updatedAt, updatedAt: note.updatedAt
    })
  }
  return validateNotebookIndex({ version: 1, nodes })
}

/** A browser-only implementation of NotebookHost; no desktop API or persistent storage. */
function createMemoryHost() {
  const records = new Map([
    ['index', { value: fixtureIndex(), version: crypto.randomUUID() }],
    ...previewNotes.map((note) => [
      `document:${note.id}`,
      { value: parseNotebookDocument(note.document), version: crypto.randomUUID() }
    ])
  ])
  const beforeClose = new Set()
  const writes = []
  const closeAttempts = []
  let failWrites = false
  let lastDocumentId = primaryNoteId
  let closing = null
  let indexSaveCount = 0
  let documentSaveCount = 0

  function readRecord(key) {
    const record = records.get(key)
    return { ok: true, value: clone(record?.value ?? null), version: record?.version ?? null }
  }

  function writeRecord(scope, id, value, options) {
    const key = scope === 'index' ? 'index' : `document:${id}`
    const previousVersion = records.get(key)?.version ?? null
    const attempt = {
      sequence: writes.length + 1, scope, id, expectedVersion: options?.expectedVersion,
      previousVersion, value: clone(value), result: 'pending'
    }
    writes.push(attempt)
    const reject = (error, conflict = false) => {
      attempt.result = conflict ? 'conflict' : 'error'
      attempt.error = error
      return { ok: false, ...(conflict ? { conflict: true } : {}), error }
    }
    if (!options || !Object.hasOwn(options, 'expectedVersion') ||
      !(options.expectedVersion === null || (typeof options.expectedVersion === 'string' && options.expectedVersion.length))) {
      return reject('内存宿主要求显式传入 expectedVersion（字符串或 null）')
    }
    if (options.expectedVersion !== previousVersion) return reject('内存资源版本已变更', true)
    if (failWrites) return reject('探针模拟写入失败；当前草稿仍由 Notebook 页面保留')
    try {
      if (scope === 'document') validateNodeId(id)
      const snapshot = scope === 'index' ? validateNotebookIndex(value) : parseNotebookDocument(value)
      const version = crypto.randomUUID()
      // No await between comparing and replacing: concurrent calls obey CAS as one operation.
      records.set(key, { value: snapshot, version })
      attempt.result = 'saved'
      attempt.version = version
      if (scope === 'index') indexSaveCount += 1
      else documentSaveCount += 1
      return { ok: true, version }
    } catch (error) {
      return reject(error instanceof Error ? error.message : String(error))
    }
  }

  const api = {
    readData: async () => readRecord('index'),
    writeData: async (value, options) => writeRecord('index', null, value, options),
    documents: {
      async read(id) {
        validateNodeId(id)
        lastDocumentId = id
        return readRecord(`document:${id}`)
      },
      write: async (id, value, options) => writeRecord('document', id, value, options)
    },
    page: {
      beforeClose(handler) {
        if (typeof handler !== 'function') throw new TypeError('beforeClose handler must be a function')
        beforeClose.add(handler)
        return () => beforeClose.delete(handler)
      }
    }
  }

  const documents = () => Object.fromEntries(
    [...records].filter(([key]) => key.startsWith('document:'))
      .map(([key, record]) => [key.slice('document:'.length), clone(record.value)])
  )
  const debug = {
    snapshot(id = lastDocumentId) {
      return readRecord(`document:${validateNodeId(id)}`).value
    },
    read: async (id = lastDocumentId) => readRecord(`document:${validateNodeId(id)}`),
    readIndex: api.readData,
    get documents() { return documents() },
    get writes() { return clone(writes) },
    get saveCount() { return indexSaveCount + documentSaveCount },
    get state() {
      return {
        index: readRecord('index').value,
        indexVersion: records.get('index').version,
        documents: documents(),
        documentVersions: Object.fromEntries(
          [...records].filter(([key]) => key.startsWith('document:'))
            .map(([key, record]) => [key.slice('document:'.length), record.version])
        ),
        lastDocumentId, failWrites, saveCount: indexSaveCount + documentSaveCount,
        indexSaveCount, documentSaveCount, writes: clone(writes),
        beforeCloseHandlers: beforeClose.size, closeAttempts: clone(closeAttempts)
      }
    },
    get failWrites() { return failWrites },
    set failWrites(value) {
      if (typeof value !== 'boolean') throw new TypeError('failWrites must be boolean')
      failWrites = value
    },
    close() {
      if (closing) return closing
      const attempt = { sequence: closeAttempts.length + 1, allowed: null }
      closeAttempts.push(attempt)
      closing = (async () => {
        try {
          for (const handler of beforeClose) {
            if ((await handler()) === false) { attempt.allowed = false; return false }
          }
          attempt.allowed = true
          return true
        } catch (error) {
          attempt.allowed = false
          attempt.error = error instanceof Error ? error.message : String(error)
          return false
        }
      })().finally(() => { closing = null })
      return closing
    }
  }
  return { api, debug }
}

const host = createMemoryHost()
window.__notebookWorkbench = host.debug

function NotebookWorkbenchProbe() {
  const [theme, setTheme] = useState(initialTheme)
  useEffect(() => {
    applyResolvedTheme(theme)
    const url = new URL(location.href)
    url.searchParams.set('theme', theme)
    history.replaceState({}, '', url)
  }, [theme])

  return (
    <ArcoProvider>
      <div className="notebook-workbench-probe-shell">
        <header className="notebook-workbench-probe-toolbar" aria-label="探针辅助工具">
          <span className="notebook-workbench-probe-title">Notebook · 正式页面</span>
          <span className="notebook-workbench-probe-hint">隔离样例 · 仅内存保存</span>
          <label htmlFor="notebook-workbench-theme">主题</label>
          <SelectMenu
            id="notebook-workbench-theme"
            ariaLabel="探针主题"
            size="compact"
            value={theme}
            options={themeOptions}
            onChange={setTheme}
          />
        </header>
        <div className="notebook-workbench-probe-content">
          <div className="mica-config-ui is-embed is-fill min-h-0 flex-1 overflow-hidden">
            <NotebookPage api={host.api} />
          </div>
        </div>
      </div>
    </ArcoProvider>
  )
}

createRoot(document.getElementById('root')).render(<NotebookWorkbenchProbe />)
