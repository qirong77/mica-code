import { describe, expect, test } from 'bun:test'
import {
  buildCompareRows,
  comparePickerItems,
  comparePreferences,
  compareTreeKey,
  filterCompareFiles,
  isFileReviewed,
  reconcileCompareFocus,
  revealComparePath,
  reviewSummary,
  visibleCompareRows
} from './git-compare-model'

const file = (path, extra = {}) => ({
  path,
  fingerprint: `${path}:v1`,
  status: 'modified',
  ...extra
})

describe('comparison rows', () => {
  test('compacts only single-child folders, preserving parent relationships and full paths', () => {
    const files = [
      file('src/main/java/A.java'),
      file('src/main/java/B.java'),
      file('src/readme.md')
    ]
    const rows = buildCompareRows(files)
    expect(rows.map((row) => [row.name, row.depth, row.parentId])).toEqual([
      ['src', 0, null],
      ['main/java', 1, 'directory:src'],
      ['A.java', 2, 'directory:src/main/java'],
      ['B.java', 2, 'directory:src/main/java'],
      ['readme.md', 1, 'directory:src']
    ])
    expect(rows[1].path).toBe('src/main/java')
    expect(rows[1].files).toEqual(files.slice(0, 2))
  })

  test('can disable compaction and sorts folders before files using natural file order', () => {
    const rows = buildCompareRows([file('src/a/b.ts'), file('file10.ts'), file('file2.ts')], {
      compactFolders: false
    })
    expect(rows.map((row) => row.name)).toEqual(['src', 'a', 'b.ts', 'file2.ts', 'file10.ts'])
    expect(rows[2].ancestors).toEqual(['directory:src', 'directory:src/a'])
  })

  test('collapse hides exactly the descendants and reveal expands every rendered ancestor', () => {
    const all = buildCompareRows([file('src/a/f.ts'), file('src/g.ts'), file('other.ts')], {
      compactFolders: false
    })
    const collapsed = new Set(['directory:src', 'directory:src/a'])
    expect(visibleCompareRows(all, collapsed).map((row) => row.path)).toEqual(['src', 'other.ts'])
    const revealed = revealComparePath(all, 'src/a/f.ts', collapsed)
    expect(revealed.size).toBe(0)
    expect(collapsed.size).toBe(2)
    expect(revealComparePath(all, 'missing', collapsed)).toEqual(collapsed)
  })

  test('list view sorts full paths and keeps files at the same level', () => {
    const rows = buildCompareRows([file('z.ts'), file('a/b.ts'), file('a.ts')], {
      viewMode: 'list'
    })
    expect(rows.map((row) => row.path)).toEqual(['a.ts', 'a/b.ts', 'z.ts'])
    expect(
      rows.every((row) => row.type === 'file' && row.depth === 0 && row.parentId === null)
    ).toBe(true)
    expect(rows[1].directory).toBe('a')
  })

  test('folder summaries retain original files and aggregate stats, dirty state, and partial review', () => {
    const files = [
      file('dir/a', { additions: 3, deletions: 2, status: 'added' }),
      file('dir/b', { additions: 4, uncommitted: true })
    ]
    const folder = buildCompareRows(files, { reviewed: { 'dir/a': 'dir/a:v1' } })[0]
    expect(folder.files).toEqual(files)
    expect(folder).toMatchObject({
      additions: 7,
      deletions: 2,
      uncommitted: true,
      status: 'modified',
      total: 2,
      count: 1,
      checked: false,
      mixed: true
    })
  })
})

describe('reviewing and filtering', () => {
  test('review requires the exact current fingerprint and resets after content changes', () => {
    const original = file('a')
    const reviewed = { a: original.fingerprint }
    expect(isFileReviewed(original, reviewed)).toBe(true)
    expect(isFileReviewed({ ...original, fingerprint: 'v2' }, reviewed)).toBe(false)
    expect(isFileReviewed({ path: 'missing' }, {})).toBe(false)
    expect(isFileReviewed({ path: 'null', fingerprint: null }, { null: null })).toBe(false)
  })

  test('empty review groups are neither checked nor mixed', () => {
    expect(reviewSummary([])).toEqual({ count: 0, total: 0, checked: false, mixed: false })
  })

  test('path search intersects words and unreviewed filter without mutating file order', () => {
    const files = [file('src/Panel.test.js'), file('src/Panel.jsx'), file('docs/panel.md')]
    const reviewed = { 'src/Panel.jsx': 'src/Panel.jsx:v1' }
    expect(filterCompareFiles(files, 'PANEL src', true, reviewed)).toEqual([files[0]])
    expect(filterCompareFiles(files, '', false, reviewed)).toEqual(files)
    expect(files).toHaveLength(3)
  })

  test('preferences keep default checkboxes and hide stats while validating stored values', () => {
    expect(comparePreferences(null)).toEqual({
      viewMode: 'tree',
      iconStyle: 'status',
      compactFolders: true,
      showStats: false,
      showCheckboxes: true,
      unreviewedOnly: false
    })
    expect(
      comparePreferences({ viewMode: 'invalid', showStats: true, showCheckboxes: 'false' })
    ).toMatchObject({ viewMode: 'tree', showStats: true, showCheckboxes: true })
  })
})

