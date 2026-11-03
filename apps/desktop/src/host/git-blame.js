// 行级 blame：给 diff 编辑器的行悬停提供「这一行是谁、哪个提交、什么时候改的」。
// 不 import electron，测试能对着临时仓库跑真实 git。
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { cachedRepository, git, safeFilePath } from './git-ops'

const COMMIT_HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/
const ZERO_HASH = /^0+$/

/**
 * `git blame --porcelain` 输出 → Map<finalLine, 记录>。
 *
 * porcelain 只在每个分组的首行带提交元数据，同一提交连续的多行随后只用
 * `<sha> <orig> <final>` 起头，所以元数据按 sha 记住复用。
 */
export function parseBlamePorcelain(output) {
  const commits = new Map()
  const lines = new Map()
  let current = null
  for (const record of String(output || '').split('\n')) {
    if (record.startsWith('\t')) {
      if (current) lines.set(current.finalLine, current)
      continue
    }
    const header = COMMIT_HEADER.exec(record)
    if (header) {
      const [, hash, originalLine, finalLine, groupSize] = header
      if (!commits.has(hash)) commits.set(hash, { hash, boundary: false })
      const meta = commits.get(hash)
      current = {
        ...meta,
        hash,
        originalLine: Number(originalLine),
        finalLine: Number(finalLine),
        groupSize: groupSize ? Number(groupSize) : 1,
        uncommitted: ZERO_HASH.test(hash)
      }
      continue
    }
    if (!current) continue
    const space = record.indexOf(' ')
    if (space < 0) continue
    const key = record.slice(0, space)
    const value = record.slice(space + 1)
    const meta = commits.get(current.hash)
    // 元数据同时写进提交表：同一提交后面的行只带 `<sha> <orig> <final>`，
    // 作者 / 说明 / 文件名要从第一组继承下来。
    const assign = (field, assigned) => {
      current[field] = assigned
      meta[field] = assigned
    }
    if (key === 'author') assign('author', value)
    else if (key === 'author-mail') assign('authorMail', value.replace(/^<|>$/g, ''))
    else if (key === 'author-time') assign('authorTime', Number(value) * 1000)
    else if (key === 'author-tz') assign('authorTz', value)
    else if (key === 'summary') assign('summary', value)
    else if (key === 'filename') assign('filename', value)
    else if (key === 'previous')
      assign('previous', {
        hash: value.split(' ')[0],
        path: value.split(' ')[1]
      })
    else if (key === 'boundary') assign('boundary', true)
  }
  return lines
}

/** 索引里那份内容写成临时文件：`--contents` 只认文件路径，索引里的 blob 没有路径。 */
async function indexContentsFile(root, filePath) {
  const listing = await git(root, [
    '--literal-pathspecs',
    'ls-files',
    '--stage',
    '-z',
    '--',
    filePath
  ])
  for (const record of listing.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab < 0 || record.slice(tab + 1) !== filePath) continue
    const [, hash, stage] = record.slice(0, tab).split(' ')
    if (stage !== '0') continue
    const content = await git(root, ['cat-file', 'blob', hash], { encoding: 'buffer' })
    const directory = await mkdtemp(path.join(tmpdir(), 'mica-blame-'))
    const target = path.join(directory, 'contents')
    await writeFile(target, content)
    return { directory, target }
  }
  return null
}

async function commitHashOf(root, ref) {
  return (await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim()
}

/**
 * 一段连续的行的 blame。三种口径：
 * - `ref` 给了提交（分支、标签、哈希都行）→ 那个提交里的版本；
 * - `index` 为真 → 索引里的版本（staged 比较的右侧）；
 * - 都不给 → 工作区里的版本（未提交的行归到「未提交的更改」）。
 *
 * 取不到就回 `{ error }`：切换分支后文件消失、还没提交过、目录不是仓库都属于常态，
 * 悬停不该因此把界面弄崩。
 */
async function blameLines(cwd, filePath, { ref = null, index = false, from = 1, to = from } = {}) {
  const start = Math.max(1, Math.floor(Number(from) || 1))
  const end = Math.max(start, Math.floor(Number(to) || start))
  let temporary = null
  try {
    const { root } = await cachedRepository(cwd)
    safeFilePath(root, filePath)
    const args = ['blame', '--porcelain', '-L', `${start},${end}`]
    const source = index ? 'index' : typeof ref === 'string' && ref.trim() ? 'commit' : 'worktree'
    if (index) {
      temporary = await indexContentsFile(root, filePath)
      if (!temporary) return { start, end, error: '这个文件还没有进入索引' }
      args.push('--contents', temporary.target)
    } else if (source === 'commit') {
      args.push(await commitHashOf(root, ref.trim()))
    }
    args.push('--', filePath)
    const records = [...parseBlamePorcelain(await git(root, args)).values()].map((record) => ({
      line: record.finalLine,
      hash: record.hash,
      shortHash: record.hash.slice(0, 8),
      author: record.author || '',
      authorMail: record.authorMail || '',
      time: record.authorTime || 0,
      summary: record.summary || '',
      filename: record.filename || filePath,
      previous: record.previous || null,
      boundary: record.boundary === true,
      uncommitted: record.uncommitted === true,
      source
    }))
    return { start, end, source, records }
  } catch (error) {
    return {
      start,
      end,
      records: [],
      error: String(error?.stderr || error?.message || error).trim()
    }
  } finally {
    if (temporary) await rm(temporary.directory, { recursive: true, force: true }).catch(() => {})
  }
}

/** 单行 blame（悬停最常用的那条路）。 */
export async function blameLine(cwd, filePath, options = {}) {
  const requested = Math.max(1, Math.floor(Number(options.line) || 1))
  const result = await blameLines(cwd, filePath, { ...options, from: requested, to: requested })
  const line = result.records?.find((record) => record.line === requested) || null
  if (!line) return { line: requested, error: result.error || '没有这一行的 blame 记录' }
  return line
}
