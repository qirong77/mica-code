import { describe, expect, it } from 'bun:test'
import {
  TOOL_OUTPUT_MAX_CHARS,
  toolCallText,
  toolDisplayName,
  toolDurationMs,
  toolOutput,
  toolSummary
} from './chat-tool-display'

describe('toolDisplayName', () => {
  it('labels Agent variants', () => {
    expect(toolDisplayName({ tool: 'Agent', input: {} })).toBe('Subagent')
    expect(toolDisplayName({ tool: 'Agent', input: { operation: 'run_many' } })).toBe('Subagents')
    expect(toolDisplayName({ tool: 'Agent', input: { operation: 'read' } })).toBe('Subagent · read')
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