describe('tree keyboard navigation', () => {
  const all = buildCompareRows([file('src/a/f.ts'), file('src/g.ts'), file('z.ts')], {
    compactFolders: false
  })

  test('moves by visible row and clamps at ends', () => {
    expect(compareTreeKey(all, all[0].id, 'ArrowUp')).toEqual({ focusId: all[0].id })
    expect(compareTreeKey(all, all[0].id, 'ArrowDown')).toEqual({ focusId: all[1].id })
    expect(compareTreeKey(all, all[1].id, 'Home')).toEqual({ focusId: all[0].id })
    expect(compareTreeKey(all, all[1].id, 'End')).toEqual({ focusId: all.at(-1).id })
    expect(compareTreeKey(all, all.at(-1).id, 'ArrowDown')).toEqual({ focusId: all.at(-1).id })
  })

  test('focus moves to the next sibling when review filtering removes a file', () => {
    const previous = buildCompareRows([file('src/a.ts'), file('src/b.ts'), file('src/c.ts')])
    const remaining = previous.filter((row) => row.path !== 'src/b.ts')
    expect(reconcileCompareFocus(remaining, 'file:src/b.ts', previous)).toBe('file:src/c.ts')
    expect(reconcileCompareFocus(remaining, 'file:src/a.ts', previous)).toBe('file:src/a.ts')
  })

  test('focus returns to a collapsed parent instead of moving outside the folder', () => {
    const collapsed = visibleCompareRows(all, new Set(['directory:src']))
    expect(reconcileCompareFocus(collapsed, 'file:src/a/f.ts', all)).toBe('directory:src')
    expect(reconcileCompareFocus([], 'file:src/a/f.ts', all)).toBeUndefined()
  })

  test('right expands a closed directory or enters its first child', () => {
    const collapsed = new Set(['directory:src'])
    expect(
      compareTreeKey(visibleCompareRows(all, collapsed), 'directory:src', 'ArrowRight', collapsed)
    ).toEqual({ toggleId: 'directory:src' })
    expect(compareTreeKey(all, 'directory:src', 'ArrowRight')).toEqual({
      focusId: 'directory:src/a'
    })
  })

  test('left collapses expanded directories and otherwise moves to the rendered parent', () => {
    expect(compareTreeKey(all, 'directory:src/a', 'ArrowLeft')).toEqual({
      toggleId: 'directory:src/a'
    })
    expect(compareTreeKey(all, 'file:src/a/f.ts', 'ArrowLeft')).toEqual({
      focusId: 'directory:src/a'
    })
    const collapsed = new Set(['directory:src/a'])
    expect(
      compareTreeKey(visibleCompareRows(all, collapsed), 'directory:src/a', 'ArrowLeft', collapsed)
    ).toEqual({ focusId: 'directory:src' })
  })

  test('Enter and Space distinguish opening a diff, toggling folders, and reviewing groups', () => {
    expect(compareTreeKey(all, 'file:src/g.ts', 'Enter')).toEqual({ activateId: 'file:src/g.ts' })
    expect(compareTreeKey(all, 'directory:src', 'Enter')).toEqual({ toggleId: 'directory:src' })
    expect(compareTreeKey(all, 'directory:src', ' ')).toEqual({ reviewId: 'directory:src' })
    expect(compareTreeKey([], 'missing', 'ArrowDown')).toEqual({ focusId: undefined })
  })
})

describe('base picker choices', () => {
  test('keeps automatic and HEAD choices and distinguishes local, remote, and tag groups', () => {
    const items = comparePickerItems(
      {
        branches: [
          { ref: 'refs/heads/feature', name: 'feature', current: true },
          { ref: 'refs/heads/main', name: 'main' },
          { ref: 'refs/remotes/origin/main', name: 'origin/main', kind: 'remote' }
        ],
        tags: [{ ref: 'refs/tags/v1', name: 'v1' }]
      },
      { kind: 'branch', ref: 'refs/remotes/origin/main', direct: true }
    )
    expect(items.map((item) => item.group)).toEqual([
      '比较方式',
      '比较方式',
      '本地分支',
      '远程分支',
      '标签'
    ])
    expect(items.find((item) => item.current)?.name).toBe('origin/main')
    expect(items[3].kind).toBe('branch')
  })

  test('searches names, refs, and subjects, skips duplicate refs', () => {
    const refs = {
      branches: [
        { ref: 'refs/heads/main', name: 'main', subject: 'Release work' },
        { ref: 'refs/heads/main', name: 'duplicate' }
      ]
    }
    expect(comparePickerItems(refs, null, 'release').map((item) => item.name)).toEqual(['main'])
    expect(comparePickerItems(refs, null, 'refs/heads').map((item) => item.name)).toEqual(['main'])
    expect(comparePickerItems(null, null)[0].current).toBe(true)
  })
})
