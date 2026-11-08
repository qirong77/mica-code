import { describe, expect, test } from 'bun:test'
import { isDevToolsShortcut } from './devtools-shortcut.js'

function keydown(over = {}) {
  return { type: 'keyDown', key: 'i', code: 'KeyI', ...over }
}

describe('isDevToolsShortcut', () => {
  test('macOS 上 ⌥⌘I 命中', () => {
    expect(isDevToolsShortcut(keydown({ meta: true, alt: true }), 'darwin')).toBe(true)
  })

  test('⌥ 把字符变成死键产物时按物理键位也认', () => {
    expect(isDevToolsShortcut(keydown({ key: 'ˆ', meta: true, alt: true }), 'darwin')).toBe(true)
  })

  test('Windows / Linux 用 Ctrl+Alt+I', () => {
    expect(isDevToolsShortcut(keydown({ control: true, alt: true }), 'win32')).toBe(true)
    expect(isDevToolsShortcut(keydown({ meta: true, alt: true }), 'linux')).toBe(false)
  })

  test('缺了 ⌥ 或主修饰键都不算', () => {
    expect(isDevToolsShortcut(keydown({ meta: true }), 'darwin')).toBe(false)
    expect(isDevToolsShortcut(keydown({ alt: true }), 'darwin')).toBe(false)
  })

  test('带 shift、非 keyDown、连发、别的键都不算', () => {
    expect(isDevToolsShortcut(keydown({ meta: true, alt: true, shift: true }), 'darwin')).toBe(false)
    expect(isDevToolsShortcut(keydown({ type: 'keyUp', meta: true, alt: true }), 'darwin')).toBe(false)
    expect(isDevToolsShortcut(keydown({ meta: true, alt: true, isAutoRepeat: true }), 'darwin')).toBe(
      false
    )
    expect(
      isDevToolsShortcut(keydown({ key: 'o', code: 'KeyO', meta: true, alt: true }), 'darwin')
    ).toBe(false)
  })

  test('没有 code 时退回 key', () => {
    expect(isDevToolsShortcut(keydown({ code: '', meta: true, alt: true }), 'darwin')).toBe(true)
    expect(isDevToolsShortcut(keydown({ code: '', key: 'I', meta: true, alt: true }), 'darwin')).toBe(
      true
    )
    expect(isDevToolsShortcut(keydown({ code: '', key: 'ˆ', meta: true, alt: true }), 'darwin')).toBe(
      false
    )
  })
})
