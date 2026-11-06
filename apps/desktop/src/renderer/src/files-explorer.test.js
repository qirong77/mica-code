import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import {
  creationDirectory,
  entryNameError,
  nameSelection,
  orderEntries,
  treeNavigation,
  visibleTreeEntries
} from './files-explorer'
import { makeNode, parentDirectory } from './files-tree'

const file = (path, type = 'file', children = [], expanded = false) => ({
  ...makeNode({ path, name: path.split('/').at(-1), type }),
  children,
  expanded
})
const nested = file(
  '/work/src',
  'directory',
  [
    file('/work/src/components', 'directory', [file('/work/src/components/A.jsx')]),
    file('/work/src/index.js')
  ],
  true
)
const tree = { root: '/work', children: [nested, file('/work/README.md')] }

describe('explorer selection and keyboard navigation', () => {
  it('creates inside selected folders, beside selected files, or at the root', () => {
    expect(creationDirectory(tree, nested.path)).toBe('/work/src')
    expect(creationDirectory(tree, '/work/src/index.js')).toBe('/work/src')
    expect(creationDirectory(tree, '/stale/path')).toBe('/work')
    expect(creationDirectory(tree, null)).toBe('/work')
  })

  it('flattens only expanded branches in the displayed manual order', () => {
    const order = { '/work': ['README.md'], '/work/src': ['index.js'] }
    const entries = visibleTreeEntries(tree.children, tree.root, order)
    expect(entries.map(({ node, depth }) => [node.name, depth])).toEqual([
      ['README.md', 0],
      ['src', 0],
      ['index.js', 1],
      ['components', 1]
    ])
    expect(orderEntries(tree.children, tree.root, {})).toBe(tree.children)
  })

  it('navigates adjacent rows, parents and children without wrapping at the ends', () => {
    const entries = visibleTreeEntries(tree.children, tree.root)
    expect(treeNavigation(entries, '/work/src', 'ArrowDown', tree.root)).toEqual({
      select: '/work/src/components'
    })
    expect(treeNavigation(entries, '/work/src', 'ArrowUp', tree.root)).toEqual({
      select: '/work/src'
    })
    expect(treeNavigation(entries, '/work/src/index.js', 'ArrowLeft', tree.root)).toEqual({
      select: '/work/src'
    })
    expect(treeNavigation(entries, '/work/src', 'ArrowLeft', tree.root)).toEqual({ toggle: nested })
    expect(treeNavigation(entries, '/work/src', 'ArrowRight', tree.root)).toEqual({
      select: '/work/src/components'
    })
    expect(treeNavigation(entries, '/work/src/components', 'ArrowRight', tree.root)).toEqual({
      toggle: nested.children[0]
    })
    expect(treeNavigation(entries, '/work/README.md', 'End', tree.root)).toEqual({
      select: '/work/README.md'
    })
    expect(treeNavigation(entries, '/work/README.md', 'Home', tree.root)).toEqual({
      select: '/work/src'
    })
    expect(treeNavigation([], null, 'ArrowDown', tree.root)).toBeNull()
  })

  it('selects the filename stem on rename but leaves dotfiles and folder names intact', () => {
    expect(nameSelection('Button.test.jsx', 'file')).toEqual([0, 11])
    expect(nameSelection('.gitignore', 'file')).toEqual([0, 10])
    expect(nameSelection('src.v2', 'directory')).toEqual([0, 6])
  })

  it('accepts nested relative creation paths and rejects unsafe names locally', () => {
    for (const name of ['src/components/A.jsx', 'src\\components\\A.jsx', '.env', 'folder name'])
      expect(entryNameError(name)).toBe('')
    for (const name of [
      '',
      ' ',
      '../x',
      'x/../a',
      'x/./a',
      '/absolute',
      'C:\\file',
      'a//b',
      'bad\0name'
    ])
      expect(entryNameError(name)).not.toBe('')
    expect(entryNameError('a/b', true)).not.toBe('')
    expect(entryNameError('New.jsx', true)).toBe('')
  })
})

const source = readFileSync(new URL('./FilesView.jsx', import.meta.url), 'utf8')
const submitSource = source.slice(
  source.indexOf('  const submitEntryEdit = useCallback('),
  source.indexOf('  const newEntryInSelection = useCallback(')
)

