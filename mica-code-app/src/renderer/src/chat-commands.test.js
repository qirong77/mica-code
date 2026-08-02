import { describe, expect, it } from 'bun:test'
import {
  commandInputValue,
  commandSuggestions,
  findChatCommand,
  parseSlashCommand
} from './chat-commands'

describe('chat slash commands', () => {
  it('parses command names and arguments without treating ordinary text as a command', () => {
    expect(parseSlashCommand(' /rename  Web session ')).toEqual({
      name: 'rename',
      args: 'Web session',
      raw: '/rename  Web session'
    })
    expect(parseSlashCommand('explain /status')).toBeNull()
  })

  it('filters the inline palette only while editing a command name', () => {
    expect(commandSuggestions('/ren').map((command) => command.name)).toContain('rename')
    expect(commandSuggestions('/rename title')).toEqual([])
    expect(commandSuggestions('rename')).toEqual([])
  })

  it('marks selector-heavy commands as available in chat with runtime overrides', () => {
    expect(findChatCommand('status').availability).toBe('chat')
    expect(findChatCommand('model').availability).toBe('chat')
    expect(findChatCommand('effort').availability).toBe('chat')
    expect(findChatCommand('role').availability).toBe('chat')
    expect(findChatCommand('compact').availability).toBe('chat')
    expect(findChatCommand('rewind').availability).toBe('terminal')
    expect(commandInputValue(findChatCommand('rename'))).toBe('/rename ')
  })

  it('ranks exact prefix matches above fuzzy description matches', () => {
    const names = commandSuggestions('/mo').map((command) => command.name)
    expect(names[0]).toBe('model')
    const effort = commandSuggestions('/eff').map((command) => command.name)
    expect(effort).toContain('effort')
  })
})
