import { describe, expect, it } from 'bun:test'
import { formatForDisplay, guessLanguage, highlightCode, normalizeLanguage } from './code-highlight'

function join(tokens) {
  return tokens.map((token) => token.text).join('')
}

function textOfType(tokens, type) {
  return tokens
    .filter((token) => token.type === type)
    .map((token) => token.text)
    .join('')
}

describe('normalizeLanguage', () => {
  it('maps the aliases we meet in fences and tool params', () => {
    expect(normalizeLanguage('JSON')).toBe('json')
    expect(normalizeLanguage('bash')).toBe('shell')
    expect(normalizeLanguage('console')).toBe('shell')
    expect(normalizeLanguage('patch')).toBe('diff')
    expect(normalizeLanguage('tsx')).toBe('js')
    expect(normalizeLanguage('kotlin')).toBe('text')
    expect(normalizeLanguage('')).toBe('text')
  })
})

describe('highlightCode', () => {
  it('never loses or reorders a character', () => {
    const samples = [
      ['json', '{\n  "a": 1,\n  "b": [true, null, "x"]\n}'],
      ['shell', 'cd /tmp && ls -la | head -3 # 看看\n$ echo "$HOME"'],
      ['diff', '@@ -1,2 +1,2 @@\n-old\n+new\n\\ No newline'],
      ['js', 'const a = `x${1}` // hi\nexport function f() { return 0x1f }'],
      ['log', '[stdout]\nexit_code: 0\n[warn] something']
    ]
    for (const [language, text] of samples) {
      expect(join(highlightCode(text, language))).toBe(text)
    }
  })

  it('separates json keys from string values', () => {
    const tokens = highlightCode('{"path": "/tmp/a", "n": 2, "ok": false}', 'json')
    expect(textOfType(tokens, 'key')).toBe('"path""n""ok"')
    expect(textOfType(tokens, 'string')).toBe('"/tmp/a"')
    expect(textOfType(tokens, 'number')).toBe('2')
    expect(textOfType(tokens, 'literal')).toBe('false')
  })

  it('stops an unterminated json string at the newline', () => {
    // 流式输出里字符串可能还没闭合，不能把后面几行一起染成字符串
    const tokens = highlightCode('{"a": "unfinished\n{"b": 1}', 'json')
    expect(join(tokens)).toBe('{"a": "unfinished\n{"b": 1}')
    expect(textOfType(tokens, 'key')).toBe('"a""b"')
  })

  it('marks the command, flags and operators of a shell line', () => {
    const tokens = highlightCode('cd /tmp && bunx prettier --check a.md 2>&1 | tail -3', 'shell')
    // 每条子命令的第一个词才是命令：`prettier` 是 bunx 的参数
    expect(textOfType(tokens, 'command')).toBe('cdbunxtail')
    expect(textOfType(tokens, 'flag')).toBe('--check')
    expect(textOfType(tokens, 'operator')).toBe('&&2>&1|')
  })

  it('colours shell strings, comments and variables', () => {
    const tokens = highlightCode(`echo "hi $USER" 'raw' # bye`, 'shell')
    // 单引号是字面量，双引号按 `$VAR` 切开
    expect(textOfType(tokens, 'string')).toBe('"hi "\'raw\'')
    expect(textOfType(tokens, 'comment')).toBe('# bye')
    expect(textOfType(tokens, 'variable')).toBe('$USER')
  })

  it('marks diff hunks and changed lines', () => {
    const text = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-keep\n+next'
    const tokens = highlightCode(text, 'diff')
    expect(textOfType(tokens, 'header')).toBe('--- a/x+++ b/x@@ -1 +1 @@')
    expect(textOfType(tokens, 'deleted')).toBe('-keep')
    expect(textOfType(tokens, 'inserted')).toBe('+next')
  })

  it('reads the structured stdout of run_shell', () => {
    const text = '[stdout]\nexit_code: 0\n[warn] slow\ncommand: "ls"'
    const tokens = highlightCode(text, 'log')
    expect(textOfType(tokens, 'header')).toBe('[stdout]')
    expect(textOfType(tokens, 'warn')).toBe('[warn]')
    expect(textOfType(tokens, 'key')).toBe('exit_codecommand')
    expect(textOfType(tokens, 'punct')).toBe('::')
  })

  it('leaves unknown languages untouched', () => {
    expect(highlightCode('a\nb', 'text')).toEqual([{ type: 'plain', text: 'a\nb' }])
    expect(highlightCode('', 'json')).toEqual([])
  })
})

describe('guessLanguage', () => {
  it('recognises json and diff payloads', () => {
    expect(guessLanguage('{"ok": true}')).toBe('json')
    expect(guessLanguage('[1, 2]\n')).toBe('json')
    expect(guessLanguage('diff --git a/x b/x\n@@ -1 +1 @@')).toBe('diff')
  })

  it('falls back to plain text', () => {
    expect(guessLanguage('total 8\ndrwxr-xr-x 2 me staff 64')).toBe('text')
    expect(guessLanguage('')).toBe('text')
  })
})

describe('formatForDisplay', () => {
  it('re-indents single-line json', () => {
    expect(formatForDisplay('{"a":1,"b":[true,null]}', 'json')).toBe(
      ['{', '  "a": 1,', '  "b": [', '    true,', '    null', '  ]', '}'].join('\n')
    )
  })

  it('keeps empty containers on one line', () => {
    expect(formatForDisplay('{"a":{},"b":[]}', 'json')).toBe(
      ['{', '  "a": {},', '  "b": []', '}'].join('\n')
    )
  })

  it('leaves numbers and escapes exactly as they were written', () => {
    const text = '{"id":14680088999999999999,"name":"caf\\u00e9","n":1e3}'
    const display = formatForDisplay(text, 'json')
    // JSON.parse + stringify 会把这些改掉，展示要保留原始字面量
    expect(display).toContain('14680088999999999999')
    expect(display).toContain('"caf\\u00e9"')
    expect(display).toContain('1e3')
    expect(JSON.parse(display)).toEqual({ id: 14680089000000000000, name: 'café', n: 1000 })
  })

  it('passes through invalid or truncated json', () => {
    expect(formatForDisplay('{"a": 1,', 'json')).toBe('{"a": 1,')
    expect(formatForDisplay('{a: 1}', 'json')).toBe('{a: 1}')
  })

  it('only touches json', () => {
    expect(formatForDisplay('{"a":1}', 'shell')).toBe('{"a":1}')
    expect(formatForDisplay('', 'json')).toBe('')
  })
})
