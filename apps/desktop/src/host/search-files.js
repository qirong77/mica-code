// 搜索用的文件清单：一次列全，供 host 侧并发读取。
//
// 不能只用「目录名黑名单」决定扫哪些文件。dist / logs / temp / .backups 这类目录
// 该不该跳过由仓库自己的 .gitignore 说了算，靠名字猜只会两头错：既漏掉该搜的、又扫进
// 一堆构建产物。Git 仓库里 `git ls-files` 一次就能给出「被跟踪 + 未被忽略的新文件」
// （实测 3000 文件的仓库约 60ms），比逐层 readdir 走几万条记录快得多，结果也和用户在
// 编辑器里看到的文件树一致。非 Git 目录退回目录遍历，仍按目录名跳过常见产物目录。
import { execFile } from 'node:child_process'
import { opendir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 目录遍历回退时跳过的目录名（Git 仓库不走这份名单，交给 .gitignore）。 */
export const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'bower_components',
  'dist',
  'out',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.gradle',
  '.DS_Store'
])

const MAX_WALK_ENTRIES = 100000
const MAX_WALK_FILES = 50000
const GIT_LIST_TIMEOUT_MS = 10000
const GIT_LIST_TIMEOUT_BUFFER = 64 * 1024 * 1024
// 清单只缓存几秒：连续输入时不必每次起一个 git 进程，而新建的文件也就延迟这么久可见。
const GIT_LIST_TTL_MS = 4000
const GIT_LIST_CACHE_LIMIT = 8

const gitListCache = new Map()

function cacheKey(root) {
  return path.resolve(root)
}

/**
 * Git 跟踪的文件（含未跟踪但未被忽略的新文件），路径相对 `root`。
 * 不在仓库里、git 不可用或超时都返回 null，由调用方退回目录遍历。
 */
export async function gitTrackedFiles(root) {
  const key = cacheKey(root)
  const cached = gitListCache.get(key)
  if (cached && Date.now() - cached.at < GIT_LIST_TTL_MS) return cached.files

  let stdout
  try {
    ;({ stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      {
        cwd: key,
        encoding: 'utf8',
        timeout: GIT_LIST_TIMEOUT_MS,
        maxBuffer: GIT_LIST_TIMEOUT_BUFFER,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
      }
    ))
  } catch {
    gitListCache.delete(key)
    return null
  }

  const files = stdout
    .split('\0')
    // 子模块这类目录项以 `/` 结尾，不是可读文件
    .filter((entry) => entry && !entry.endsWith('/'))
    .filter((entry) => !entry.startsWith('../') && !path.isAbsolute(entry))
  if (!files.length) return null

  gitListCache.set(key, { at: Date.now(), files })
  if (gitListCache.size > GIT_LIST_CACHE_LIMIT) {
    gitListCache.delete(gitListCache.keys().next().value)
  }
  return files
}

/** 目录遍历回退：广度优先，按目录名跳过产物目录。 */
export async function* walkFiles(root, options = {}) {
  const maxEntries = options.maxEntries ?? MAX_WALK_ENTRIES
  const maxFiles = options.maxFiles ?? MAX_WALK_FILES
  const ignored = options.ignored ?? IGNORED_DIRECTORIES
  const queue = [{ dir: root, relative: '' }]
  let entries = 0
  let files = 0
  while (queue.length) {
    const { dir, relative } = queue.shift()
    let handle
    try {
      handle = await opendir(dir)
    } catch {
      continue
    }
    for await (const entry of handle) {
      entries += 1
      if (entries > maxEntries) return
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name) && !entry.name.startsWith('.')) {
          queue.push({ dir: path.join(dir, entry.name), relative: relativePath })
        }
        continue
      }
      if (!entry.isFile()) continue
      files += 1
      yield { path: path.join(dir, entry.name), relativePath }
      if (files >= maxFiles) return
    }
  }
}

/** 搜索的文件清单：Git 仓库优先问 git，其余退回目录遍历。 */
export async function* listSearchFiles(root) {
  const tracked = await gitTrackedFiles(root)
  if (tracked) {
    for (const relativePath of tracked) {
      yield { path: path.join(root, relativePath), relativePath }
    }
    return
  }
  yield* walkFiles(root)
}