function editing(overrides = {}) {
  const calls = []
  const edit = {
    id: {},
    action: 'new-file',
    directory: '/work',
    type: 'file',
    value: 'src/components/A.jsx',
    busy: false,
    ...overrides
  }
  const entryEditRef = { current: edit }
  const treeRef = { current: { root: '/work' } }
  const state = { selected: null }
  const context = {
    useCallback: (callback) => callback,
    entryEditRef,
    treeRef,
    openRequestRef: { current: 0 },
    entryNameError,
    fileName: (path) => path.split('/').at(-1),
    dirOf: parentDirectory,
    isSameOrChildPath: (path, parent) => path === parent || path.startsWith(`${parent}/`),
    setEntryEdit: (value) => {
      entryEditRef.current = value
    },
    setSelectedTreePath: (value) => {
      state.selected = value
    },
    cancelEntryEdit: (restoreFocus) => {
      state.restoreFocus = restoreFocus
      entryEditRef.current = null
    },
    closeTabsUnder: async (path) => {
      calls.push(['close', path])
      return true
    },
    focusTreePath: (path) => calls.push(['focus', path]),
    openFile: (path) => calls.push(['open', path]),
    readDirectory: async (path, options) => calls.push(['read', path, options.expand]),
    refreshAfterFileChange: async (directories) => calls.push(['refresh', ...directories]),
    window: {
      mica: {
        files: {
          create: async (directory, name, type) => {
            calls.push(['create', directory, name, type])
            return { path: `${directory}/${name}` }
          },
          rename: async (path, name) => {
            calls.push(['rename', path, name])
            return { path: `${parentDirectory(path)}/${name}` }
          }
        }
      }
    }
  }
  const submit = runInNewContext(`${submitSource}\nsubmitEntryEdit`, context)
  return { submit, context, calls, entryEditRef, state }
}

describe('inline file operation lifecycle', () => {
  it('creates once, reveals nested parents in order, selects the new entry and opens files', async () => {
    const flow = editing()
    await Promise.all([flow.submit(), flow.submit()])
    expect(flow.calls).toEqual([
      ['create', '/work', 'src/components/A.jsx', 'file'],
      ['refresh', '/work'],
      ['read', '/work/src', true],
      ['read', '/work/src/components', true],
      ['open', '/work/src/components/A.jsx']
    ])
    expect(flow.entryEditRef.current).toBeNull()
    expect(flow.state.selected).toBe('/work/src/components/A.jsx')
  })

  it('selects and focuses new folders without opening a text editor', async () => {
    const flow = editing({ action: 'new-directory', type: 'directory', value: 'folder' })
    await flow.submit()
    expect(flow.calls.at(-1)).toEqual(['focus', '/work/folder'])
    expect(flow.calls.some(([action]) => action === 'open')).toBe(false)
  })

  it('cancels empty blur and unchanged rename without filesystem writes', async () => {
    const empty = editing({ value: '' })
    await empty.submit(true)
    expect(empty.calls).toEqual([])
    expect(empty.entryEditRef.current).toBeNull()
    expect(empty.state.restoreFocus).toBe(false)
    const rename = editing({ action: 'rename', path: '/work/A.jsx', value: 'A.jsx' })
    await rename.submit()
    expect(rename.calls).toEqual([])
    expect(rename.state.restoreFocus).toBe(true)
  })

  it('keeps invalid names and conflicts editable without losing the typed name', async () => {
    const invalid = editing({ value: '../bad' })
    await invalid.submit()
    expect(invalid.calls).toEqual([])
    expect(invalid.entryEditRef.current.error).not.toBe('')
    const conflict = editing({ value: 'existing.js' })
    conflict.context.window.mica.files.create = async () => {
      throw new Error('名称已存在')
    }
    await conflict.submit()
    expect(conflict.entryEditRef.current).toMatchObject({
      value: 'existing.js',
      error: '名称已存在',
      busy: false
    })
  })

  it('does not rename a dirty file when its editors cannot safely close', async () => {
    const flow = editing({ action: 'rename', path: '/work/A.jsx', value: 'B.jsx' })
    flow.context.closeTabsUnder = async () => false
    await flow.submit()
    expect(flow.calls).toEqual([])
    expect(flow.entryEditRef.current.busy).toBe(false)
    expect(flow.entryEditRef.current.error).toContain('保存')
  })

  it('ignores a creation response after changing workspace roots', async () => {
    const flow = editing()
    let finish
    flow.context.window.mica.files.create = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const pending = flow.submit()
    flow.context.treeRef.current = { root: '/other' }
    flow.entryEditRef.current = null
    finish({ path: '/work/src/components/A.jsx' })
    await pending
    expect(flow.calls).toEqual([])
    expect(flow.state.selected).toBeNull()
  })

  it('commits on blur without taking focus or selection back from the clicked editor', async () => {
    const flow = editing({ value: 'A.jsx' })
    await flow.submit(true)
    expect(flow.calls).toEqual([
      ['create', '/work', 'A.jsx', 'file'],
      ['refresh', '/work']
    ])
    expect(flow.entryEditRef.current).toBeNull()
    expect(flow.state.selected).toBeNull()
  })

  it('does not open a newly created file over a later explicit file selection', async () => {
    const flow = editing({ value: 'A.jsx' })
    let finish
    flow.context.window.mica.files.create = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const pending = flow.submit()
    flow.context.openRequestRef.current += 1
    finish({ path: '/work/A.jsx' })
    await pending
    expect(flow.calls).toEqual([['refresh', '/work']])
    expect(flow.state.selected).toBeNull()
    expect(flow.entryEditRef.current).toBeNull()
  })

  it('retains blur errors without forcing focus back to the tree input', async () => {
    const flow = editing({ value: 'existing.js' })
    flow.context.window.mica.files.create = async () => {
      throw new Error('名称已存在')
    }
    await flow.submit(true)
    expect(flow.entryEditRef.current).toMatchObject({
      value: 'existing.js',
      focusError: false,
      busy: false
    })
  })
})
