import { spawn } from 'child_process'
import { realpathSync } from 'fs'
import path from 'path'

/**
 * 目录列表的 .gitignore 标记。文件树要把被忽略的条目渲染成灰色，而「某个路径是否被
 * 忽略」只有 git 说了算（.gitignore / .git/info/exclude / core.excludesFile 以及层层
 * 目录的规则），所以这里问 `git check-ignore`，不在运行时自己实现规则匹配。
 *
 * 每个目录一次 `rev-parse` + 一次 `check-ignore`：前者按目录缓存（同一目录连续展开子目录
 * 时省掉一次进程启动），后者不缓存，.gitignore 改动能立刻反映到界面上。
 */
const ROOT_CACHE_TTL_MS = 2_000
const ROOT_CACHE_LIMIT = 500
const MAX_IGNORE_OUTPUT = 8 * 1024 * 1024

/** directory -> { root, at }，root 为 null 表示不在 Git 仓库里 */
const rootCache = new Map()

/** `git check-ignore -z` 的输出是 NUL 分隔的路径列表 */
export function parseIgnoredPaths(output) {
  const ignored = new Set()
  for (const value of String(output || '').split('\0')) if (value) ignored.add(value)
  return ignored
}

/**
 * git 报出的是物理路径（macOS 上 /tmp、/var 都是符号链接），渲染层给的是用户看到的路径。
 * 两侧都取真实路径，否则仓库内的条目会被误判成「在仓库之外」而全部漏标。
 */
function realPath(value) {
  try {
    return realpathSync(value)
  } catch {
    return value
  }
}

function repositoryRoot(directory) {
  const cached = rootCache.get(directory)
  const now = Date.now()
  if (cached && now - cached.at < ROOT_CACHE_TTL_MS) return Promise.resolve(cached.root)

  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', '--show-toplevel'], { cwd: directory })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    const finish = (root) => {
      if (rootCache.size >= ROOT_CACHE_LIMIT) rootCache.clear()
      rootCache.set(directory, { root, at: Date.now() })
      resolve(root)
    }
    // 不在仓库里（git 以非零码退出）或没装 git（error）都按「没有忽略信息」处理。
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? stdout.trim() || null : null))
  })
}

function runCheckIgnore(root, relativePaths) {
  return new Promise((resolve) => {
    const child = spawn('git', ['check-ignore', '--stdin', '-z'], { cwd: root })
    let stdout = ''
    let size = 0
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_IGNORE_OUTPUT) {
        child.kill()
        return
      }
      stdout += chunk
    })
    // 无匹配时 git 以 1 退出，属正常情况，只看输出。
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(stdout))
    child.stdin.on('error', () => {})
    child.stdin.end(`${relativePaths.join('\0')}\0`)
  })
}

/**
 * 返回 `names`（某个目录下的直接子项名字）里被 .gitignore 忽略的部分。
 * 不在 Git 仓库中、git 不可用或路径落在仓库之外时返回空集合。
 */
export async function ignoredEntries(directory, names) {
  const entries = (Array.isArray(names) ? names : []).filter(
    (name) => typeof name === 'string' && name
  )
  if (!entries.length) return new Set()

  const root = await repositoryRoot(directory)
  if (!root) return new Set()

  const realRoot = realPath(root)
  const base = realPath(directory)
  const byRelativePath = new Map()
  for (const name of entries) {
    const relative = path.relative(realRoot, path.resolve(base, name))
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    byRelativePath.set(relative.split(path.sep).join('/'), name)
  }
  if (!byRelativePath.size) return new Set()

  const output = await runCheckIgnore(root, [...byRelativePath.keys()])
  const ignored = new Set()
  for (const relative of parseIgnoredPaths(output)) {
    const name = byRelativePath.get(relative)
    if (name) ignored.add(name)
  }
  return ignored
}
