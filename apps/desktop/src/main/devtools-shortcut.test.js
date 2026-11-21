import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { attachDevToolsShortcut, isDevToolsShortcut, toggleDevTools } from './devtools-shortcut.js'

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

/** 假 webContents：只实现快捷键那条链路用到的方法。 */
function fakeContents({ type = 'window', opened = false } = {}) {
  const contents = new EventEmitter()
  let devtoolsOpen = opened
  contents.type = type
  contents.opened = []
  contents.closed = 0
  contents.isDestroyed = () => false
  contents.getType = () => contents.type
  contents.isDevToolsOpened = () => devtoolsOpen
  contents.openDevTools = (options) => {
    devtoolsOpen = true
    contents.opened.push(options)
  }
  contents.closeDevTools = () => {
    devtoolsOpen = false
    contents.closed += 1
  }
  return contents
}

function press(contents, input) {
  let prevented = false
  contents.emit('before-input-event', { preventDefault: () => (prevented = true) }, input)
  return prevented
}

describe('toggleDevTools', () => {
  test('开在独立窗口，再按一次关掉', () => {
    const contents = fakeContents()
    toggleDevTools(contents)
    expect(contents.opened).toEqual([{ mode: 'detach', activate: true }])
    toggleDevTools(contents)
    expect(contents.closed).toBe(1)
  })
})

describe('attachDevToolsShortcut', () => {
  test('任何 webContents 上按 ⌥⌘I 都能开，并吃掉事件', () => {
    for (const type of ['window', 'webview', 'browserView']) {
      const contents = fakeContents({ type })
      attachDevToolsShortcut(contents, 'darwin')
      expect(press(contents, keydown({ meta: true, alt: true }))).toBe(true)
      expect(contents.opened).toHaveLength(1)
    }
  })

  test('别的键不拦', () => {
    const contents = fakeContents()
    attachDevToolsShortcut(contents, 'darwin')
    expect(press(contents, keydown({ meta: true }))).toBe(false)
    expect(contents.opened).toHaveLength(0)
  })

  test('DevTools 自己的 webContents 跳过', () => {
    const contents = fakeContents({ type: 'remote' })
    attachDevToolsShortcut(contents, 'darwin')
    expect(press(contents, keydown({ meta: true, alt: true }))).toBe(false)
    expect(contents.opened).toHaveLength(0)
  })

  test('重复挂不会一次按键开了又关', () => {
    const contents = fakeContents()
    attachDevToolsShortcut(contents, 'darwin')
    attachDevToolsShortcut(contents, 'darwin')
    press(contents, keydown({ meta: true, alt: true }))
    expect(contents.opened).toHaveLength(1)
    expect(contents.closed).toBe(0)
  })

  test('解除后不再响应', () => {
    const contents = fakeContents()
    const detach = attachDevToolsShortcut(contents, 'darwin')
    detach()
    expect(press(contents, keydown({ meta: true, alt: true }))).toBe(false)
    expect(contents.opened).toHaveLength(0)
  })
})
