import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { readTopLevelCwd } from './session-file-head'

describe('readTopLevelCwd', () => {
  let dir
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mica-session-head-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  async function write(name, content) {
    const file = path.join(dir, name)
    await writeFile(file, content)
    return file
  }

  it('读顶层 cwd，与整份解析结果一致', async () => {
    const session = {
      version: 1,
      id: 's1',
      title: '标题',
      cwd: '/Users/someone/project',
      snapshot: { messages: [], cwd: '/Users/someone/project' }
    }
    const file = await write('a.json', JSON.stringify(session, null, 2))
    expect(readTopLevelCwd(file)).toBe('/Users/someone/project')
  })

  it('snapshot 里嵌套的 cwd 不会被误当成顶层值', async () => {
    const session = {
      version: 1,
      id: 's2',
      snapshot: { cwd: '/nested/only' }
    }
    const file = await write('b.json', JSON.stringify(session, null, 2))
    expect(readTopLevelCwd(file)).toBeNull()
  })

  it('路径里的转义字符能还原', async () => {
    const session = { version: 1, cwd: '/tmp/带"引号"的目录', snapshot: {} }
    const file = await write('c.json', JSON.stringify(session, null, 2))
    expect(readTopLevelCwd(file)).toBe('/tmp/带"引号"的目录')
  })

  it('cwd 为 null 或空串时返回 null，交给整份解析兜底', async () => {
    for (const cwd of [null, '', '   ']) {
      const file = await write(`d-${String(cwd)}.json`, JSON.stringify({ cwd, snapshot: {} }))
      expect(readTopLevelCwd(file)).toBeNull()
    }
  })

  it('头部超出预算时返回 null，不猜', async () => {
    const padding = 'x'.repeat(9000)
    const session = { blob: padding, version: 1, cwd: '/late/in/file', snapshot: {} }
    const file = await write('e.json', JSON.stringify(session, null, 2))
    expect(readTopLevelCwd(file)).toBeNull()
    // 放宽预算就能读到，说明返回 null 只是「不在头部」
    expect(readTopLevelCwd(file, 12000)).toBe('/late/in/file')
  })

  it('文件不存在或不是 JSON 时返回 null', async () => {
    expect(readTopLevelCwd(path.join(dir, 'missing.json'))).toBeNull()
    const file = await write('f.json', 'not json at all')
    expect(readTopLevelCwd(file)).toBeNull()
  })

  it('大文件只读头部（尾部内容不影响结果）', async () => {
    const session = {
      version: 1,
      id: 'big',
      cwd: '/Users/someone/big',
      snapshot: { messages: [{ text: 'y'.repeat(200000) }] }
    }
    const file = await write('g.json', JSON.stringify(session))
    expect(readTopLevelCwd(file)).toBe('/Users/someone/big')
  })
})
