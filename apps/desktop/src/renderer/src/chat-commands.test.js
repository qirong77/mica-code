import { describe, expect, it } from 'bun:test'
import {
  SHARE_BLOCKED_COMMANDS,
  commandBlockedInShare,
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

  it('hides share-blocked commands from the palette only in share mode', () => {
    // 分享范围里 new/clear/resume/config/role 都会打到不被授权的 channel（或被服务端剥掉），
    // 连提示都不该出现；本机窗口保持原样。
    for (const name of SHARE_BLOCKED_COMMANDS) {
      expect(commandBlockedInShare(name)).toBe(true)
      const full = commandSuggestions(`/${name}`).map((command) => command.name)
      const share = commandSuggestions(`/${name}`, undefined, { shareMode: true }).map(
        (command) => command.name
      )
      expect(full).toContain(name)
      expect(share).not.toContain(name)
    }
  })

  it('keeps the commands a share link can actually drive', () => {
    for (const name of ['compact', 'rename', 'status', 'context', 'todo', 'help']) {
      expect(commandBlockedInShare(name)).toBe(false)
      expect(
        commandSuggestions(`/${name}`, undefined, { shareMode: true }).map((c) => c.name)
      ).toContain(name)
    }
  })
})
