import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const cases = [
  ['./ChatFind.jsx', 3],
  ['./GitComparePanel.jsx', 9],
  ['./FilesView.jsx', 9],
  ['./BtwDrawer.jsx', 5],
  ['./FileSidePanels.jsx', 4],
  ['./EditorTerminal.jsx', 3],
  ['./chat-modal.jsx', 2],
  ['./Popover.jsx', 1],
  ['./GitComparePicker.jsx', 1],
  ['./ShareIndex.jsx', 4],
  ['./GitReviewTabs.jsx', 2],
  ['./SessionQuickOpen.jsx', 1],
  ['./CwdPicker.jsx', 1],
  ['./GitDiffEditor.jsx', 8],
  ['../../../../../plugins/global-search/desktop.jsx', 2]
]

const icon = '<(?:Icon(?:[A-Z]\\w*)?|Settings2|X)\\b[^<>]*\\/>'
const iconChildren = new RegExp(
  `^\\s*(?:${icon}|\\{[^<>]*\\?\\s*${icon}\\s*:\\s*${icon}\\s*\\})\\s*$`
)

function childrenOf(action) {
  let braces = 0
  let quote = null
  for (let index = 0; index < action.length; index += 1) {
    const char = action[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char
    } else if (char === '{') {
      braces += 1
    } else if (char === '}') {
      braces -= 1
    } else if (char === '>' && braces === 0) {
      return action.slice(index + 1, action.lastIndexOf('</'))
    }
  }
  throw new Error(`Missing action children: ${action}`)
}

describe('Arco icon-only action declarations', () => {
  for (const [path, count] of cases) {
    test(`${path} marks only pure icon actions`, () => {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      const actions = Array.from(
        source.matchAll(/<(ArcoAction|Action)\b[\s\S]*?<\/\1>/g),
        ([action]) => action
      )
      let icons = 0
      for (const action of actions) {
        const iconOnly = iconChildren.test(childrenOf(action))
        expect({ action, marked: /\siconOnly(?:\s|>)/.test(action) }).toEqual({ action, marked: iconOnly })
        if (iconOnly) icons += 1
      }
      expect(icons).toBe(count)
    })
  }

  test('GitDiffEditor keeps the mixed Action wrapper opt-in', () => {
    const source = readFileSync(new URL('./GitDiffEditor.jsx', import.meta.url), 'utf8')
    const wrapper = source.slice(source.indexOf('function Action('), source.indexOf('/** Loaded only'))
    expect(wrapper).not.toContain('iconOnly')
    expect(wrapper).toContain('{...props}')
  })
})
