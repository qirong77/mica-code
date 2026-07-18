import { ipcMain } from 'electron'
import { readdir } from 'fs/promises'
import path from 'path'

function normalizeDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('directory is required')
  return path.resolve(value.trim())
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
}
