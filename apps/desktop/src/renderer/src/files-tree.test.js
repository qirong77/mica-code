import { describe, expect, it } from 'bun:test'
import {
  collapseNodes,
  createTreeRequests,
  findTreeNode,
  makeNode,
  mergeDirectoryListing,
  mergeEntries,
  parentDirectory,
  refreshDirectoryPaths,
  updateTree
} from './files-tree'

const entry = (path, type = 'file', ignored = false) => ({
  path,
  name: path.split('/').at(-1),
  type,
  ignored
})
const folder = (path, children = [], state = {}) => ({
  ...makeNode(entry(path, 'directory')),
  children,
  expanded: true,
  loaded: true,
  ...state
})
const rootTree = (children) => ({
  root: '/workspace',
  parent: '/',
  children,
  status: '',
  refreshing: false
})
const listing = (path, entries) => ({ path, parentPath: parentDirectory(path), entries })

describe('file tree merging', () => {
  it('reuses unchanged entries, their arrays, and loaded subtrees', () => {
    const children = [makeNode(entry('/workspace/src/a.js'))]
    const src = folder('/workspace/src', children)
    const nodes = [src, makeNode(entry('/workspace/readme.md'))]
    const next = mergeEntries(
      nodes,
      nodes.map((node) => ({ ...node }))
    )
    expect(next).toBe(nodes)
    expect(next[0]).toBe(src)
    expect(next[0].children).toBe(children)
    expect(next[0].expanded).toBe(true)
  })

  it('adds, deletes, and reorders immediate entries without rebuilding unaffected nodes', () => {
    const src = folder('/workspace/src', [makeNode(entry('/workspace/src/a.js'))])
    const old = makeNode(entry('/workspace/old.js'))
    const readme = makeNode(entry('/workspace/readme.md'))
    const next = mergeEntries(
      [src, old, readme],
      [entry(readme.path), entry('/workspace/new.js'), entry(src.path, 'directory')]
    )
    expect(next.map((node) => node.path)).toEqual([readme.path, '/workspace/new.js', src.path])
    expect(next[0]).toBe(readme)
    expect(next[2]).toBe(src)
    expect(next[1]).toMatchObject({ expanded: false, loaded: false, children: [] })
  })

  it('updates ignored metadata while keeping directory state, and resets changed entry types', () => {
    const src = folder('/workspace/src', [makeNode(entry('/workspace/src/a.js'))])
    const ignored = mergeEntries([src], [entry(src.path, 'directory', true)])[0]
    expect(ignored).not.toBe(src)
    expect(ignored.ignored).toBe(true)
    expect(ignored.children).toBe(src.children)
    expect(ignored.expanded).toBe(true)
    expect(mergeEntries([src], [entry(src.path)])[0]).toMatchObject({
      type: 'file',
      expanded: false,
      loaded: false,
      children: []
    })
  })

  it('copies only ancestors of the updated branch and keeps missing updates as no-ops', () => {
    const nested = folder('/workspace/src/nested')
    const src = folder('/workspace/src', [nested])
    const other = folder('/workspace/other', [makeNode(entry('/workspace/other/a.js'))])
    const nodes = [src, other]
    const next = updateTree(nodes, nested.path, (node) => ({ ...node, expanded: false }))
    expect(next[0]).not.toBe(src)
    expect(next[0].children[0].expanded).toBe(false)
    expect(next[1]).toBe(other)
    expect(updateTree(nodes, '/workspace/missing', (node) => ({ ...node }))).toBe(nodes)
    expect(updateTree(nodes, nested.path, (node) => node)).toBe(nodes)
  })

  it('merges a delayed read into the latest expansion and child state', async () => {
    const nested = folder('/workspace/src/nested', [], { expanded: false })
    let tree = rootTree([folder('/workspace/src', [nested], { loading: true })])
    let complete
    const response = new Promise((resolve) => {
      complete = resolve
    })
    const pending = response.then((result) => {
      tree = mergeDirectoryListing(tree, '/workspace', '/workspace/src', result)
    })
    // The user collapses this folder and opens an already cached nested folder during the read.
    tree = {
      ...tree,
      children: updateTree(tree.children, '/workspace/src', (node) => ({
        ...node,
        expanded: false,
        children: updateTree(node.children, nested.path, (child) => ({ ...child, expanded: true }))
      }))
    }
    const latestNested = findTreeNode(tree.children, nested.path)
    complete(
      listing('/workspace/src', [entry(nested.path, 'directory'), entry('/workspace/src/new.js')])
    )
    await pending
    expect(tree.children[0]).toMatchObject({ expanded: false, loaded: true, loading: false })
    expect(tree.children[0].children[0]).toBe(latestNested)
    expect(tree.children[0].children[0].expanded).toBe(true)
  })

  it('preserves directory results when the parent listing finishes later', () => {
    const src = folder('/workspace/src', [], { loading: true })
    const childResult = listing(src.path, [entry('/workspace/src/new.js')])
    const parentResult = listing('/workspace', [entry(src.path, 'directory')])
    const childFirst = mergeDirectoryListing(rootTree([src]), '/workspace', src.path, childResult)
    const parentLast = mergeDirectoryListing(childFirst, '/workspace', '/workspace', parentResult)
    expect(parentLast.children[0]).toBe(childFirst.children[0])
    const parentFirst = mergeDirectoryListing(
      rootTree([src]),
      '/workspace',
      '/workspace',
      parentResult
    )
    expect(parentFirst.children[0].loading).toBe(true)
    const childLast = mergeDirectoryListing(parentFirst, '/workspace', src.path, childResult)
    expect(childLast.children[0]).toMatchObject({ loading: false, loaded: true })
    expect(childLast.children[0].children).toEqual(parentLast.children[0].children)
  })

  it('does not resurrect removed directories, files, or a previous root', () => {
    const result = listing('/workspace/src', [entry('/workspace/src/late.js')])
    const removed = rootTree([])
    expect(mergeDirectoryListing(removed, '/workspace', '/workspace/src', result)).toBe(removed)
    const replaced = rootTree([makeNode(entry('/workspace/src'))])
    expect(mergeDirectoryListing(replaced, '/workspace', '/workspace/src', result)).toBe(replaced)
    const changedRoot = { ...rootTree([]), root: '/other' }
    expect(mergeDirectoryListing(changedRoot, '/workspace', '/workspace/src', result)).toBe(
      changedRoot
    )
  })

  it('includes collapsed caches and pending initial loads in a manual refresh', () => {
    const nodes = [
      folder('/workspace/cached', [], { expanded: false }),
      folder('/workspace/pending', [], { loaded: false, loading: true }),
      folder('/workspace/unopened', [], { expanded: false, loaded: false }),
      makeNode(entry('/workspace/a.js'))
    ]
    expect(refreshDirectoryPaths(nodes)).toEqual(['/workspace/cached', '/workspace/pending'])
  })

  it('keeps parent paths compatible with filesystem and drive roots', () => {
    expect(parentDirectory('/a.js')).toBe('/')
    expect(parentDirectory('/workspace/src/a.js')).toBe('/workspace/src')
    expect(parentDirectory('C:\\a.js')).toBe('C:\\')
    expect(parentDirectory('C:\\workspace\\src\\a.js')).toBe('C:\\workspace\\src')
    expect(parentDirectory('C:/a.js')).toBe('C:/')
  })
})

