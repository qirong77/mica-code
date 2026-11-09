import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from '@babel/parser'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const chat = read('./ChatView.jsx')
const css = read('../assets/app.css')
const panels = read('./PluginPanels.jsx')

describe('composer presentation', () => {
  test('anchors picker and completion inside the composer rather than the task dock', () => {
    const file = parse(chat, { sourceType: 'module', plugins: ['jsx'] })
    const parents = {}
    const visit = (node, inComposer = false) => {
      if (!node || typeof node !== 'object') return
      const composer = node.type === 'JSXElement' && node.openingElement.attributes.some(
        (prop) => prop.type === 'JSXAttribute' && prop.name.name === 'className' &&
          chat.slice(prop.value?.start, prop.value?.end).includes('chat-composer ${running')
      )
      if (node.type === 'JSXOpeningElement' && ['SelectPalette', 'ComposerCompletionPalette'].includes(node.name.name)) {
        parents[node.name.name] = inComposer
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach((value) => visit(value, inComposer || composer))
        else if (child && typeof child === 'object') visit(child, inComposer || composer)
      }
    }
    visit(file)
    expect(parents).toEqual({ SelectPalette: true, ComposerCompletionPalette: true })
  })

  test('keeps quick buttons inset like composer image attachments', () => {
    expect(css.match(/\.chat-plugin-quickbar\s*\{([^}]+)\}/)?.[1]).toContain('padding: 6px 8px')
    expect(css.match(/\.chat-composer-images\s*\{([^}]+)\}/)?.[1]).toContain('padding: 5px 8px 0')
  })

  test('uses Arco Popover for previews without the old shell and nested settings theme', () => {
    const preview = panels.slice(panels.indexOf('export function QuickbarPreview'), panels.indexOf('export function PluginQuickBar'))
    expect(preview).toContain('<ArcoPopover')
    expect(preview).toContain('popupVisible')
    expect(preview).toContain('position="tl"')
    expect(preview).toContain('<ArcoAction')
    expect(preview).not.toContain('mica-config-ui is-embed')
    expect(preview).not.toContain('useLayoutEffect')
    expect(css).not.toMatch(/\.chat-plugin-quickbar-preview\s*\{/)
    expect(css.match(/\.chat-plugin-quickbar-preview-content\s*\{([^}]+)\}/)?.[1]).not.toMatch(/box-shadow|background|border-radius/)
  })

  test('search input and both search actions use the same 28px height', () => {
    const source = read('./SessionTree.jsx')
    const toolbar = source.slice(source.indexOf('<div className="flex h-7 items-center gap-1.5">'), source.indexOf('{filterOpen && !searching'))
    expect(toolbar).toContain('height={28}')
    expect(toolbar.match(/width: 28, height: 28/g)).toHaveLength(2)
    expect(toolbar.match(/\siconOnly\s/g)).toHaveLength(2)
  })
})
