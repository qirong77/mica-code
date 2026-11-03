import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { gitTrackedFiles, IGNORED_DIRECTORIES, listSearchFiles, walkFiles } from './search-files'

const created = []

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mica-search-files-'))
  created.push(dir)
  return dir
}

function writeFile(root, relative, content = 'x') {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function initRepo(root) {
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
}

async function collect(root) {
  const files = []
  for await (const file of listSearchFiles(root)) files.push(file.relativePath)
  return files.sort()
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('listSearchFiles', () => {
  it('Git 仓库里按 .gitignore 排除产物，保留未跟踪但未忽略的新文件', async () => {
    const root = tempDir()
    initRepo(root)
    mkdirSync(path.join(root, 'dist'), { recursive: true })
    mkdirSync(path.join(root, 'logs'), { recursive: true })
    writeFile(root, '.gitignore', 'dist/\nlogs/\n')
    writeFile(root, 'src/a.js', 'const a = 1')
    writeFile(root, 'dist/bundle.js', 'const bundled = 1')
    writeFile(root, 'logs/run.log', 'noise')
    writeFile(root, 'src/new-file.js', 'const fresh = 1')

    const files = await collect(root)
    // .gitignore 自己也是被跟踪的文件，搜索理应能看到它
    expect(files).toContain('.gitignore')
    expect(files).toContain('src/a.js')
    expect(files).toContain('src/new-file.js')
    expect(files).not.toContain('dist/bundle.js')
    expect(files).not.toContain('logs/run.log')
  })

  it('子目录作为根时路径相对该目录', async () => {
    const root = tempDir()
    initRepo(root)
    writeFile(root, 'packages/app/index.ts', 'export {}')
    writeFile(root, 'README.md', '# repo')

    const files = await collect(path.join(root, 'packages/app'))
    expect(files).toEqual(['index.ts'])
  })

  it('非 Git 目录退回目录遍历，跳过黑名单里的目录与隐藏目录', async () => {
    const root = tempDir()
    writeFile(root, 'a.js')
    writeFile(root, 'node_modules/pkg/index.js')
    writeFile(root, 'dist/out.js')
    writeFile(root, '.cache/tmp.js')

    const files = await collect(root)
    expect(files).toEqual(['a.js'])
  })
})

describe('walkFiles', () => {
  it('maxFiles 截断且不越过 maxEntries', async () => {
    const root = tempDir()
    for (let index = 0; index < 10; index += 1) writeFile(root, `f${index}.txt`)
    const files = []
    for await (const file of walkFiles(root, { maxFiles: 3 })) files.push(file.relativePath)
    expect(files).toHaveLength(3)
  })

  it('黑名单覆盖常见产物目录', () => {
    for (const name of ['node_modules', 'dist', 'out', 'build', 'target', 'coverage', '.git']) {
      expect(IGNORED_DIRECTORIES.has(name)).toBe(true)
    }
  })
})

describe('gitTrackedFiles', () => {
  it('空目录返回 null（交给目录遍历回退）', async () => {
    const root = tempDir()
    expect(await gitTrackedFiles(root)).toBeNull()
  })

  it('连续调用命中的是同一份清单（4s 内不再起 git 进程）', async () => {
    const root = tempDir()
    initRepo(root)
    writeFile(root, 'a.js')
    const first = await gitTrackedFiles(root)
    writeFile(root, 'b.js')
    const second = await gitTrackedFiles(root)
    expect(second).toBe(first)
  })
})
