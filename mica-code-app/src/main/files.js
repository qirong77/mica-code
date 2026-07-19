import { ipcMain } from 'electron'
import { createHash, randomUUID } from 'crypto'
import {
  chmod,
  lstat,
  open,
  opendir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile
} from 'fs/promises'
import path from 'path'

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out'
])
const MAX_WALK_ENTRIES = 100_000
const MAX_WALK_FILES = 50_000
const MAX_FIND_RESULTS = 10_000
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_FILE_SIZE = 2 * 1024 * 1024
const MAX_SEARCH_BYTES = 128 * 1024 * 1024
const MAX_QUERY_LENGTH = 1_000
const MAX_PREVIEW_LENGTH = 300

function normalizeDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('directory is required')
  return path.resolve(value)
}

function versionOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function normalizeRoot(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('root is required')
  return path.resolve(value)
}

function fuzzyMatch(value, query) {
  if (!query) return true
  const candidate = value.toLowerCase()
  if (candidate.includes(query)) return true

  let queryIndex = 0
  for (const character of candidate) {
    if (character === query[queryIndex]) queryIndex += 1
    if (queryIndex === query.length) return true
  }
  return false
}

async function walkFiles(root, visitor) {
  try {
    const rootInfo = await lstat(root)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return
  } catch {
    return
  }

  const directories = [root]
  let entryCount = 0
  let fileCount = 0

  while (directories.length > 0 && entryCount < MAX_WALK_ENTRIES) {
    const directoryPath = directories.pop()
    let directory
    try {
      directory = await opendir(directoryPath)
    } catch {
      continue
    }

    const iterator = directory[Symbol.asyncIterator]()
    try {
      while (entryCount < MAX_WALK_ENTRIES) {
        let next
        try {
          next = await iterator.next()
        } catch {
          break
        }
        if (next.done) break

        entryCount += 1
        const entry = next.value
        if (entry.isSymbolicLink()) continue

        const entryPath = path.join(directoryPath, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) directories.push(entryPath)
          continue
        }
        if (!entry.isFile()) continue

        fileCount += 1
        if (
          (await visitor({
            path: entryPath,
            relativePath: path.relative(root, entryPath),
            name: entry.name
          })) === false
        ) {
          return
        }
        if (fileCount >= MAX_WALK_FILES) return
      }
    } finally {
      await directory.close().catch(() => {})
    }
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

async function readUtf8File(filePath, remainingBytes) {
  let handle
  try {
    const fileInfo = await lstat(filePath)
    if (
      fileInfo.isSymbolicLink() ||
      !fileInfo.isFile() ||
      fileInfo.size > MAX_SEARCH_FILE_SIZE ||
      fileInfo.size > remainingBytes
    ) {
      return null
    }

    handle = await open(filePath, 'r')
    const openedInfo = await handle.stat()
    if (!openedInfo.isFile() || openedInfo.size > MAX_SEARCH_FILE_SIZE) return null

    const buffer = Buffer.allocUnsafe(openedInfo.size)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const contentBuffer = buffer.subarray(0, bytesRead)
    if (isProbablyBinary(contentBuffer)) return null

    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(contentBuffer),
      bytesRead
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

function previewOf(line, matchIndex, queryLength) {
  if (line.length <= MAX_PREVIEW_LENGTH) return line
  const contextLength = Math.max(0, Math.floor((MAX_PREVIEW_LENGTH - queryLength) / 2))
  const start = Math.max(0, Math.min(matchIndex - contextLength, line.length - MAX_PREVIEW_LENGTH))
  const end = Math.min(line.length, start + MAX_PREVIEW_LENGTH)
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
}

export function registerFilesIpc() {
  ipcMain.handle('files:find', async (_event, payload = {}) => {
    const root = normalizeRoot(payload.root)
    if (payload.query != null && typeof payload.query !== 'string') {
      throw new Error('query must be a string')
    }
    const query = (payload.query || '').trim().toLowerCase()
    if (query.length > MAX_QUERY_LENGTH) throw new Error('query is too long')

    const results = []
    await walkFiles(root, async (file) => {
      if (fuzzyMatch(file.relativePath, query)) results.push(file)
      return results.length < MAX_FIND_RESULTS
    })
    return results.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath, undefined, {
        numeric: true,
        sensitivity: 'base'
      })
    )
  })

  ipcMain.handle('files:search', async (_event, payload = {}) => {
    const root = normalizeRoot(payload.root)
    if (typeof payload.query !== 'string') throw new Error('query is required')
    if (!payload.query || payload.query.length > MAX_QUERY_LENGTH) {
      return []
    }

    const query = payload.query.toLowerCase()
    const results = []
    let scannedBytes = 0

    await walkFiles(root, async (file) => {
      const loaded = await readUtf8File(file.path, MAX_SEARCH_BYTES - scannedBytes)
      if (!loaded) return scannedBytes < MAX_SEARCH_BYTES
      scannedBytes += loaded.bytesRead

      const lines = loaded.content.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index]
        const column = line.toLowerCase().indexOf(query)
        if (column === -1) continue

        results.push({
          path: file.path,
          relativePath: file.relativePath,
          line: index + 1,
          column: column + 1,
          preview: previewOf(line, column, payload.query.length)
        })
        if (results.length >= MAX_SEARCH_RESULTS) return false
      }
      return scannedBytes < MAX_SEARCH_BYTES
    })

    return results
  })

  ipcMain.handle('files:list', async (_event, payload = {}) => {
    const directory = normalizeDirectory(payload.path)
    const entries = await readdir(directory, { withFileTypes: true })

    return {
      path: directory,
      parentPath: path.dirname(directory) === directory ? null : path.dirname(directory),
      entries: entries
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
    return { path: filePath, size: next.length, version: versionOf(next) }
  })
}
