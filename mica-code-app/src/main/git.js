import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import { promisify } from 'util'
import { ipcMain } from 'electron'

const execFileAsync = promisify(execFile)
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

async function git(cwd, args, options = {}) {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  return result.stdout
}

async function getRepository(cwd) {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  let base = EMPTY_TREE
  try {
    base = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim()
  } catch {
    // A repository without its first commit is compared with Git's empty tree.
  }
  return { root, base }
}

function parseStatus(value) {
  const records = value.split('\0')
  const changes = new Map()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    const code = record.slice(0, 2)
    const filePath = record.slice(3)
    if (code.includes('R') || code.includes('C')) index += 1
    changes.set(
      filePath,
      code === '??' || code[0] === 'A' ? 'added' : code.includes('D') ? 'deleted' : 'modified'
    )
  }
  return changes
}

function parseNumstat(value) {
  const stats = new Map()
  for (const line of value.split('\n')) {
    if (!line) continue
    const firstTab = line.indexOf('\t')
    const secondTab = line.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const added = line.slice(0, firstTab)
    const deleted = line.slice(firstTab + 1, secondTab)
    stats.set(line.slice(secondTab + 1), {
      additions: added === '-' ? 0 : Number(added),
      deletions: deleted === '-' ? 0 : Number(deleted),
      binary: added === '-' || deleted === '-'
    })
  }
  return stats
}

function countLines(buffer) {
  if (!buffer.length) return 0
  let count = 0
  for (const byte of buffer) if (byte === 10) count += 1
  return count + (buffer.at(-1) === 10 ? 0 : 1)
}

async function getSummary(cwd) {
  const { root, base } = await getRepository(cwd)
  const [statusOutput, numstatOutput] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']),
    git(root, ['diff', base, '--numstat', '--no-renames', '--'])
  ])
  const changes = parseStatus(statusOutput)
  const numstats = parseNumstat(numstatOutput)
  const files = []

  for (const [filePath, status] of changes) {
    let stat = numstats.get(filePath)
    if (!stat && status === 'added') {
      const content = await readFile(path.join(root, filePath))
      stat = {
        additions: content.includes(0) ? 0 : countLines(content),
        deletions: 0,
        binary: content.includes(0)
      }
    }
    files.push({
      path: filePath,
      status,
      additions: stat?.additions || 0,
      deletions: stat?.deletions || 0,
      binary: stat?.binary || false
    })
  }

  files.sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })
  )
  return {
    root,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0)
  }
}

async function getStatus(cwd) {
  const { root } = await getRepository(cwd)
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  return {
    root,
    branch: branch === 'HEAD' ? 'detached' : branch,
    projectName: path.basename(root)
  }
}

function safeFilePath(root, relativePath) {
  const absolutePath = path.resolve(root, relativePath)
  const relative = path.relative(root, absolutePath)
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Invalid repository path')
  return absolutePath
}

export function registerGitIpc() {
  ipcMain.handle('git:status', async (_event, { cwd } = {}) => {
    try {
      return { status: await getStatus(cwd), error: null }
    } catch (error) {
      return { status: null, error: error?.stderr?.trim() || error?.message || String(error) }
    }
  })

  ipcMain.handle('git:summary', async (_event, { cwd } = {}) => {
    try {
      return { repository: await getSummary(cwd), error: null }
    } catch (error) {
      return { repository: null, error: error?.stderr?.trim() || error?.message || String(error) }
    }
  })

  ipcMain.handle('git:file', async (_event, { cwd, filePath } = {}) => {
    const { root, base } = await getRepository(cwd)
    const absolutePath = safeFilePath(root, filePath)
    let original = Buffer.alloc(0)
    let modified = Buffer.alloc(0)
    try {
      original = await git(root, ['show', `${base}:${filePath}`], { encoding: 'buffer' })
    } catch {
      // New files have no original content.
    }
    if (existsSync(absolutePath)) modified = await readFile(absolutePath)
    const binary = original.includes(0) || modified.includes(0)
    return {
      original: binary ? '' : original.toString('utf8'),
      modified: binary ? '' : modified.toString('utf8'),
      binary
    }
  })
}
