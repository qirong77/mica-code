import { describe, expect, it } from 'bun:test'
import { TERMINAL_KEYS, readClipboardText, softKeyboardFallbackKey } from './terminal-keys'

const keydown = (overrides) => ({ type: 'keydown', keyCode: 0, key: '', ...overrides })

describe('TERMINAL_KEYS', () => {
  it('covers the keys a soft keyboard cannot produce', () => {
    const ids = TERMINAL_KEYS.map((key) => key.id)
    for (const id of [
      'esc',
      'tab',
      'ctrl-c',
      'ctrl-d',
      'up',
      'down',
      'left',
      'right',
      'ctrl-a',
      'ctrl-e',
      'ctrl-u'
    ]) {
      expect(ids).toContain(id)
    }
  })

  it('sends the same sequences as the desktop modifier mapping', () => {
    const byId = new Map(TERMINAL_KEYS.map((key) => [key.id, key.data]))
    expect(byId.get('esc')).toBe('\x1b')
    expect(byId.get('tab')).toBe('\t')
    expect(byId.get('ctrl-c')).toBe('\x03')
    expect(byId.get('ctrl-d')).toBe('\x04')
    expect(byId.get('up')).toBe('\x1b[A')
    expect(byId.get('down')).toBe('\x1b[B')
    expect(byId.get('left')).toBe('\x1b[D')
    expect(byId.get('right')).toBe('\x1b[C')
  })

  it('moves the caret with the readline bindings the desktop app already maps', () => {
    const byId = new Map(TERMINAL_KEYS.map((key) => [key.id, key.data]))
    expect(byId.get('ctrl-a')).toBe('\x01')
    expect(byId.get('ctrl-e')).toBe('\x05')
    expect(byId.get('ctrl-u')).toBe('\x15')
  })

  it('sends literal characters for the symbol keys', () => {
    const byId = new Map(TERMINAL_KEYS.map((key) => [key.id, key.data]))
    expect(byId.get('pipe')).toBe('|')
    expect(byId.get('dash')).toBe('-')
    expect(byId.get('slash')).toBe('/')
    expect(byId.get('tilde')).toBe('~')
  })

  it('keeps ids and labels unique so React keys and hit targets stay stable', () => {
    const ids = TERMINAL_KEYS.map((key) => key.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const key of TERMINAL_KEYS) {
      expect(key.label.length).toBeGreaterThan(0)
      expect(key.data.length).toBeGreaterThan(0)
      expect(key.title.length).toBeGreaterThan(0)
    }
  })
})

describe('softKeyboardFallbackKey', () => {
  it('re-sends the space that xterm drops on soft keyboards', () => {
    expect(softKeyboardFallbackKey(keydown({ key: ' ', keyCode: 32 }))).toBe(' ')
  })

  it('re-sends A-Z, which xterm defers to a keypress mobile browsers never fire', () => {
    expect(softKeyboardFallbackKey(keydown({ key: 'A', keyCode: 65 }))).toBe('A')
    expect(softKeyboardFallbackKey(keydown({ key: 'Z', keyCode: 90, shiftKey: true }))).toBe('Z')
  })

  it('leaves lowercase, digits, enter and the modifier combos to xterm', () => {
    expect(softKeyboardFallbackKey(keydown({ key: 'a', keyCode: 65 }))).toBeNull()
    expect(softKeyboardFallbackKey(keydown({ key: '5', keyCode: 53 }))).toBeNull()
    expect(softKeyboardFallbackKey(keydown({ key: 'Enter', keyCode: 13 }))).toBeNull()
    expect(softKeyboardFallbackKey(keydown({ key: ' ', keyCode: 32, ctrlKey: true }))).toBeNull()
    expect(softKeyboardFallbackKey(keydown({ key: 'A', keyCode: 65, altKey: true }))).toBeNull()
    expect(softKeyboardFallbackKey(keydown({ key: 'A', keyCode: 65, metaKey: true }))).toBeNull()
  })

  it('never swallows the Android IME composition keydown', () => {
    expect(softKeyboardFallbackKey(keydown({ key: 'Unidentified', keyCode: 229 }))).toBeNull()
    expect(softKeyboardFallbackKey(keydown({ key: 'Unidentified', keyCode: 0 }))).toBeNull()
    expect(softKeyboardFallbackKey(keydown({ key: ' ', keyCode: 229 }))).toBeNull()
  })

  it('ignores everything that is not a keydown', () => {
    expect(softKeyboardFallbackKey({ type: 'keypress', key: ' ', keyCode: 32 })).toBeNull()
    expect(softKeyboardFallbackKey(null)).toBeNull()
  })
})

describe('readClipboardText', () => {
  it('returns null when the clipboard API is missing (http LAN is not a secure context)', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined })
    try {
      expect(await readClipboardText()).toBeNull()
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original)
      else delete globalThis.navigator
    }
  })

  it('returns null instead of throwing when the read is denied', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { readText: () => Promise.reject(new Error('denied')) } }
    })
    try {
      expect(await readClipboardText()).toBeNull()
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original)
      else delete globalThis.navigator
    }
  })

  it('returns null for an empty clipboard and the text otherwise', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    try {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { clipboard: { readText: async () => '' } }
      })
      expect(await readClipboardText()).toBeNull()

      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { clipboard: { readText: async () => 'ls -la\n' } }
      })
      expect(await readClipboardText()).toBe('ls -la\n')
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original)
      else delete globalThis.navigator
    }
  })
})
