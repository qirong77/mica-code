import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile
} from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { createFileEntry, renameFileEntry } from './file-entry-operations.js'

let root
let directory

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mica-file-entry-'))
  directory = path.join(root, 'workspace')
  await mkdir(directory)
})

afterEach(() => rm(root, { recursive: true, force: true }))

describe('createFileEntry', () => {
  it.each([
    'src/components/Button.jsx',
    'src\\components\\Button.jsx',
    'src\\components/Button.jsx'
  ])('creates nested files using %s', async (name) => {
    const target = path.join(directory, 'src', 'components', 'Button.jsx')
    expect(await createFileEntry(directory, name, 'file')).toBe(target)
    expect(await readFile(target, 'utf8')).toBe('')
  })

  it.each(['a/b', 'a\\b'])('creates nested directories using %s', async (name) => {
    const target = path.join(directory, 'a', 'b')
    expect(await createFileEntry(directory, name, 'directory')).toBe(target)
    expect((await lstat(target)).isDirectory()).toBe(true)
  })

  it('reuses existing intermediate directories without changing their contents', async () => {
    await mkdir(path.join(directory, 'src'))
    const existing = path.join(directory, 'src', 'existing.txt')
    await writeFile(existing, 'keep')
    await createFileEntry(directory, 'src/components/Button.jsx', 'file')
    expect(await readFile(existing, 'utf8')).toBe('keep')
  })

  it.each(['file', 'directory'])('never replaces a file with a %s', async (type) => {
    const target = path.join(directory, 'existing')
    await writeFile(target, 'keep')
    await expect(createFileEntry(directory, 'existing', type)).rejects.toMatchObject({
      code: 'EEXIST',
      message: expect.stringContaining('同名')
    })
    expect(await readFile(target, 'utf8')).toBe('keep')
  })

  it.each(['file', 'directory'])('never replaces an existing directory with a %s', async (type) => {
    const target = path.join(directory, 'existing')
    await mkdir(target)
    await expect(createFileEntry(directory, 'existing', type)).rejects.toMatchObject({
      code: 'EEXIST'
    })
    expect((await lstat(target)).isDirectory()).toBe(true)
  })

  it.each(['file', 'directory'])('never follows a dangling leaf symlink for a %s', async (type) => {
    const outside = path.join(root, 'missing')
    const link = path.join(directory, 'link')
    await symlink(outside, link)
    await expect(createFileEntry(directory, 'link', type)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readlink(link)).toBe(outside)
    await expect(lstat(outside)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    null,
    undefined,
    1,
    '',
    '   ',
    '/absolute',
    '\\absolute',
    '//server/share',
    '\\\\server\\share',
    'C:/absolute',
    'C:\\absolute',
    'c:relative',
    '.',
    '..',
    './a',
    '../a',
    'a/./b',
    'a/../b',
    'a\\..\\b',
    'a//b',
    'a\\\\b',
    'a/ /b',
    'a/',
    'a\\',
    'a\0b',
    'a\nb'
  ])('rejects invalid paths without creating intermediate directories: %j', async (name) => {
    await expect(createFileEntry(directory, name, 'file')).rejects.toThrow()
    expect(await readdir(directory)).toEqual([])
  })

  it('rejects unsupported types before creating intermediate directories', async () => {
    await expect(createFileEntry(directory, 'a/b', 'symlink')).rejects.toThrow('类型')
    expect(await readdir(directory)).toEqual([])
  })

  it.each(['file', 'directory'])(
    'rejects escape through intermediate symlinks for a %s',
    async (type) => {
      const outside = path.join(root, 'outside')
      await mkdir(outside)
      await mkdir(path.join(directory, 'safe'))
      await symlink(outside, path.join(directory, 'safe', 'link'), 'dir')
      await expect(createFileEntry(directory, 'safe/link/escaped', type)).rejects.toMatchObject({
        code: 'ELOOP',
        message: expect.stringContaining('符号链接')
      })
      expect(await readdir(outside)).toEqual([])
    }
  )

  it('rejects intermediate symlinks even if they point inside the selected parent', async () => {
    await mkdir(path.join(directory, 'actual'))
    await symlink('actual', path.join(directory, 'link'), 'dir')
    await expect(createFileEntry(directory, 'link/new.txt', 'file')).rejects.toMatchObject({
      code: 'ELOOP'
    })
    expect(await readdir(path.join(directory, 'actual'))).toEqual([])
  })

  it('rejects dangling intermediate symlinks without creating their target', async () => {
    const outside = path.join(root, 'missing')
    await symlink(outside, path.join(directory, 'link'), 'dir')
    await expect(createFileEntry(directory, 'link/new.txt', 'file')).rejects.toMatchObject({
      code: 'ELOOP'
    })
    await expect(lstat(outside)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows the selected parent itself to be a symlink', async () => {
    const parent = path.join(root, 'selected-link')
    await symlink(directory, parent, 'dir')
    expect(await createFileEntry(parent, 'a/b.txt', 'file')).toBe(path.join(parent, 'a', 'b.txt'))
    expect(await readFile(path.join(directory, 'a', 'b.txt'), 'utf8')).toBe('')
  })

  it('reports a non-directory intermediate without changing it', async () => {
    await writeFile(path.join(directory, 'blocked'), 'keep')
    await expect(createFileEntry(directory, 'blocked/new.txt', 'file')).rejects.toMatchObject({
      code: 'ENOTDIR',
      message: expect.stringContaining('不是文件夹')
    })
    expect(await readFile(path.join(directory, 'blocked'), 'utf8')).toBe('keep')
  })

  it('does not create a missing selected parent', async () => {
    await expect(
      createFileEntry(path.join(directory, 'missing'), 'a/b', 'file')
    ).rejects.toMatchObject({
      code: 'ENOENT',
      message: expect.stringContaining('不存在')
    })
    expect(await readdir(directory)).toEqual([])
  })

  it('keeps intermediate directories after a leaf creation failure', async () => {
    await expect(
      createFileEntry(directory, `new/${'x'.repeat(1024)}`, 'file')
    ).rejects.toMatchObject({
      code: 'ENAMETOOLONG'
    })
    expect((await lstat(path.join(directory, 'new'))).isDirectory()).toBe(true)
  })

  it('only lets one concurrent nested creation claim the file leaf', async () => {
    const results = await Promise.allSettled([
      createFileEntry(directory, 'a/b.txt', 'file'),
      createFileEntry(directory, 'a/b.txt', 'file')
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected').reason.code).toBe('EEXIST')
  })
})

describe('renameFileEntry', () => {
  it('renames a file without changing its contents', async () => {
    const source = path.join(directory, 'old.txt')
    const target = path.join(directory, 'new.txt')
    await writeFile(source, 'keep')
    expect(await renameFileEntry(source, 'new.txt')).toBe(target)
    expect(await readFile(target, 'utf8')).toBe('keep')
    await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('renames directories and their contents', async () => {
    const source = path.join(directory, 'old')
    await mkdir(source)
    await writeFile(path.join(source, 'keep.txt'), 'keep')
    const target = await renameFileEntry(source, 'new')
    expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it.each(['file', 'directory', 'symlink'])(
    'treats an unchanged %s basename as a no-op',
    async (type) => {
      const source = path.join(directory, 'unchanged')
      if (type === 'file') await writeFile(source, 'keep')
      else if (type === 'directory') await mkdir(source)
      else await symlink('missing', source)
      const before = await lstat(source)
      expect(await renameFileEntry(source, 'unchanged')).toBe(source)
      expect((await lstat(source)).ino).toBe(before.ino)
    }
  )

  it.each(['file', 'directory', 'symlink'])('rejects an existing %s target', async (type) => {
    const source = path.join(directory, 'source')
    const target = path.join(directory, 'target')
    await writeFile(source, 'source content')
    if (type === 'file') await writeFile(target, 'target content')
    else if (type === 'directory') await mkdir(target)
    else await symlink('missing', target)
    await expect(renameFileEntry(source, 'target')).rejects.toMatchObject({
      code: 'EEXIST',
      message: expect.stringContaining('同名')
    })
    expect(await readFile(source, 'utf8')).toBe('source content')
    if (type === 'file') expect(await readFile(target, 'utf8')).toBe('target content')
    else if (type === 'directory') expect((await lstat(target)).isDirectory()).toBe(true)
    else expect(await readlink(target)).toBe('missing')
  })

  it('rejects replacing an existing empty directory with a directory', async () => {
    const source = path.join(directory, 'source')
    const target = path.join(directory, 'target')
    await mkdir(source)
    await mkdir(target)
    await expect(renameFileEntry(source, 'target')).rejects.toMatchObject({ code: 'EEXIST' })
    expect((await lstat(source)).isDirectory()).toBe(true)
    expect((await lstat(target)).isDirectory()).toBe(true)
  })

  it('can rename a dangling source symlink', async () => {
    const source = path.join(directory, 'old-link')
    await symlink('missing', source)
    const target = await renameFileEntry(source, 'new-link')
    expect(await readlink(target)).toBe('missing')
  })

  it.each(['', '.', '..', '../target', 'a/b', 'a\\b', '/absolute', 'C:target', 'a\0b'])(
    'rejects invalid basenames: %j',
    async (name) => {
      const source = path.join(directory, 'source')
      await writeFile(source, 'keep')
      await expect(renameFileEntry(source, name)).rejects.toThrow()
      expect(await readFile(source, 'utf8')).toBe('keep')
      expect(await readdir(directory)).toEqual(['source'])
    }
  )

  it('reports a missing source in Chinese', async () => {
    await expect(renameFileEntry(path.join(directory, 'missing'), 'new')).rejects.toMatchObject({
      code: 'ENOENT',
      message: expect.stringContaining('不存在')
    })
  })
})
