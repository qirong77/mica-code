import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_EDITOR_TERMINAL_HEIGHT,
  MIN_EDITOR_TERMINAL_HEIGHT,
  activeTabAfterClose,
  clampEditorTerminalHeight,
  closeTabConfirmText,
  closeWindowConfirmText,
  describeRunningCommand,
  editorTerminalHeightLimit,
  folderNameOf,
  isTerminalToggleShortcut,
  runningCommandsLabel,
  terminalTabTitle
} from './editor-terminal'

function keydown(overrides = {}) {
  return {
    code: 'Backquote',
    key: '`',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}

describe('isTerminalToggleShortcut', () => {
  it('recognises Ctrl+` on every keyboard layout', () => {
    expect(isTerminalToggleShortcut(keydown({ ctrlKey: true }))).toBe(true)
  })

  it('ignores ⌘` (macOS cycles windows with it), Alt and Shift variants', () => {
    expect(isTerminalToggleShortcut(keydown({ metaKey: true }))).toBe(false)
    expect(isTerminalToggleShortcut(keydown({ ctrlKey: true, metaKey: true }))).toBe(false)
    expect(isTerminalToggleShortcut(keydown({ ctrlKey: true, altKey: true }))).toBe(false)
    expect(isTerminalToggleShortcut(keydown({ ctrlKey: true, shiftKey: true }))).toBe(false)
  })

  it('ignores other keys, auto-repeat and empty events', () => {
    expect(isTerminalToggleShortcut(keydown({ ctrlKey: true, code: 'KeyT' }))).toBe(false)
    expect(isTerminalToggleShortcut(keydown({ ctrlKey: true, repeat: true }))).toBe(false)
    expect(isTerminalToggleShortcut(null)).toBe(false)
  })
})

describe('clampEditorTerminalHeight', () => {
  it('falls back to the default when nothing usable was saved', () => {
    for (const value of [undefined, null, '', 0, -10, Number.NaN, 'oops']) {
      expect(clampEditorTerminalHeight(value, 900)).toBe(DEFAULT_EDITOR_TERMINAL_HEIGHT)
    }
  })

  it('keeps the saved height inside the panel bounds', () => {
    expect(clampEditorTerminalHeight(320, 900)).toBe(320)
    expect(clampEditorTerminalHeight(20, 900)).toBe(MIN_EDITOR_TERMINAL_HEIGHT)
    expect(clampEditorTerminalHeight(2000, 900)).toBe(Math.round(900 * 0.75))
  })

  it('has no upper bound when the viewport is unknown', () => {
    expect(editorTerminalHeightLimit(0)).toBe(Infinity)
    expect(clampEditorTerminalHeight(5000, 0)).toBe(5000)
  })
})

describe('folderNameOf', () => {
  it('takes the last segment and tolerates trailing slashes and Windows paths', () => {
    expect(folderNameOf('/Users/me/mica-code')).toBe('mica-code')
    expect(folderNameOf('/Users/me/mica-code/')).toBe('mica-code')
    expect(folderNameOf('C:\\Users\\me\\mica-code')).toBe('mica-code')
    expect(folderNameOf('/')).toBe('')
    expect(folderNameOf(null)).toBe('')
  })
})

describe('terminalTabTitle', () => {
  it('names the tab after the folder it opens in', () => {
    expect(terminalTabTitle([], '/Users/me/mica-code')).toBe('mica-code')
  })

  it('numbers a second terminal in the same folder instead of duplicating the title', () => {
    const tabs = [{ title: 'mica-code' }]
    expect(terminalTabTitle(tabs, '/Users/me/mica-code')).toBe('mica-code (2)')
    expect(terminalTabTitle([...tabs, { title: 'mica-code (2)' }], '/Users/me/mica-code')).toBe(
      'mica-code (3)'
    )
  })

  it('falls back to numbered terminals when there is no folder yet', () => {
    expect(terminalTabTitle([], null)).toBe('终端 1')
    expect(terminalTabTitle([{ title: '终端 1' }], null)).toBe('终端 2')
    expect(terminalTabTitle([{ title: '终端 2' }, { title: 'a' }], '')).toBe('终端 3')
  })
})

describe('activeTabAfterClose', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('hands over to the right neighbour, then to the left one', () => {
    expect(activeTabAfterClose(tabs, 'a')).toBe('b')
    expect(activeTabAfterClose(tabs, 'c')).toBe('b')
  })

  it('returns null when the last tab goes away or the id is unknown', () => {
    expect(activeTabAfterClose([{ id: 'a' }], 'a')).toBe(null)
    expect(activeTabAfterClose(tabs, 'missing')).toBe(null)
    expect(activeTabAfterClose(null, 'a')).toBe(null)
  })
})

describe('describeRunningCommand', () => {
  it('keeps the command name and its first arguments, not the full path', () => {
    expect(describeRunningCommand('/opt/homebrew/bin/node /repo/scripts/dev.mjs --watch')).toBe(
      'node /repo/scripts/dev.mjs --watch'
    )
  })

  it('keeps the first line of a multi-line command and truncates long ones', () => {
    expect(describeRunningCommand('npm\nrun dev')).toBe('npm')
    expect(describeRunningCommand('  npm   run   dev  ')).toBe('npm run dev')
    const long = describeRunningCommand(`npm run ${'x'.repeat(120)}`)
    expect(long.length).toBe(48)
    expect(long.endsWith('…')).toBe(true)
  })

  it('returns an empty label when ps said nothing', () => {
    expect(describeRunningCommand('')).toBe('')
    expect(describeRunningCommand(undefined)).toBe('')
  })
})

describe('runningCommandsLabel', () => {
  it('de-duplicates and caps the listed commands', () => {
    expect(
      runningCommandsLabel([
        { command: 'npm run dev' },
        { command: 'npm run dev' },
        { command: 'vim notes.md' }
      ])
    ).toBe('npm run dev、vim notes.md')
    expect(
      runningCommandsLabel([{ command: 'a' }, { command: 'b' }, { command: 'c' }, { command: 'd' }])
    ).toBe('a、b、c 等')
  })

  it('says nothing when there is nothing to name', () => {
    expect(runningCommandsLabel([])).toBe('')
    expect(runningCommandsLabel([{ command: '' }])).toBe('')
  })
})

describe('close confirmations', () => {
  it('names the running command and the scope of the window close', () => {
    const text = closeWindowConfirmText([{ command: 'npm run dev' }, { command: 'vim a.md' }])
    expect(text).toContain('2 个终端')
    expect(text).toContain('npm run dev')
    expect(text).toContain('vim a.md')
  })

  it('still asks when the foreground command is unknown', () => {
    expect(closeWindowConfirmText([{ command: '' }])).toContain('还有程序在运行')
    expect(closeTabConfirmText({ title: 'mica-code', command: '' })).toContain('「mica-code」')
  })
})
