import { app, clipboard, ipcMain, shell } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { findFileMentions } from '@packages/mica-file-mentions/index.js'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile
} from 'fs/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { ignoredEntries } from './git-ignore'
import { noteWorktreeChange, repositoryRootOf } from './git-ops'
import { listSearchFiles } from './search-files'
import {
  asciiNeedle,
  collectSearchMatches,
  compileQuery,
  parseGlobList,
  passesFileFilters
} from './search-core'

const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_FILE_SIZE = 2 * 1024 * 1024
const MAX_SEARCH_BYTES = 128 * 1024 * 1024
const MAX_QUERY_LENGTH = 1_000
// 「快速打开」一次给的行数：比 `@` 补全的 20 条多，但它复用同一份扫描与缓存。
const MAX_QUICK_OPEN_RESULTS = 100

/** 正在跑的搜索按请求标识隔离，同一目录可以同时被多个窗口或面板搜索。 */
const activeSearches = new Map()

function normalizeDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('directory is required')
  return path.resolve(expandHome(value))
}

/**
 * 聊天里识别出的路径可能写成 `~/...`（Agent 的输出常常是这种形态）。
 * `path.resolve` 会把 `~` 当普通目录名，所以先自己展开。
 */
function expandHome(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed !== '~' && !trimmed.startsWith('~/') && !trimmed.startsWith('~\\')) return trimmed
  return path.join(app.getPath('home'), trimmed.slice(1))
}

function versionOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function normalizeRoot(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('root is required')
  return path.resolve(value)
}

function normalizeName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('名称不能为空')
  const name = value.trim()
  if (
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new Error('名称不能包含路径分隔符')
  }
  return name
}

/** 文件树手动拖拽排序：userData/file-order.json，{ [directoryPath]: [name, ...] } */
function orderFile() {
  return path.join(app.getPath('userData'), 'file-order.json')
}

function readFileOrder() {
  try {
    const raw = JSON.parse(readFileSync(orderFile(), 'utf8'))
    const order = {}
    for (const [directory, names] of Object.entries(raw || {})) {
      order[directory] = Array.isArray(names)
        ? names.filter((name) => typeof name === 'string' && name)
        : []
    }
    return order
  } catch {
    return {}
  }
}

