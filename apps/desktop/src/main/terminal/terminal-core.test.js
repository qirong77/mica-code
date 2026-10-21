import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import {
  TerminalRequestError,
  appendOutput,
  keySequence,
  maskEchoedInput,
  normalizeCwd,
  normalizeKeys,
  normalizeMaxLines,
  normalizeSize,
  outputSince,
  readScreen
} from './terminal-core.js'

const { Terminal } = headless

function write(term, data) {
  return new Promise((resolve) => term.write(data, resolve))
}

describe('normalizeSize', () => {
  it('clamps to the supported pty range', () => {
    expect(normalizeSize({ cols: 1, rows: 1 })).toEqual({ cols: 20, rows: 5 })
    expect(normalizeSize({ cols: 9999, rows: 9999 })).toEqual({ cols: 400, rows: 200 })
    expect(normalizeSize({ cols: 100, rows: 40 })).toEqual({ cols: 100, rows: 40 })
  })

  it('falls back for missing or invalid values', () => {
    expect(normalizeSize({})).toEqual({ cols: 120, rows: 32 })
    expect(normalizeSize({ cols: 'abc', rows: 0 })).toEqual({ cols: 120, rows: 32 })
    expect(normalizeSize({ cols: '90' }, { cols: 80, rows: 24 })).toEqual({ cols: 90, rows: 24 })
  })
})

describe('normalizeCwd', () => {
  it('accepts trimmed paths and rejects garbage', () => {
    expect(normalizeCwd('  /tmp/demo  ')).toBe('/tmp/demo')
    expect(normalizeCwd('')).toBe('')
    expect(normalizeCwd(42)).toBe('')
    expect(normalizeCwd('/tmp/\0x')).toBe('')
  })
})

describe('keys', () => {
  it('maps named keys to terminal sequences', () => {
    expect(keySequence('Enter')).toBe('\r')
    expect(keySequence('ctrl+c')).toBe('\x03')
    expect(keySequence('ArrowUp')).toBe('\x1b[A')
    expect(keySequence('shift+tab')).toBe('\x1b[Z')
    expect(keySequence('y')).toBe('y')
  })

  it('rejects unknown combinations instead of silently dropping them', () => {
    expect(() => keySequence('hyper+x')).toThrow(TerminalRequestError)
    expect(() => normalizeKeys([])).toThrow(TerminalRequestError)
    expect(normalizeKeys(['down', 'Enter'])).toBe('\x1b[B\r')
  })
})

