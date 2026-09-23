import { describe, expect, it } from 'bun:test'
import {
  TOOL_OUTPUT_MAX_CHARS,
  collapsedOutput,
  toolCallText,
  toolDisplayName,
  toolOutput,
  toolSummary
} from './chat-tool-display'

describe('toolDisplayName', () => {
  it('labels Agent variants', () => {
    expect(toolDisplayName({ tool: 'Agent', input: {} })).toBe('Subagent')
    expect(toolDisplayName({ tool: 'Agent', input: { operation: 'run_many' } })).toBe('Subagents')
    expect(toolDisplayName({ tool: 'Agent', input: { operation: 'read' } })).toBe(
      'Subagent · read'
    )
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

describe('collapsedOutput', () => {
  it('keeps the tail of long output', () => {
    const output = Array.from({ length: 25 }, (_, index) => `line-${index}`).join('\n')
    const collapsed = collapsedOutput(toolOutput({ tool: 'run_shell', output }))
    expect(collapsed.lines).toEqual([
      'line-15',
      'line-16',
      'line-17',
      'line-18',
      'line-19',
      'line-20',
      'line-21',
      'line-22',
      'line-23',
      'line-24'
    ])
    expect(collapsed.hidden).toBe(15)
  })

  it('keeps short output untouched', () => {
    const collapsed = collapsedOutput(toolOutput({ tool: 'run_shell', output: 'a\nb' }))
    expect(collapsed).toEqual({ lines: ['a', 'b'], hidden: 0, capped: false })
    expect(collapsedOutput(null)).toBeNull()
  })
})
