import { describe, expect, test } from 'bun:test'
import { buildGitDecorations, relativeToRoot, statusColor, statusLabel } from './git-decorations.js'

describe('relativeToRoot', () => {
  test('strips the repository root from an absolute path', () => {
    expect(relativeToRoot('/repo', '/repo/src/app.js')).toBe('src/app.js')
  })

  test('rejects paths outside the repository', () => {
    expect(relativeToRoot('/repo', '/other/src/app.js')).toBeNull()
    expect(relativeToRoot('/repo', '/repo')).toBeNull()
    expect(relativeToRoot(null, '/repo/src/app.js')).toBeNull()
  })
})

describe('buildGitDecorations', () => {
  test('maps changed files and their ancestor folders', () => {
    const { files, folders } = buildGitDecorations({
      files: [
        { path: 'src/app.js', status: 'modified' },
        { path: 'git-hooks/post-commit', status: 'added' }
      ]
    })
    expect(files.get('src/app.js')).toBe('modified')
    expect(folders.get('src')).toBe('modified')
    expect(folders.get('git-hooks')).toBe('added')
    expect(folders.has('app.js')).toBe(false)
  })

  test('a folder keeps the most significant status of its subtree', () => {
    const { folders } = buildGitDecorations({
      files: [
        { path: 'src/new.js', status: 'added' },
        { path: 'src/old.js', status: 'deleted' },
        { path: 'src/edit.js', status: 'modified' }
      ]
    })
    expect(folders.get('src')).toBe('modified')
  })

  test('unknown or missing statuses fall back to modified and empty input is safe', () => {
    const { files } = buildGitDecorations({ files: [{ path: 'a.js', status: 'conflict' }] })
    expect(files.get('a.js')).toBe('modified')
    expect(buildGitDecorations(null).files.size).toBe(0)
    expect(buildGitDecorations({}).folders.size).toBe(0)
  })
})

describe('status presentation', () => {
  test('letters and colors cover the three supported statuses', () => {
    expect([statusLabel('added'), statusLabel('deleted'), statusLabel('modified')]).toEqual([
      'A',
      'D',
      'M'
    ])
    expect(statusLabel('unknown')).toBe('M')
    expect(statusColor('added')).not.toBe(statusColor('modified'))
    expect(statusColor('unknown')).toBe(statusColor('modified'))
  })
})
