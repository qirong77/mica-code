import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('./FilesView.jsx', import.meta.url), 'utf8')
const openPathSource = source.slice(
  source.indexOf('  const openPath = useCallback('),
  source.indexOf('  const saveActive = useCallback(')
)
const editorOpenExpression = source.match(/const editorOpen = ([^\n]+)/)[1]

function navigation(info) {
  const state = { focusMode: true, mobileTreeVisible: false, rootOverride: null }
  const openedFiles = []
  const openPath = runInNewContext(`${openPathSource}\nopenPath`, {
    useCallback: (callback) => callback,
    openRequestRef: { current: 0 },
    root: '/workspace',
    window: { mica: { files: { stat: async () => info } } },
    setFocusMode: (value) => {
      state.focusMode = value
    },
    setMobileTreeVisible: (value) => {
      state.mobileTreeVisible = value
    },
    setRootOverride: (value) => {
      state.rootOverride = value
    },
    openFile: async (...args) => {
      openedFiles.push(args)
    }
  })
  return { state, openedFiles, openPath }
}

describe('FilesView mobile directory navigation', () => {
  for (const [name, tabs, showDiff] of [
    ['an existing file tab', [{}], false],
    ['an existing diff preview', [], true],
    ['file tabs and a diff preview', [{}], true]
  ]) {
    it(`shows the directory tree immediately with ${name}`, async () => {
      const { state, openedFiles, openPath } = navigation({
        ok: true,
        kind: 'directory',
        path: '/target'
      })

      await openPath('/target', null, { focus: true })

      expect(state.mobileTreeVisible).toBe(true)
      expect(state.focusMode).toBe(false)
      expect(state.rootOverride).toEqual({ base: '/workspace', path: '/target' })
      expect(openedFiles).toEqual([])
      expect(
        runInNewContext(editorOpenExpression, {
          isMobile: true,
          hasEditorContent: tabs.length > 0 || showDiff,
          mobileTreeVisible: state.mobileTreeVisible
        })
      ).toBe(false)
    })
  }

  it('keeps file opening delegated to openFile with its position and focus option', async () => {
    const { state, openedFiles, openPath } = navigation({
      ok: true,
      kind: 'file',
      path: '/target/file.js'
    })
    const position = { line: 12, column: 3 }

    await openPath('/target/file.js', position, { focus: true })

    expect(openedFiles).toEqual([['/target/file.js', position]])
    expect(state.focusMode).toBe(true)
    expect(state.mobileTreeVisible).toBe(false)
    expect(state.rootOverride).toBeNull()
  })
})