describe('screen snapshot', () => {
  it('reads the parsed screen and the current input line', async () => {
    const term = new Terminal({ cols: 40, rows: 10, scrollback: 100, allowProposedApi: true })
    await write(term, 'hello\r\n$ ls -la\r\nfile-a\r\nfile-b\r\n$ git sta')
    const screen = readScreen(term)
    expect(screen.text).toContain('file-a')
    expect(screen.text).toContain('file-b')
    expect(screen.text.endsWith('$ git sta')).toBe(true)
    expect(screen.inputLine).toBe('$ git sta')
    expect(screen.cursor.x).toBe('$ git sta'.length)
    expect(screen.cols).toBe(40)
    expect(screen.rows).toBe(10)
    term.dispose()
  })

  it('respects maxLines and keeps the cursor line', async () => {
    const term = new Terminal({ cols: 40, rows: 6, scrollback: 100, allowProposedApi: true })
    await write(term, 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\n$ ')
    const screen = readScreen(term, { maxLines: 2 })
    expect(screen.lines.length).toBeLessThanOrEqual(2)
    expect(screen.lines.at(-1)).toContain('$')
    expect(normalizeMaxLines(0)).toBe(200)
    expect(normalizeMaxLines(99999)).toBe(2000)
    term.dispose()
  })

  it('keeps content below the cursor instead of cutting at the cursor line', async () => {
    const term = new Terminal({ cols: 40, rows: 10, scrollback: 100, allowProposedApi: true })
    // 输出刷完后又把光标移回上面：屏幕底部的内容不能因为光标位置而丢失
    await write(term, 'head\r\nQ1\r\nQ2\r\nQ3\r\n')
    await write(term, '\x1b[2;1H')
    const screen = readScreen(term)
    expect(screen.text).toContain('Q1')
    expect(screen.text).toContain('Q3')
    expect(screen.cursor.y).toBe(1)
    term.dispose()
  })
})

describe('output buffer', () => {
  it('tracks seq and reports truncation', () => {
    let state = { seq: 0, data: '', truncated: false }
    state = appendOutput(state, 'abc', 10)
    state = appendOutput(state, 'def', 10)
    expect(state).toEqual({ seq: 6, data: 'abcdef', truncated: false })

    state = appendOutput(state, '0123456789', 10)
    expect(state.data).toBe('cdef0123456789'.slice(-10))
    expect(state.truncated).toBe(true)

    expect(outputSince(state, 0)).toMatchObject({ seq: 16, truncated: true })
    expect(outputSince(state, 16)).toEqual({ seq: 16, data: '', truncated: true })
    expect(outputSince(state, 12).data).toBe(state.data.slice(-4))
  })
})

describe('maskEchoedInput', () => {
  const now = 1_000_000

  it('drops the line that echoes what we typed', () => {
    const screen = '~ $ echo done\n\n~ $ '
    const result = maskEchoedInput(screen, [{ data: 'echo done\r', at: now }], { now })
    expect(result.text).not.toContain('echo done')
    expect(result.masked).toBe(1)
  })

  it('keeps real output that contains the marker', () => {
    const screen = '~ $ echo done\r\ndone\r\n~ $ '
    const result = maskEchoedInput(screen, [{ data: 'echo done\r', at: now }], { now })
    expect(result.text).toContain('done')
    expect(result.text).not.toContain('echo done')
  })

  it('only masks the first hit so identical output still matches', () => {
    // 输入是 `run.sh`，输出里也打印了一模一样的 `run.sh`：只遮回显那一行
    const screen = '~ $ run.sh\nrun.sh\nstarted\n'
    const result = maskEchoedInput(screen, [{ data: 'run.sh\r', at: now }], { now })
    expect(result.masked).toBe(1)
    expect(result.text).toBe('run.sh\nstarted\n')
  })

  it('masks the most recent echo when the same command runs twice', () => {
    // 第二次执行：第一次的回显还在滚动历史里，必须遮下面那条新的
    const screen = '~ $ git status\nclean\n~ $ git status\n\n~ $ '
    const result = maskEchoedInput(screen, [{ data: 'git status\r', at: now }], { now })
    expect(result.masked).toBe(1)
    expect(result.text).toBe('~ $ git status\nclean\n\n~ $ ')
  })

  it('masks echoed fragments left above the prompt line', () => {
    // 输入被打断成多行回显：碎片行与输入原文完全相同，且位于提示符行上方
    const screen = 'echo hi\necho hi\n~ $ echo hi\nhi'
    const result = maskEchoedInput(screen, [{ data: 'echo hi\r', at: now }], { now })
    expect(result.masked).toBe(3)
    expect(result.text).toBe('hi')
  })

  it('treats each line of a pasted multi-line script as its own echo', () => {
    const screen = '~ $ echo a\necho b\n~ $ echo a\necho b\nb\n~ $ '
    const result = maskEchoedInput(screen, [{ data: 'echo a\necho b\r', at: now }], { now })
    expect(result.masked).toBe(2)
    expect(result.text).toContain('b\n~ $ ')
  })

  it('ignores inputs outside the window and very short ones', () => {
    const screen = '~ $ ls\n'
    expect(maskEchoedInput(screen, [{ data: 'ls', at: now - 60_000 }], { now }).masked).toBe(0)
    expect(maskEchoedInput(screen, [{ data: 'x', at: now }], { now }).masked).toBe(0)
    expect(maskEchoedInput(screen, [], { now })).toEqual({ text: screen, masked: 0 })
  })
})
