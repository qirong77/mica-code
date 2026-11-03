import { describe, expect, it } from 'bun:test'
import {
  parseToolArgs,
  TOOL_OUTPUT_MAX_CHARS,
  toolCallText,
  toolDisplayName,
  toolDurationMs,
  toolOutput,
  toolStepSummary,
  toolSummary,
  turnLogHeadSummary
} from './chat-tool-display'

describe('parseToolArgs', () => {
  it('parses an object argument payload', () => {
    expect(parseToolArgs('{"file_path":"/tmp/a.txt"}')).toEqual({ file_path: '/tmp/a.txt' })
  })

  it('falls back to an empty object for partial or non-object payloads', () => {
    expect(parseToolArgs('{"file_path":"/tmp/a.t')).toEqual({})
    expect(parseToolArgs('[1,2]')).toEqual({})
    expect(parseToolArgs('ls -la')).toEqual({})
    expect(parseToolArgs(null)).toEqual({})
  })
})

describe('toolStepSummary', () => {
  it('reuses the call summary rules for raw JSON arguments', () => {
    expect(toolStepSummary('read_file', '{"file_path":"/tmp/a.txt","limit":20}')).toBe('/tmp/a.txt')
    expect(toolStepSummary('grep_search', '{"pattern":"foo","path":"src"}')).toBe('foo · src')
    expect(toolStepSummary('read_file', '{"file_path":"/tmp/a.t')).toBe('')
  })
})

describe('toolDisplayName', () => {
  it('labels Agent variants', () => {
    expect(toolDisplayName({ tool: 'agent', input: {} })).toBe('Subagent')
    expect(toolDisplayName({ tool: 'agent', input: { operation: 'run_many' } })).toBe('Subagents')
    expect(toolDisplayName({ tool: 'agent', input: { operation: 'read' } })).toBe('Subagent · read')
  })

  it('falls back to the shared tool label', () => {
    expect(toolDisplayName({ tool: 'run_shell' })).toBe('Shell')
  })
})

describe('toolCallText', () => {
  it('prefers the host displayText', () => {
    expect(toolCallText({ tool: 'run_shell', displayText: '$ ls -la', input: {} })).toBe('$ ls -la')
  })

  it('keeps the full command instead of the CLI-truncated form', () => {
    const command =
      'cd /Users/qironglin/Desktop/qirong-application && LINKCORE_GOMEMONITOR_TOKEN=xxx pnpm build'
    expect(toolCallText({ tool: 'run_shell', input: { command } })).toBe(`Shell ${command}`)
  })

  it('preserves newlines in multi-line shell commands', () => {
    const command = 'cd /tmp\nls -la\necho done'
    expect(toolSummary({ tool: 'run_shell', input: { command } })).toBe(command)
    expect(toolCallText({ tool: 'run_shell', input: { command } })).toContain('ls -la\necho done')
  })

  it('summarizes patch targets', () => {
    expect(
      toolCallText({
        tool: 'apply_patch',
        input: { patch: '*** Begin Patch\n*** Update File: src/a.ts\n' }
      })
    ).toBe('Apply patch src/a.ts')
  })
})

describe('toolOutput', () => {
  it('returns null without output', () => {
    expect(toolOutput({ tool: 'run_shell' })).toBeNull()
    expect(toolOutput({ tool: 'run_shell', output: '   \n' })).toBeNull()
  })

  it('drops the trailing newline and splits lines', () => {
    expect(toolOutput({ tool: 'run_shell', output: 'a\nb\n' }).lines).toEqual(['a', 'b'])
  })

  it('caps very long output', () => {
    const output = 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 10)
    const result = toolOutput({ tool: 'run_shell', output })
    expect(result.capped).toBe(true)
    expect(result.lines.join('').length).toBe(TOOL_OUTPUT_MAX_CHARS)
  })
})

describe('toolDurationMs', () => {
  it('uses the finish time for settled calls', () => {
    const tool = { status: 'completed', startedAt: 1_000, finishedAt: 3_500 }
    expect(toolDurationMs(tool, 90_000)).toBe(2_500)
  })

  it('uses now for the running call', () => {
    const tool = { status: 'running', startedAt: 1_000 }
    expect(toolDurationMs(tool, 4_000)).toBe(3_000)
  })
})

describe('turnLogHeadSummary', () => {
  it('returns null when there is nothing to summarize', () => {
    expect(turnLogHeadSummary([])).toBeNull()
    expect(turnLogHeadSummary(null)).toBeNull()
  })

  it('quotes the latest tool row verbatim and counts the items', () => {
    const summary = turnLogHeadSummary(
      [
        { kind: 'reasoning', text: '先看看这两条 resizer', startedAt: 1_000 },
        {
          kind: 'tool',
          tool: { tool: 'read_file', input: { file_path: 'src/a.css' }, startedAt: 5_000 }
        }
      ],
      13_000
    )
    expect(summary).toEqual({ steps: 2, doing: 'Read file src/a.css', elapsedMs: 12_000 })
  })

  it('falls back to the first line of the latest thinking', () => {
    const summary = turnLogHeadSummary(
      [{ kind: 'reasoning', text: '\n  用户问的是空白\n第二行', startedAt: 1_000 }],
      2_500
    )
    expect(summary.doing).toBe('用户问的是空白')
    expect(summary.elapsedMs).toBe(1_500)
  })

  it('leaves the elapsed time out when no row carries a timestamp', () => {
    const summary = turnLogHeadSummary([{ kind: 'reasoning', text: 'no clock' }], 9_000)
    expect(summary.elapsedMs).toBeNull()
  })

  it('caps a very long line', () => {
    const summary = turnLogHeadSummary(
      [{ kind: 'reasoning', text: 'x'.repeat(400), startedAt: 0 }],
      1
    )
    expect(summary.doing.length).toBe(120)
    expect(summary.doing.endsWith('…')).toBe(true)
  })
})
