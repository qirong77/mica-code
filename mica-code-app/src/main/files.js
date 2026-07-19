import { ipcMain } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { chmod, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises'
import path from 'path'

function normalizeDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('directory is required')
  return path.resolve(value)
}

function versionOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function registerFilesIpc() {
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
