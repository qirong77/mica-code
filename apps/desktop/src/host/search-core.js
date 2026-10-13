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
