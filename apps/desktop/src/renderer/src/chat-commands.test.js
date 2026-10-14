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
    expect(findChatCommand('role').availability).toBe('chat')
    expect(findChatCommand('compact').availability).toBe('chat')
    expect(findChatCommand('rewind').availability).toBe('terminal')
    expect(commandInputValue(findChatCommand('rename'))).toBe('/rename ')
  })

  it('ranks exact prefix matches above fuzzy description matches', () => {
    const names = commandSuggestions('/ren').map((command) => command.name)
    expect(names[0]).toBe('rename')
    const role = commandSuggestions('/rol').map((command) => command.name)
    expect(role).toContain('role')
  })

  it('offers every command to every client', () => {
    // 每个客户端都是完整客户端（没有受限访客），命令面板不下沉任何命令。
    for (const name of ['compact', 'rename', 'status', 'context', 'todo', 'help', 'new', 'clear']) {
      expect(commandSuggestions(`/${name}`).map((c) => c.name)).toContain(name)
    }
  })
})
