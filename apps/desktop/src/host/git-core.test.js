import { describe, expect, it } from 'bun:test'
import {
  baseBranchLabel,
  compareChangePaths,
  isBaseBranch,
  parseNameStatus,
  parseNumstat,
  parseStatus,
  parseStatusCode,
  shortRefName,
  statusFromCode,
  sumLineChanges
} from './git-core'

describe('statusFromCode', () => {
  it('把 porcelain 与 name-status 的状态码归到三态', () => {
    expect(statusFromCode('??')).toBe('added')
    expect(statusFromCode('A ')).toBe('added')
    expect(statusFromCode('AM')).toBe('added')
    expect(statusFromCode(' M')).toBe('modified')
    expect(statusFromCode('MM')).toBe('modified')
    expect(statusFromCode('T ')).toBe('modified')
    expect(statusFromCode('D ')).toBe('deleted')
    expect(statusFromCode('MD')).toBe('deleted')
  })
})

describe('parseStatus', () => {
  it('解析 `git status --porcelain=v1 -z`（记录是 `XY <path>`）', () => {
    const output = ' M src/a.ts\0?? src/b.ts\0A  src/c.ts\0'
    expect(parseStatus(output)).toEqual(
      new Map([
        ['src/a.ts', 'modified'],
        ['src/b.ts', 'added'],
        ['src/c.ts', 'added']
      ])
    )
  })

  it('重命名记录丢掉多出来的旧路径（porcelain -z 先给新路径）', () => {
    expect(parseStatus('R  src/new.ts\0src/old.ts\0')).toEqual(
      new Map([['src/new.ts', 'modified']])
    )
  })
})

describe('parseStatusCode', () => {
  it('保留原始 XY（源代码管理面板要按索引/工作区分段）', () => {
    const output = ' M src/a.ts\0?? src/b.ts\0A  src/c.ts\0MM src/d.ts\0'
    expect(parseStatusCode(output)).toEqual(
      new Map([
        ['src/a.ts', ' M'],
        ['src/b.ts', '??'],
        ['src/c.ts', 'A '],
        ['src/d.ts', 'MM']
      ])
    )
  })

  it('空输出得到空表', () => {
    expect(parseStatusCode('').size).toBe(0)
  })
})

describe('parseNameStatus', () => {
  it('解析 `git diff --name-status -z`（记录是 `<code>\\0<path>\\0`）', () => {
    const output = 'M\0src/a.ts\0A\0src/b.ts\0D\0src/c.ts\0'
    expect(parseNameStatus(output)).toEqual(
      new Map([
        ['src/a.ts', 'modified'],
        ['src/b.ts', 'added'],
        ['src/c.ts', 'deleted']
      ])
    )
  })

  it('取重命名后的新路径（diff 先给旧路径）', () => {
    expect(parseNameStatus('R100\0src/old.ts\0src/new.ts\0')).toEqual(
      new Map([['src/new.ts', 'modified']])
    )
  })

  it('空输出得到空表', () => {
    expect(parseNameStatus('').size).toBe(0)
  })
})

describe('parseNumstat', () => {
  it('解析增删行数与二进制标记', () => {
    expect(parseNumstat('9\t5\tsrc/a.ts\n-\t-\tlogo.png\n')).toEqual(
      new Map([
        ['src/a.ts', { additions: 9, deletions: 5, binary: false }],
        ['logo.png', { additions: 0, deletions: 0, binary: true }]
      ])
    )
  })
})

describe('base branch', () => {
  it('显示名去掉远端前缀', () => {
    expect(baseBranchLabel('origin/master')).toBe('master')
    expect(baseBranchLabel('master')).toBe('master')
    expect(baseBranchLabel('')).toBe('')
  })

  it('完整 ref 名取短名（for-each-ref 给的是 refs/heads/...）', () => {
    expect(shortRefName('refs/heads/main')).toBe('main')
    expect(shortRefName('refs/remotes/origin/main')).toBe('origin/main')
    expect(shortRefName('refs/tags/v1.2.0')).toBe('v1.2.0')
    expect(shortRefName('origin/master')).toBe('origin/master')
    expect(shortRefName('HEAD')).toBe('HEAD')
    expect(shortRefName('')).toBe('')
  })

  it('当前分支就是基线时判为「没有可比的基线」', () => {
    expect(isBaseBranch('origin/master', 'master')).toBe(true)
    expect(isBaseBranch('master', 'master')).toBe(true)
    expect(isBaseBranch('origin/main', 'feat/x')).toBe(false)
    expect(isBaseBranch(null, 'master')).toBe(false)
    expect(isBaseBranch('origin/master', null)).toBe(false)
  })
})

describe('compareChangePaths', () => {
  it('数字感知、忽略大小写', () => {
    const paths = ['src/a10.ts', 'src/a2.ts', 'src/B.ts']
    expect([...paths].sort(compareChangePaths)).toEqual(['src/a2.ts', 'src/a10.ts', 'src/B.ts'])
  })
})

describe('sumLineChanges', () => {
  it('把一批变更文件的行数加起来（缺字段按 0）', () => {
    expect(
      sumLineChanges([
        { additions: 3, deletions: 1 },
        { additions: 0, deletions: 40 },
        { binary: true }
      ])
    ).toEqual({ additions: 3, deletions: 41 })
  })

  it('空列表是 0/0', () => {
    expect(sumLineChanges([])).toEqual({ additions: 0, deletions: 0 })
    expect(sumLineChanges(undefined)).toEqual({ additions: 0, deletions: 0 })
  })
})