describe('file tree request ordering', () => {
  it('supersedes reads per directory without cancelling another initial load', () => {
    const requests = createTreeRequests()
    const initial = requests.start('/workspace/src')
    const other = requests.start('/workspace/other')
    const refreshed = requests.start('/workspace/src')
    expect(requests.isCurrent('/workspace/src', initial)).toBe(false)
    expect(requests.isCurrent('/workspace/other', other)).toBe(true)
    requests.finish('/workspace/src', initial)
    expect(requests.isCurrent('/workspace/src', refreshed)).toBe(true)
    requests.finish('/workspace/src', refreshed)
    expect(requests.isCurrent('/workspace/src', refreshed)).toBe(false)
  })

  it('rejects old root requests even when navigating back to the same path', () => {
    const requests = createTreeRequests()
    const old = requests.start('/workspace')
    requests.reset()
    const next = requests.start('/workspace')
    expect(requests.isCurrent('/workspace', old)).toBe(false)
    expect(requests.isCurrent('/workspace', next)).toBe(true)
  })

  it('cancels pending folder loads on Collapse All while allowing the root listing to finish', () => {
    const requests = createTreeRequests()
    const rootRequest = requests.start('/workspace')
    const directoryRequest = requests.start('/workspace/src')
    const src = folder('/workspace/src', [], { loaded: false, loading: true })
    requests.collapse('/workspace')
    const collapsed = collapseNodes([src])
    expect(requests.isCurrent('/workspace/src', directoryRequest)).toBe(false)
    expect(requests.isCurrent('/workspace', rootRequest)).toBe(true)
    const tree = mergeDirectoryListing(
      rootTree(collapsed),
      '/workspace',
      '/workspace',
      listing('/workspace', [entry(src.path, 'directory')])
    )
    expect(tree.children[0]).toMatchObject({ expanded: false, loaded: false, loading: false })
    expect(collapseNodes(tree.children)).toBe(tree.children)
    expect(requests.isCurrent('/workspace/src', requests.start('/workspace/src'))).toBe(true)
  })

  it('invalidates a removed subtree before a directory with the same path can reappear', () => {
    const requests = createTreeRequests()
    const pending = requests.start('/workspace/src/nested')
    requests.prune(rootTree([]))
    const reappeared = rootTree([folder('/workspace/src', [folder('/workspace/src/nested')])])
    requests.prune(reappeared)
    expect(requests.isCurrent('/workspace/src/nested', pending)).toBe(false)
    const next = requests.start('/workspace/src/nested')
    requests.prune(reappeared)
    expect(requests.isCurrent('/workspace/src/nested', next)).toBe(true)
  })
})