function writeFileOrder(order) {
  const file = orderFile()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(order, null, 2)}\n`, 'utf8')
}

async function availableCopyPath(source) {
  const extension = path.extname(source)
  const stem = path.basename(source, extension)
  const directory = path.dirname(source)
  for (let index = 1; index < 10_000; index += 1) {
    const suffix = index === 1 ? ' 副本' : ` 副本 ${index}`
    const candidate = path.join(directory, `${stem}${suffix}${extension}`)
    try {
      await lstat(candidate)
    } catch (error) {
      if (error?.code === 'ENOENT') return candidate
      throw error
    }
  }
  throw new Error('无法生成副本名称')
}

/**
 * 我们自己刚改过工作区：让那份 Git 缓存立刻失效，否则顶栏徽标与 GIT 面板要等 5s
 * TTL 才看到新建 / 改名 / 移动 / 复制 / 删除的文件。目录可能不在仓库里。
 */
function noteWorktreeMutations(...directories) {
  for (const directory of new Set(directories.filter(Boolean))) {
    noteWorktreeChange(repositoryRootOf(directory))
  }
}

function isProbablyBinary(buffer) {
  const sampleSize = Math.min(buffer.length, 8 * 1024)
  let controlCharacters = 0

  for (let index = 0; index < sampleSize; index += 1) {
    const byte = buffer[index]
    if (byte === 0) return true
    if (byte < 7 || (byte > 13 && byte < 32)) controlCharacters += 1
  }
  return sampleSize > 0 && controlCharacters / sampleSize > 0.1
}

/**
 * 读一个文件给搜索用。**不解码**：ASCII 查询先在字节上预筛，不命中的文件根本不用
 * 解成字符串（见 search-core 的 bufferMayContain）。这里只负责大小、二进制与读取。
 */
async function readSearchFile(filePath, remainingBytes) {
  let handle
  try {
    handle = await open(filePath, 'r')
    const openedInfo = await handle.stat()
    if (!openedInfo.isFile()) return null
    if (openedInfo.size > MAX_SEARCH_FILE_SIZE || openedInfo.size > remainingBytes) return null

    const buffer = Buffer.allocUnsafe(openedInfo.size)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const contentBuffer = buffer.subarray(0, bytesRead)
    if (isProbablyBinary(contentBuffer)) return null
    return { buffer: contentBuffer, bytes: bytesRead }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

export function registerFilesIpc() {
  ipcMain.handle('files:order-get', () => readFileOrder())
  ipcMain.handle('files:order-set', (_event, payload = {}) => {
    const directory = normalizeDirectory(payload.directory)
    const names = Array.isArray(payload.names)
      ? payload.names.filter((name) => typeof name === 'string' && name)
      : []
    const order = readFileOrder()
    if (names.length) order[directory] = names
    else delete order[directory]
    writeFileOrder(order)
    return order
  })

  // `@` 补全候选：与 CLI 的 file-mention 插件共用 mica-file-mentions，所以两端
  // 的排序、数量和插入文本一致（排序/截断都在那个包里，这里只做校验）。
  ipcMain.handle('files:mention', async (_event, payload = {}) => {
    const root = normalizeRoot(payload.root)
    if (payload.query != null && typeof payload.query !== 'string') {
      throw new Error('query must be a string')
    }
    if ((payload.query || '').length > MAX_QUERY_LENGTH) throw new Error('query is too long')
    return findFileMentions(root, payload.query || '')
  })

  // 「快速打开」（Ctrl+P）：按名称找工作区文件。与 `@` 补全共用
  // mica-file-mentions 的扫描与 45s 缓存，所以两端看到的候选与延迟一致；
  // 目录在这里滤掉——快速打开的动作是打开文件，目录在文件树里进。
  ipcMain.handle('files:find', async (_event, payload = {}) => {
    const root = normalizeRoot(payload.root)
    if (payload.query != null && typeof payload.query !== 'string') {
      throw new Error('query must be a string')
    }
    const query = (payload.query || '').trim()
    if (!query) return { items: [], truncated: false }
    if (query.length > MAX_QUERY_LENGTH) throw new Error('query is too long')
    const found = await findFileMentions(root, query, MAX_QUICK_OPEN_RESULTS)
    const items = found
      .filter((item) => !item.path.endsWith('/'))
      .map((item) => ({ path: item.path, label: item.label, relativePath: item.description }))
    return { items, truncated: found.length >= MAX_QUICK_OPEN_RESULTS }
  })

  ipcMain.handle('files:search', async (_event, payload = {}) => {
    const root = normalizeRoot(payload.root)
    if (typeof payload.query !== 'string') throw new Error('query is required')
    if (!payload.query || payload.query.length > MAX_QUERY_LENGTH) {
      return { items: [], truncated: false, error: null }
    }

    const options = {
      matchCase: !!payload.matchCase,
      wholeWord: !!payload.wholeWord,
      regex: !!payload.regex,
      include: parseGlobList(payload.include),
      exclude: parseGlobList(payload.exclude)
    }
    const compiled = compileQuery({ query: payload.query, ...options })
    // 正则还没写完（如 `([`）时把它当成一条提示，而不是整块面板变成错误页
    if (!compiled.ok) return { items: [], truncated: false, error: compiled.error }

    const controller = new AbortController()
    // 没有标识的旧调用也可以搜索，但不能被无标识的取消误伤。
    const requestId = payload.requestId ?? Symbol('search')
    activeSearches.set(requestId, { controller, root })

    // 纯 ASCII 查询可以先在字节上判断「这个文件不可能命中」，跳过解码；
    // 正则与含中文的查询没有这种捷径，照常解码后逐行匹配。
    const needle = options.regex ? null : asciiNeedle(payload.query)
    const prefilter = needle ? { needle, matchCase: options.matchCase } : null

    try {
      const result = await collectSearchMatches({
        files: listSearchFiles(root),
        compiled,
        shouldScan: (file) => passesFileFilters(file.relativePath, options),
        readFile: (file, remaining) => readSearchFile(file.path, remaining),
        prefilter,
        limits: { maxResults: MAX_SEARCH_RESULTS, maxBytes: MAX_SEARCH_BYTES },
        signal: controller.signal
      })
      return {
        items: result.items,
        truncated: result.truncated,
        error: null,
        cancelled: result.cancelled
      }
    } finally {
      if (activeSearches.get(requestId)?.controller === controller) activeSearches.delete(requestId)
    }
  })

  // 面板关闭 / 查询清空时让正在跑的搜索停下来（结果没人要，没必要扫完）。requestId 让
  // 这个取消只作用于它自己那一次：调用方与被取消的请求之间隔着一次异步往返，早到的
  // 取消不该杀掉随后发起的新查询。
  ipcMain.handle('files:search-cancel', (_event, payload = {}) => {
    const root = normalizeRoot(payload.root)
    if (payload.requestId == null) return false
    const active = activeSearches.get(payload.requestId)
    if (!active || active.root !== root) return false
    active.controller.abort()
    activeSearches.delete(payload.requestId)
    return true
  })

  ipcMain.handle('files:list', async (_event, payload = {}) => {
    const directory = normalizeDirectory(payload.path)
    const entries = await readdir(directory, { withFileTypes: true })
    const listed = entries
      .map((entry) => ({
        name: entry.name,
        path: path.join(directory, entry.name),
        type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file'
      }))
      .sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      })
    // 被 .gitignore 忽略的条目在文件树里整行置灰，标记只有 host 里的 git 能给出。
    const ignored = await ignoredEntries(
      directory,
      listed.map((entry) => entry.name)
    )

    return {
      path: directory,
      parentPath: path.dirname(directory) === directory ? null : path.dirname(directory),
      entries: listed.map((entry) =>
        ignored.has(entry.name) ? { ...entry, ignored: true } : entry
      )
    }
  })

  ipcMain.handle('files:create', async (_event, payload = {}) => {
    const directory = normalizeDirectory(payload.directory)
    const target = path.join(directory, normalizeName(payload.name))
    if (payload.type === 'directory') await mkdir(target)
    else if (payload.type === 'file') await writeFile(target, '', { flag: 'wx' })
    else throw new Error('type must be file or directory')
    noteWorktreeMutations(directory)
    return { path: target }
  })

  ipcMain.handle('files:rename', async (_event, payload = {}) => {
    const source = normalizeDirectory(payload.path)
    const target = path.join(path.dirname(source), normalizeName(payload.name))
    if (source !== target) await rename(source, target)
    if (source !== target) noteWorktreeMutations(path.dirname(source))
    return { path: target }
  })

  ipcMain.handle('files:move', async (_event, payload = {}) => {
    const source = normalizeDirectory(payload.path)
    const directory = normalizeDirectory(payload.directory)
    const target = path.join(directory, path.basename(source))
    if (source === target) return { path: source }
    const relative = path.relative(source, target)
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error('不能将文件夹移动到自身内部')
    }
    await rename(source, target)
    noteWorktreeMutations(path.dirname(source), directory)
    return { path: target }
  })

  ipcMain.handle('files:duplicate', async (_event, payload = {}) => {
    const source = normalizeDirectory(payload.path)
    const info = await lstat(source)
    const target = await availableCopyPath(source)
    if (info.isDirectory()) await cp(source, target, { recursive: true, errorOnExist: true })
    else if (info.isFile()) await copyFile(source, target)
    else throw new Error('不支持复制此类型的项目')
    noteWorktreeMutations(path.dirname(target))
    return { path: target }
  })

  ipcMain.handle('files:delete', async (_event, payload = {}) => {
    const target = normalizeDirectory(payload.path)
    await shell.trashItem(target)
    noteWorktreeMutations(path.dirname(target))
    return { path: target }
  })

  ipcMain.handle('files:copy-path', (_event, payload = {}) => {
    clipboard.writeText(normalizeDirectory(payload.path))
    return true
  })

  ipcMain.handle('files:copy-relative-path', (_event, payload = {}) => {
    const root = normalizeDirectory(payload.root)
    const target = normalizeDirectory(payload.path)
    const relative = path.relative(root, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('项目不在当前根目录中')
    }
    clipboard.writeText(relative)
    return relative
  })

  ipcMain.handle('files:reveal', (_event, payload = {}) => {
    shell.showItemInFolder(normalizeDirectory(payload.path))
    return true
  })

  // 聊天文本 / 回合日志里点路径的默认动作：目录交给 Finder 打开，文件在文件管理器里
  // 定位（macOS 是 `open -R`，会选中文件本身）。路径不存在时回错，由调用方提示，
  // 不要静默打开一个不存在的目标。
  ipcMain.handle('files:open-path', async (_event, payload = {}) => {
    const target = path.resolve(expandHome(payload.path))
    let info
    try {
      info = await stat(target)
    } catch {
      return { ok: false, error: `路径不存在：${target}` }
    }
    if (info.isDirectory()) {
      const message = await shell.openPath(target)
      if (message) return { ok: false, error: message }
      return { ok: true, kind: 'directory', path: target }
    }
    shell.showItemInFolder(target)
    return { ok: true, kind: 'file', path: target }
  })

  // 路径点击要决定「在 Mica 中打开」是开文件还是把文件树切到那个目录：页面这边拿不到
  // 文件系统，只能问运行时一次。不存在同样是正常结果（调用方据此提示），不走抛错。
  ipcMain.handle('files:stat', async (_event, payload = {}) => {
    const target = path.resolve(expandHome(payload.path))
    try {
      const info = await stat(target)
      return {
        ok: true,
        path: target,
        kind: info.isDirectory() ? 'directory' : 'file',
        size: info.size
      }
    } catch {
      return { ok: false, path: target, error: `路径不存在：${target}` }
    }
  })

  ipcMain.handle('files:read', async (_event, payload = {}) => {
    const filePath = normalizeDirectory(payload.path)
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('path is not a file')
    if (info.size > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，无法在编辑器中打开')
    const buffer = await readFile(filePath)
    if (buffer.includes(0)) throw new Error('二进制文件无法在文本编辑器中打开')
    let content
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      throw new Error('文件不是有效的 UTF-8 文本，无法安全编辑')
    }
    return { path: filePath, content, size: info.size, version: versionOf(buffer) }
  })

  ipcMain.handle('files:write', async (_event, payload = {}) => {
    const filePath = normalizeDirectory(payload.path)
    if (typeof payload.content !== 'string') throw new Error('content is required')
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('path is not a file')
    const current = await readFile(filePath)
    if (payload.expectedVersion && versionOf(current) !== payload.expectedVersion) {
      throw new Error('文件已被其他程序修改。请重新打开文件后再编辑，避免覆盖新的内容')
    }

    const next = Buffer.from(payload.content, 'utf8')
    const temporaryPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${randomUUID()}.tmp`
    )
    try {
      await writeFile(temporaryPath, next, { mode: info.mode })
      await chmod(temporaryPath, info.mode)
      await rename(temporaryPath, filePath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => {})
      throw error
    }
    // 编辑器里刚保存的内容，徽标和 Git 面板下一次轮询就该看到：不必等 mtime 探测
    // （工作区里任何进程在写都会让探测失效，它挡不住这种「刚写完就该刷新」的场景）。
    noteWorktreeChange(repositoryRootOf(path.dirname(filePath)))
    return { path: filePath, size: next.length, version: versionOf(next) }
  })
}
