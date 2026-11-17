import {CodeNode} from '@lexical/code'
import {createHeadlessEditor} from '@lexical/headless'
import {LinkNode} from '@lexical/link'
import {ListItemNode, ListNode} from '@lexical/list'
import {TRANSFORMERS} from '@lexical/markdown'
import {HeadingNode, QuoteNode} from '@lexical/rich-text'
import {$createParagraphNode, $createTextNode, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, PASTE_COMMAND, type LexicalEditor} from 'lexical'
import {describe, expect, it, vi} from 'vitest'
import {applyMarkdownPaste, isMarkdownPasteIntact, plainPasteText, registerMarkdownPaste, splitPlainParagraphs, type MarkdownPasteSpan} from '../src/playground/plugins/MarkdownPastePlugin/markdownPaste'

const NODES = [CodeNode, HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode]

type Harness = {editor: LexicalEditor; spans: MarkdownPasteSpan[]}

function createHarness(): Harness {
  const spans: MarkdownPasteSpan[] = []
  const editor = createHeadlessEditor({namespace: 'markdown-paste-prompt', nodes: NODES, onError(error) { throw error }})
  registerMarkdownPaste(editor, TRANSFORMERS, span => spans.push(span))
  return {editor, spans}
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

// Types one paragraph into an empty document and puts the caret inside it, the
// way a reader clicks into prose before pasting.
function seed(editor: LexicalEditor, text = '', offset = text.length) {
  editor.update(() => {
    const paragraph = $createParagraphNode()
    if (text) paragraph.append($createTextNode(text))
    $getRoot().append(paragraph)
    const first = paragraph.getFirstChild()
    if (first && $isTextNode(first)) first.select(offset, offset)
    else paragraph.selectEnd()
  }, {discrete: true})
}

function dispatchPaste(editor: LexicalEditor, text: string, extra: Record<string, string> = {}): boolean {
  const data: Record<string, string> = {'text/plain': text, ...extra}
  let handled = false
  editor.update(() => {
    handled = editor.dispatchCommand(PASTE_COMMAND, {
      clipboardData: {types: Object.keys(data), files: [], getData: (type: string) => data[type] || ''},
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent)
  }, {discrete: true})
  return handled
}

function blocks(editor: LexicalEditor): Array<[string, string]> {
  return editor.getEditorState().read(() => $getRoot().getChildren().map(node => [node.getType(), node.getTextContent()] as [string, string]))
}

describe('plain Markdown paste', () => {
  it('inserts the source as paragraphs instead of styling it', async () => {
    const {editor, spans} = createHarness()
    seed(editor)
    expect(dispatchPaste(editor, '# 标题\n\n- 第一项\n- 第二项')).toBe(true)
    expect(blocks(editor)).toEqual([['paragraph', '# 标题'], ['paragraph', '- 第一项\n- 第二项']])
    await flush()
    expect(spans).toHaveLength(1)
    expect(spans[0].text).toBe('# 标题\n- 第一项\n- 第二项')
  })

  it('keeps single newlines as line breaks inside one paragraph', () => {
    expect(splitPlainParagraphs('# 标题\n第一行\n第二行\n\n正文')).toEqual([['# 标题', '第一行', '第二行'], ['正文']])
    expect(plainPasteText('# 标题\n第一行\n\n正文\n')).toBe('# 标题\n第一行\n正文')
  })

  it('offers the prompt only once the paste is committed', async () => {
    const {editor, spans} = createHarness()
    seed(editor)
    dispatchPaste(editor, '## 小标题')
    // 提交之后才读得到粘贴内容，提示随之出现（浏览器里这次提交是异步的，
    // 所以实现用的是 update 监听而不是粘贴当下的微任务）。
    await flush()
    expect(spans).toHaveLength(1)
  })

  it('leaves the document alone when nothing offers the prompt', () => {
    const {editor} = createHarness()
    seed(editor)
    expect(dispatchPaste(editor, '普通文字')).toBe(false)
    expect(blocks(editor)).toEqual([['paragraph', '']])
  })
})

describe('Markdown prompt conversion', () => {
  it('styles only the pasted span and keeps the surrounding text', async () => {
    const {editor, spans} = createHarness()
    seed(editor, 'abcdef', 3)
    dispatchPaste(editor, '# 标题\n\n- 第一项\n- 第二项')
    await flush()
    expect(applyMarkdownPaste(editor, spans[0], TRANSFORMERS)).toBe(true)
    expect(blocks(editor)).toEqual([
      ['paragraph', 'abc'],
      ['heading', '标题'],
      ['list', '第一项\n\n第二项'],
      ['paragraph', 'def'],
    ])
  })

  it('converts a paste that fills an empty paragraph', async () => {
    const {editor, spans} = createHarness()
    seed(editor)
    dispatchPaste(editor, '# 标题\n\n正文 **重点**')
    await flush()
    expect(isMarkdownPasteIntact(editor.getEditorState(), spans[0])).toBe(true)
    expect(applyMarkdownPaste(editor, spans[0], TRANSFORMERS)).toBe(true)
    expect(blocks(editor)).toEqual([['heading', '标题'], ['paragraph', '正文 重点']])
  })

  it('keeps the span readable until the prompt is answered', async () => {
    const {editor, spans} = createHarness()
    seed(editor)
    dispatchPaste(editor, '> 引用')
    await flush()
    expect(isMarkdownPasteIntact(editor.getEditorState(), spans[0])).toBe(true)
  })

  it('still finds the paste after text was typed above it', async () => {
    // 粘贴记的是「那段正文在纯文本里的位置」，不是节点 key：Lexical 会把插入的段落与
    // 相邻段落合并，key 全都会失效（浏览器里实测如此）。
    const {editor, spans} = createHarness()
    seed(editor, '前文')
    dispatchPaste(editor, '> 引用')
    await flush()
    editor.update(() => {
      const first = $getRoot().getFirstChild()
      if ($isElementNode(first)) first.selectStart()
      const selection = $getSelection()
      if ($isRangeSelection(selection)) selection.insertText('新的')
    }, {discrete: true})
    expect(isMarkdownPasteIntact(editor.getEditorState(), spans[0])).toBe(true)
    expect(applyMarkdownPaste(editor, spans[0], TRANSFORMERS)).toBe(true)
    expect(blocks(editor).map(([, text]) => text).join('\n')).toContain('引用')
  })

  it('refuses to convert after the pasted text was edited', async () => {
    const {editor, spans} = createHarness()
    seed(editor, '前文')
    dispatchPaste(editor, '# 标题')
    await flush()
    editor.update(() => {
      const paragraph = $getRoot().getFirstChild()!
      const last = $isElementNode(paragraph) ? paragraph.getLastChild() : null
      // 「前文# 标题」里那个 4 号位落在粘贴内容中间
      if ($isTextNode(last)) last.select(4, 4)
      const selection = $getSelection()
      if ($isRangeSelection(selection)) selection.insertText('X')
    }, {discrete: true})
    expect(isMarkdownPasteIntact(editor.getEditorState(), spans[0])).toBe(false)
    expect(applyMarkdownPaste(editor, spans[0], TRANSFORMERS)).toBe(false)
    expect(blocks(editor)).toEqual([['paragraph', '前文# X标题']])
  })

  it('refuses to convert after the pasted text was deleted', async () => {
    const {editor, spans} = createHarness()
    seed(editor, '前文')
    dispatchPaste(editor, '# 标题')
    await flush()
    const span = spans[0]
    editor.update(() => {
      $getRoot().clear()
    }, {discrete: true})
    expect(isMarkdownPasteIntact(editor.getEditorState(), span)).toBe(false)
    expect(applyMarkdownPaste(editor, span, TRANSFORMERS)).toBe(false)
  })

  it('does not touch text that merely follows the paste', async () => {
    const {editor, spans} = createHarness()
    seed(editor, 'abcdef', 3)
    dispatchPaste(editor, '## 小标题')
    await flush()
    editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('后续')))
    }, {discrete: true})
    expect(isMarkdownPasteIntact(editor.getEditorState(), spans[0])).toBe(true)
    expect(applyMarkdownPaste(editor, spans[0], TRANSFORMERS)).toBe(true)
    expect(blocks(editor)).toEqual([
      ['paragraph', 'abc'],
      ['heading', '小标题'],
      ['paragraph', 'def'],
      ['paragraph', '后续'],
    ])
  })

  it('converts a paste that replaced a selection', async () => {
    const {editor, spans} = createHarness()
    seed(editor, 'abcdef')
    editor.update(() => {
      const paragraph = $getRoot().getFirstChild()!
      const text = $isElementNode(paragraph) ? paragraph.getFirstChild() : null
      if (!$isTextNode(text)) throw new Error('missing text')
      text.select(1, 4)
    }, {discrete: true})
    dispatchPaste(editor, '## 小标题')
    await flush()
    expect(isMarkdownPasteIntact(editor.getEditorState(), spans[0])).toBe(true)
    expect(applyMarkdownPaste(editor, spans[0], TRANSFORMERS)).toBe(true)
    expect(blocks(editor)).toEqual([
      ['paragraph', 'a'],
      ['heading', '小标题'],
      ['paragraph', 'ef'],
    ])
  })
})
