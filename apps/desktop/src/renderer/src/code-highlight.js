// 代码块的最小语法着色（`CodeView` 的纯函数部分），聊天 markdown 与详情弹窗共用。
//
// 为什么不是 CodeMirror / Monaco：弹窗里的代码是只读纯文本（最多 5000 行），需要的只是
// 「键名 / 字符串 / 数字 / 注释」这几级色阶。编辑器的代价是再背一份运行时（monaco ~4MB、
// codemirror 也在 300KB 量级）、再手工同步一次主题色、自己做自动高度与滚动容器，还会
// 吃掉 `PathToken` 的路径点击（那是在 `<pre>` 里插 span 才成立的）。
// 这里按语言扫一遍产出 `{ type, text }` span 列表：零依赖、主题色直接读 CSS 变量、
// 拼接后与原文逐字符一致（见 code-highlight.test.js）。
//
// 只覆盖高频的几种：json（工具入参、MCP 返回值）、shell（命令与终端输出）、
// diff（patch）、js/ts（markdown 里的代码块）、log（`run_shell` 的结构化 stdout）。
// 其余语言原样输出，不做「半懂不懂」的着色。

const JSON_LITERALS = new Set(['true', 'false', 'null'])

// 粘性正则：热循环里靠 lastIndex 定位，避免为每个 token 切一次子串。
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const JS_NUMBER = /0[xXbBoO][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const WORD = /[A-Za-z_$][\w$]*/y

const SHELL_OPERATORS = ['2>&1', '&&', '||', '>>', '>&', '|', '>', '<', ';', '&']

const JS_KEYWORDS = new Set(
  `as async await break case catch class const continue debugger declare default delete do else
   enum export extends false finally for from function get if implements import in instanceof
   interface let namespace new null of private protected public readonly return satisfies set
   static super switch this throw true try type typeof undefined var void while yield`
    .split(/\s+/)
    .filter(Boolean)
)

// 「看起来像错误」的段标记：`run_shell` 的 stderr 段与工具自己的告警都是这个形状。
const LOG_TAGS = {
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  fail: 'error',
  failed: 'error'
}

/** 语言别名归一：认得的返回内部名，其余一律 `text`。 */
export function normalizeLanguage(hint) {
  const value = String(hint ?? '')
    .trim()
    .toLowerCase()
  if (!value) return 'text'
  if (value === 'json' || value === 'jsonc') return 'json'
  if (['shell', 'sh', 'bash', 'zsh', 'console', 'shellscript'].includes(value)) return 'shell'
  if (value === 'diff' || value === 'patch') return 'diff'
  if (['js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript'].includes(value)) return 'js'
  if (value === 'log') return 'log'
  return 'text'
}

/**
 * 只有语言标注缺失时用的兜底判断（工具输出没有 fence 语言）。
 * 判定保守：认不出就返回 `text`，宁可不上色也不要乱上色。
 */
export function guessLanguage(text) {
  const sample = String(text ?? '')
    .slice(0, 4000)
    .trim()
  if (!sample) return 'text'
  if (/^(diff --git|@@ -|--- a\/|\+\+\+ b\/)/m.test(sample)) return 'diff'
  if (/^[[{]/.test(sample) && /[\]}]\s*$/.test(sample)) return 'json'
  return 'text'
}

/** 着色后的片段；`text` 拼起来必须与输入完全一致。 */
export function highlightCode(text, language) {
  const source = String(text ?? '')
  if (!source) return []
  const tokens = []
  switch (normalizeLanguage(language)) {
    case 'json':
      scanJson(source, tokens)
      break
    case 'shell':
      scanLines(source, tokens, scanShellLine)
      break
    case 'diff':
      scanLines(source, tokens, scanDiffLine)
      break
    case 'js':
      scanJs(source, tokens)
      break
    case 'log':
      scanLines(source, tokens, scanLogLine)
      break
    default:
      tokens.push({ type: 'plain', text: source })
  }
  return tokens
}

function pushToken(tokens, type, text) {
  if (!text) return
  const last = tokens[tokens.length - 1]
  // 相邻同类型合并：几千行输出能少掉一大半 span。
  if (last && last.type === type) {
    last.text += text
    return
  }
  tokens.push({ type, text })
}

/** 从 `start`（引号本身）读到配对引号之后；没闭合就停在行尾/文本尾，不吞掉后文。 */
function readString(text, start, quote, multiline = false) {
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) return index + 1
    if (!multiline && char === '\n') return index
    index += 1
  }
  return text.length
}

function scanLines(text, tokens, scanLine) {
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) pushToken(tokens, 'plain', '\n')
    if (lines[index]) scanLine(lines[index], tokens)
  }
}

function scanJson(text, tokens) {
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      const end = readString(text, index, '"')
      let next = end
      while (next < text.length && /\s/.test(text[next])) next += 1
      // 键名后面紧跟冒号；值（含数组里的字符串）不会有这个形状。
      pushToken(tokens, text[next] === ':' ? 'key' : 'string', text.slice(index, end))
      index = end
      continue
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      JSON_NUMBER.lastIndex = index
      const match = JSON_NUMBER.exec(text)
      if (match) {
        pushToken(tokens, 'number', match[0])
        index += match[0].length
        continue
      }
    }
    if (/[A-Za-z]/.test(char)) {
      WORD.lastIndex = index
      const match = WORD.exec(text)
      if (match) {
        pushToken(tokens, JSON_LITERALS.has(match[0]) ? 'literal' : 'plain', match[0])
        index += match[0].length
        continue
      }
    }
    pushToken(tokens, '{}[],:'.includes(char) ? 'punct' : 'plain', char)
    index += 1
  }
}

