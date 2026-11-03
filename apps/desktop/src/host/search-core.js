/**
 * 文件内容搜索的纯逻辑：把「匹配大小写 / 全字匹配 / 正则」三个开关编译成逐行匹配器，
 * 以及 VS Code 风格的「包含的文件 / 排除的文件」通配过滤。
 *
 * 单独放一个模块是为了能直接单测——files.js 里那几个 ipcMain handler 挂着 electron，
 * 测不了。
 */

const WORD_CHARACTER = /[0-9A-Za-z_]/

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 全字匹配：命中片段的前后都不是词字符（CJK 与符号天然算边界）。 */
function isWholeWord(line, index, length) {
  const before = line[index - 1]
  const after = line[index + length]
  return !(before && WORD_CHARACTER.test(before)) && !(after && WORD_CHARACTER.test(after))
}

/**
 * 编译查询。返回 `{ ok, error, match(line) }`；`match` 命中时给出 `{ column, length }`
 * （0 基列号 + 命中长度，供预览行高亮用），未命中返回 null。
 *
 * 正则无效时返回 `ok: false` 而不是抛错：输入框里打了一半的 `*` 只是还没写完，
 * 不该把整个面板变成错误页。
 */
export function compileQuery({ query, matchCase = false, wholeWord = false, regex = false } = {}) {
  const source = String(query ?? '')
  if (!source) return { ok: true, error: null, match: () => null }

  let pattern
  try {
    pattern = new RegExp(regex ? source : escapeRegExp(source), matchCase ? 'g' : 'gi')
  } catch {
    return { ok: false, error: '正则表达式无效', match: () => null }
  }

  const match = (line) => {
    pattern.lastIndex = 0
    let found = pattern.exec(line)
    while (found) {
      const length = found[0].length
      if (!wholeWord || isWholeWord(line, found.index, length)) {
        return { column: found.index, length: Math.max(length, 1) }
      }
      // 零宽命中（如 `^`、`a*`）必须自己往前挪一格，否则 pattern.lastIndex 不动会死循环
      pattern.lastIndex = found.index + Math.max(length, 1)
      found = pattern.exec(line)
    }
    return null
  }

  return { ok: true, error: null, match }
}

/** 逗号分隔的过滤清单（VS Code 的「包含的文件 / 排除的文件」就是这个形状）。 */
export function parseGlobList(value) {
  return String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          // `src/**/a.ts` 也要匹配 `src/a.ts`：`**/` 允许零层目录
          source += '(?:[^/]*/)*'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        // 单个 `*` 不跨目录（与 VS Code 的 glob 一致）
        source += '[^/]*'
      }
    } else if (character === '?') source += '[^/]'
    else source += escapeRegExp(character)
  }
  return new RegExp(`^${source}$`)
}

/** 条目里带 `/` 就整条路径匹配，否则只比文件名——与 VS Code 一致（`*.ts` 匹配任意层）。 */
export function matchesGlob(relativePath, pattern) {
  const target = pattern.includes('/') ? relativePath : relativePath.split('/').pop()
  return globToRegExp(pattern).test(target)
}

export function matchesAnyGlob(relativePath, patterns) {
  return patterns.some((pattern) => matchesGlob(relativePath, pattern))
}

/** 包含清单为空表示不限制；排除清单命中即跳过。 */
export function passesFileFilters(relativePath, { include = [], exclude = [] } = {}) {
  if (exclude.length && matchesAnyGlob(relativePath, exclude)) return false
  if (include.length && !matchesAnyGlob(relativePath, include)) return false
  return true
}

export const MAX_PREVIEW_LENGTH = 300

/**
 * 预览行 + 高亮区间。高亮偏移由 host 算好（而不是让渲染层拿查询串去 preview 里再找一遍）：
 * 长行会被截断成 `…` 前缀，正则/大小写敏感模式下渲染层也未必能复现同一处命中。
 */
export function buildPreview(line, matchIndex, matchLength) {
  if (line.length <= MAX_PREVIEW_LENGTH) {
    return { preview: line, highlight: [matchIndex, matchIndex + matchLength] }
  }
  const contextLength = Math.max(0, Math.floor((MAX_PREVIEW_LENGTH - matchLength) / 2))
  const start = Math.max(0, Math.min(matchIndex - contextLength, line.length - MAX_PREVIEW_LENGTH))
  const end = Math.min(line.length, start + MAX_PREVIEW_LENGTH)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < line.length ? '…' : ''
  return {
    preview: `${prefix}${line.slice(start, end)}${suffix}`,
    highlight: [
      prefix.length + (matchIndex - start),
      prefix.length + Math.min(matchIndex - start + matchLength, end - start)
    ]
  }
}

/**
 * 纯 ASCII 的查询可以在 UTF-8 字节上直接预筛：命中处必然是 ASCII 字节序列，所以整个
 * 文件不必先解码就能判定「不可能命中」。这条路径把大仓库里的解码开销砍掉一个数量级
 * ——绝大多数文件里根本没有这个词，白解码一遍只是烧 CPU。
 *
 * 含非 ASCII 的查询（中文、emoji）返回 null，走正常解码路径：UTF-8 多字节序列里
 * 逐字节折叠大小写不安全。
 */
