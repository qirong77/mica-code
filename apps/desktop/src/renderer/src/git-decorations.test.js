import { describe, expect, test } from 'bun:test'
import {
  buildGitDecorations,
  codeColor,
  codeLabel,
  relativeToRoot,
  stagedCode,
  statusColor,
  statusLabel,
  worktreeCode
} from './git-decorations.js'

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

describe('porcelain 状态码分段', () => {
  test('X 是索引侧、Y 是工作区侧', () => {
    expect([stagedCode('M '), worktreeCode('M ')]).toEqual(['M', null])
    expect([stagedCode(' M'), worktreeCode(' M')]).toEqual([null, 'M'])
    expect([stagedCode('MM'), worktreeCode('MM')]).toEqual(['M', 'M'])
    expect([stagedCode('A '), worktreeCode('A ')]).toEqual(['A', null])
    expect([stagedCode(' D'), worktreeCode(' D')]).toEqual([null, 'D'])
  })

  test('未跟踪只算工作区侧，字母是 U', () => {
    expect([stagedCode('??'), worktreeCode('??')]).toEqual([null, '?'])
    expect(codeLabel('?')).toBe('U')
  })

  test('缺字段/空码不会崩，也不进任何一段', () => {
    expect([stagedCode(undefined), worktreeCode(undefined)]).toEqual([null, null])
    expect([stagedCode(''), worktreeCode('')]).toEqual([null, null])
    expect([stagedCode('  '), worktreeCode('  ')]).toEqual([null, null])
  })

  test('字母与颜色按状态字符取', () => {
    expect(['M', 'A', 'D', 'R', '?'].map(codeLabel)).toEqual(['M', 'A', 'D', 'R', 'U'])
    expect(codeColor('?')).toBe(statusColor('added'))
    expect(codeColor('D')).toBe(statusColor('deleted'))
    expect(codeColor('M')).toBe(statusColor('modified'))
  })
})