function scanShellLine(line, tokens) {
  const indent = /^\s*/.exec(line)[0]
  pushToken(tokens, 'plain', indent)
  let index = indent.length
  if (line[index] === '#') {
    pushToken(tokens, 'comment', line.slice(index))
    return
  }
  let expectCommand = true
  while (index < line.length) {
    const char = line[index]
    if (/\s/.test(char)) {
      let end = index
      while (end < line.length && /\s/.test(line[end])) end += 1
      pushToken(tokens, 'plain', line.slice(index, end))
      index = end
      continue
    }
    // 行尾注释：`#` 出现在词首位置才算，`a#b` 仍是普通参数。
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      pushToken(tokens, 'comment', line.slice(index))
      return
    }
    if (char === "'" || char === '"') {
      const end = readString(line, index, char)
      pushToken(tokens, 'string', line.slice(index, end))
      index = end
      expectCommand = false
      continue
    }
    if (char === '$') {
      const match = /^\$(?:\{[^}]*\}|[A-Za-z_]\w*|\d|[?#@$!*-])/.exec(line.slice(index))
      if (match) {
        pushToken(tokens, 'variable', match[0])
        index += match[0].length
        expectCommand = false
        continue
      }
      // `$ ls` 这类终端转录：提示符后面又是一条新命令。
      pushToken(tokens, 'operator', char)
      index += 1
      expectCommand = true
      continue
    }
    const operator = SHELL_OPERATORS.find((value) => line.startsWith(value, index))
    if (operator) {
      pushToken(tokens, 'operator', operator)
      index += operator.length
      expectCommand = true
      continue
    }
    let end = index
    while (end < line.length && !/[\s'"$#]/.test(line[end])) {
      if (SHELL_OPERATORS.some((value) => line.startsWith(value, end))) break
      end += 1
    }
    if (end === index) end = index + 1
    const word = line.slice(index, end)
    if (expectCommand) {
      pushToken(tokens, 'command', word)
      expectCommand = false
    } else if (/^--?[A-Za-z]/.test(word)) {
      pushToken(tokens, 'flag', word)
    } else {
      pushToken(tokens, 'plain', word)
    }
    index = end
  }
}

function scanDiffLine(line, tokens) {
  if (/^(diff --git|index |\+\+\+ |@@ |--- )/.test(line)) {
    pushToken(tokens, 'header', line)
    return
  }
  const head = line[0]
  if (head === '+') return pushToken(tokens, 'inserted', line)
  if (head === '-') return pushToken(tokens, 'deleted', line)
  if (head === '\\') return pushToken(tokens, 'comment', line)
  pushToken(tokens, 'plain', line)
}

function scanLogLine(line, tokens) {
  const indent = /^\s*/.exec(line)[0]
  pushToken(tokens, 'plain', indent)
  let index = indent.length
  const tag = /^\[([A-Za-z][\w -]*)\]/.exec(line.slice(index))
  if (tag) {
    pushToken(tokens, LOG_TAGS[tag[1].toLowerCase()] || 'header', tag[0])
    index += tag[0].length
    if (!line.slice(index).trim()) return
  }
  // `exit_code: 0` 这类键值行：只有行首的短键名算键，正文里的 `a: b` 不动。
  const pair = /^([A-Za-z_][\w.-]*):(?=\s|$)/.exec(line.slice(index))
  if (pair) {
    pushToken(tokens, 'key', pair[1])
    pushToken(tokens, 'punct', ':')
    index += pair[0].length
  }
  pushToken(tokens, 'plain', line.slice(index))
}

function scanJs(text, tokens) {
  let index = 0
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (char === '/' && next === '/') {
      const stop = text.indexOf('\n', index)
      const end = stop === -1 ? text.length : stop
      pushToken(tokens, 'comment', text.slice(index, end))
      index = end
      continue
    }
    if (char === '/' && next === '*') {
      const stop = text.indexOf('*/', index + 2)
      const end = stop === -1 ? text.length : stop + 2
      pushToken(tokens, 'comment', text.slice(index, end))
      index = end
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const end = readString(text, index, char, char === '`')
      pushToken(tokens, 'string', text.slice(index, end))
      index = end
      continue
    }
    if (char >= '0' && char <= '9') {
      JS_NUMBER.lastIndex = index
      const match = JS_NUMBER.exec(text)
      if (match) {
        pushToken(tokens, 'number', match[0])
        index += match[0].length
        continue
      }
    }
    WORD.lastIndex = index
    const word = WORD.exec(text)
    if (word && word.index === index) {
      pushToken(tokens, JS_KEYWORDS.has(word[0]) ? 'literal' : 'plain', word[0])
      index += word[0].length
      continue
    }
    // 标识符之外（运算符、标点、缩进）逐字符累积，交给 plain 合并。
    pushToken(tokens, 'plain', char)
    index += 1
  }
}
