import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { STAMP_VERSION, classifyBuildChange, readBuildStamp, resolveStampPath } from './build-stamp'

function stamp({ renderer = 1, cli = 1, runtime = 1, shell = 1 } = {}) {
  return {
    version: STAMP_VERSION,
    builtAt: '2026-11-01T00:00:00.000Z',
    artifacts: {
      renderer: { path: '/out/renderer/index.html', size: renderer, mtimeMs: renderer },
      cli: { path: '/.local/lib/mica/mica', size: cli, mtimeMs: cli },
      runtime: { path: '/out/server/index.mjs', size: runtime, mtimeMs: runtime },
      shell: { path: '/out/main/index.js', size: shell, mtimeMs: shell }
    }
  }
}

describe('classifyBuildChange', () => {
  it('第一次见到 stamp 只记基线，不重载', () => {
    expect(classifyBuildChange(null, stamp())).toEqual({ level: null, changed: [] })
  })

  it('只改界面时停在 renderer 这一层：会话宿主不用动', () => {
    const result = classifyBuildChange(stamp(), stamp({ renderer: 2 }))
    expect(result.level).toBe('renderer')
    expect(result.changed).toEqual(['renderer'])
  })

  it('CLI 变了要换会话宿主（插件与工具都在那个二进制里）', () => {
    expect(classifyBuildChange(stamp(), stamp({ cli: 2 })).level).toBe('cli')
  })

  it('同时改了两层时按最重的那一层处理', () => {
    const result = classifyBuildChange(stamp(), stamp({ renderer: 2, cli: 2 }))
    expect(result.level).toBe('cli')
    expect(result.changed).toEqual(['renderer', 'cli'])
  })

  it('外壳与运行时是最重的两层', () => {
    expect(classifyBuildChange(stamp(), stamp({ runtime: 2 })).level).toBe('runtime')
    expect(classifyBuildChange(stamp(), stamp({ shell: 2 })).level).toBe('shell')
  })

  it('产物没有任何变化时不动', () => {
    expect(classifyBuildChange(stamp(), stamp()).level).toBe(null)
  })

  it('某一层没有产物（没构建出来）时不会误判成变化', () => {
    const previous = stamp()
    const next = stamp()
    delete next.artifacts.cli
    expect(classifyBuildChange(previous, next).level).toBe('cli')
    // 两边都没有时才是真的没变化
    delete previous.artifacts.cli
    expect(classifyBuildChange(previous, next).level).toBe(null)
  })

  it('没有 stamp 时什么都不做', () => {
    expect(classifyBuildChange(stamp(), null)).toEqual({ level: null, changed: [] })
  })
})

describe('readBuildStamp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mica-stamp-'))
  const file = join(dir, 'dev-build-stamp.json')

  it('读出写进去的那份', () => {
    writeFileSync(file, JSON.stringify(stamp()))
    expect(readBuildStamp(file)?.artifacts.renderer.size).toBe(1)
  })

  it('坏文件与旧版本都当作没有', () => {
    writeFileSync(file, '{not json')
    expect(readBuildStamp(file)).toBe(null)
    writeFileSync(file, JSON.stringify({ ...stamp(), version: STAMP_VERSION + 1 }))
    expect(readBuildStamp(file)).toBe(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('路径不存在时返回 null', () => {
    expect(readBuildStamp(join(dir, 'nope.json'))).toBe(null)
  })
})

describe('resolveStampPath', () => {
  it('默认落在 MICA_HOME 下（用户机器上不存在，因此不会自动重载）', () => {
    expect(resolveStampPath({ env: {}, homeDirectory: '/Users/me' })).toBe(
      '/Users/me/.mica/dev-build-stamp.json'
    )
    expect(resolveStampPath({ env: { MICA_HOME: '/tmp/home' }, homeDirectory: '/Users/me' })).toBe(
      '/tmp/home/dev-build-stamp.json'
    )
  })

  it('显式路径优先', () => {
    expect(
      resolveStampPath({ env: { MICA_DEV_BUILD_STAMP: '/tmp/x.json' }, homeDirectory: '/u' })
    ).toBe('/tmp/x.json')
  })
})