export function asciiNeedle(query) {
  const source = String(query ?? '')
  if (!source) return null
  const bytes = Buffer.from(source, 'utf8')
  for (const byte of bytes) if (byte >= 0x80) return null
  return bytes
}

/** 只折叠 ASCII 大写字母；其余字节原样。needle 已确认是 ASCII，非 ASCII 字节不会误配。 */
function foldByte(byte) {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte
}

/** 在 buffer 里找一个 ASCII needle（`matchCase` 为假时忽略 ASCII 大小写）。 */
export function indexOfAscii(buffer, needle, { matchCase = false } = {}) {
  const length = needle.length
  if (!length || length > buffer.length) return -1
  const head = matchCase ? needle[0] : foldByte(needle[0])
  const limit = buffer.length - length
  for (let start = 0; start <= limit; start += 1) {
    const first = buffer[start]
    if (matchCase ? first !== head : foldByte(first) !== head) continue
    let matched = true
    for (let offset = 1; offset < length; offset += 1) {
      const byte = buffer[start + offset]
      const want = needle[offset]
      if (matchCase ? byte !== want : foldByte(byte) !== foldByte(want)) {
        matched = false
        break
      }
    }
    if (matched) return start
  }
  return -1
}

export function bufferMayContain(buffer, { needle, matchCase = false } = {}) {
  if (!needle?.length) return true
  return indexOfAscii(buffer, needle, { matchCase }) >= 0
}

export const SEARCH_LIMITS = {
  maxResults: 200,
  maxBytes: 128 * 1024 * 1024,
  concurrency: 8
}

/**
 * 逐个文件扫描并返回命中行。
 *
 * 读文件是 IO 与解码混合的开销，串行扫上万个小文件时几乎全在等；所以按批并发读，
 * 但**结果仍按文件在清单里的顺序**返回（批内按索引归位、批间串行），界面上的分组
 * 顺序与目录遍历/`git ls-files` 的顺序一致，不会随完成次序抖动。
 *
 * `files` 是异步迭代器（目录遍历或 git 清单），`readFile(file, remainingBytes)` 由宿主
 * 注入：搜索核心不碰文件系统，测试里塞一个内存实现就能覆盖全部分支。
 */
export async function collectSearchMatches({
  files,
  compiled,
  shouldScan = () => true,
  readFile,
  prefilter = null,
  limits = {},
  signal = null,
  concurrency = SEARCH_LIMITS.concurrency
} = {}) {
  const maxResults = limits.maxResults ?? SEARCH_LIMITS.maxResults
  const maxBytes = limits.maxBytes ?? SEARCH_LIMITS.maxBytes
  const batchSize = Math.max(concurrency, 32)

  const items = []
  let scannedBytes = 0
  let truncated = false
  let cancelled = false

  const scanOne = async (file, remaining) => {
    const loaded = await readFile(file, remaining)
    if (!loaded) return null
    const buffer = loaded.buffer ?? Buffer.from(String(loaded.content ?? ''), 'utf8')
    if (prefilter && !bufferMayContain(buffer, prefilter))
      return { bytes: loaded.bytes, matches: [] }

    let content
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      return { bytes: loaded.bytes, matches: [] }
    }

    const matches = []
    const lines = content.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index]
      const found = compiled.match(line)
      if (!found) continue
      const { preview, highlight } = buildPreview(line, found.column, found.length)
      matches.push({
        path: file.path,
        relativePath: file.relativePath,
        line: index + 1,
        column: found.column + 1,
        preview,
        highlight
      })
      // 单个文件也不该无限堆结果：面板最多显示 maxResults 条，命中多的大文件扫到够就停
      if (matches.length >= maxResults) break
    }
    return { bytes: loaded.bytes, matches }
  }

  const scanBatch = async (batch) => {
    if (!batch.length) return false
    const results = new Array(batch.length)
    let cursor = 0
    // 预算按「已结算 + 在读」算：worker 领下一个文件之前就知道额度用光了，
    // 不必等整批结算完才发现多读了一批。
    let inflightBytes = 0
    const worker = async () => {
      while (cursor < batch.length) {
        if (signal?.aborted) return
        if (scannedBytes + inflightBytes >= maxBytes) return
        const index = cursor
        cursor += 1
        const remaining = Math.max(0, maxBytes - scannedBytes - inflightBytes)
        const result = await scanOne(batch[index], remaining)
        if (result) inflightBytes += result.bytes
        results[index] = result
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, () => worker()))

    if (signal?.aborted) cancelled = true
    for (const result of results) {
      if (!result) continue
      scannedBytes += result.bytes
      for (const match of result.matches) {
        if (items.length >= maxResults) {
          truncated = true
          break
        }
        items.push(match)
      }
      if (truncated) break
    }
    if (scannedBytes >= maxBytes) truncated = true
    return truncated || cancelled
  }

  let batch = []
  for await (const file of files) {
    if (signal?.aborted) {
      cancelled = true
      break
    }
    if (!shouldScan(file)) continue
    if (scannedBytes >= maxBytes) {
      truncated = true
      break
    }
    batch.push(file)
    if (batch.length < batchSize) continue
    const current = batch
    batch = []
    if (await scanBatch(current)) break
  }
  if (!cancelled && !truncated) await scanBatch(batch)

  return { items, scannedBytes, truncated, cancelled }
}
