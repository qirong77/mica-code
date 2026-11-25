import {$createCodeNode, $isCodeNode} from '@lexical/code'
import {$createAutoLinkNode, autoLinkEmailMatcher, autoLinkUrlMatcher} from '@lexical/link'
import {$generateNodesFromMarkdownString, type Transformer} from '@lexical/markdown'
import {$isTableSelection} from '@lexical/table'
import {
  $addUpdateTag,
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $findMatchingParent,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  HISTORY_PUSH_TAG,
  PASTE_COMMAND,
  type EditorState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type ParagraphNode,
  type RangeSelection,
} from 'lexical'
import {$inferPastedCodeLanguages, detectPastedCodeLanguage} from './codeLanguage'

export function isMarkdownText(text: string): boolean {
  return /^(?: {0,3}#{1,6}\s+\S| {0,3}>\s?\S|\s*[-+*]\s+\S|\s*\d+[.)]\s+\S| {0,3}(?:`{3,}|~{3,})|\|?.+\|.+\n\s*\|?\s*:?-{3,})/m.test(text) ||
    /(?:\*\*[^\n*]+\*\*|__[^\n_]+__|!?\[[^\]\n]+\]\([^\s)]+\))/.test(text)
}

// A clipboard that carries only the source text wraps it in neutral containers:
// a chat bubble, a text field, a bare `<span style="white-space: pre-wrap">`.
// Tags and properties below are the whole vocabulary of those wrappers. Anything
// that expresses structure or emphasis — a heading, a list, a link, an image, a
// table, bold or colour — means the copy already has formatting worth keeping,
// and that paste must not be read as Markdown source.
const PLAIN_TAGS = new Set(['DIV', 'SPAN', 'P', 'BR', 'META', 'FONT'])
const EMPHASIS_STYLE = /(?:^|;)\s*(?:font-weight|font-style|font-variant|text-decoration|text-transform|color|background|background-color|vertical-align)\s*:/i

function carriesOnlyText(root: Element): boolean {
  return [...root.querySelectorAll('*')].every(element => {
    if (!PLAIN_TAGS.has(element.tagName)) return false
    for (const attribute of element.attributes) {
      if (attribute.name === 'style') {
        if (EMPHASIS_STYLE.test(attribute.value)) return false
        continue
      }
      if (['href', 'src', 'srcset', 'alt'].includes(attribute.name)) return false
    }
    return true
  })
}

type ClipboardSource =
  | {kind: 'markdown'; text: string}
  | {kind: 'code'; text: string; language: string | null}
  | {kind: 'links'; text: string}

// Parse HTML once. Only unwrap isolated code or neutral text wrappers; ordinary
// web/office formatting keeps its normal import path.
function readClipboardSource(data: DataTransfer): ClipboardSource | null {
  if (data.files?.length || Array.from(data.types).some(t => /lexical|rtf/i.test(t))) return null
  const explicit = data.getData('text/markdown') || data.getData('text/x-markdown')
  if (explicit) return {kind: 'markdown', text: explicit}
  let text = data.getData('text/plain')
  const html = data.getData('text/html')
  let isolatedCode = false
  if (html) {
    if (typeof DOMParser === 'undefined') return null
    const body = new DOMParser().parseFromString(html, 'text/html').body
    const meaningful = [...body.childNodes].filter(n => n.nodeType !== 8 && (n.nodeType !== 3 || n.textContent?.trim()))
    const single = meaningful.length === 1 && meaningful[0]?.nodeType === 1 ? meaningful[0] as Element : null
    let code = single
    while (code && ['DIV', 'SPAN'].includes(code.tagName) && code.children.length === 1 && code.textContent === code.firstElementChild?.textContent) {
      code = code.firstElementChild as Element
    }
    if (code && ['PRE', 'CODE'].includes(code.tagName)) {
      const language = code.getAttribute('data-language') || code.querySelector('code')?.getAttribute('data-language') || (code.querySelector('code')?.className || code.className).match(/language-([\w-]+)/)?.[1]
      text = text || code.textContent || ''
      if (language && !/^(markdown|md|text|plaintext)$/i.test(language)) return {kind: 'code', text, language}
      isolatedCode = true
    } else if (!carriesOnlyText(body)) return null
  }
  if (isMarkdownText(text)) return {kind: 'markdown', text}
  const language = detectPastedCodeLanguage(text)
  if (isolatedCode || language) return {kind: 'code', text, language}
  return !text.includes('\n') && hasAutoLink(text) ? {kind: 'links', text} : null
}

export function getMarkdownClipboardText(data: DataTransfer): string | null {
  const source = readClipboardSource(data)
  return source?.kind === 'markdown' ? source.text : null
}

export type PastePoint = {key: NodeKey; offset: number; type: 'text' | 'element'}

/**
 * One Markdown paste, remembered as the source text plus where it starts in the
 * document's plain text.
 *
 * Node keys can not be the anchor: Lexical merges the paragraphs and text this
 * paste inserts into the surrounding ones, so a paste into existing prose leaves
 * every node it created detached (checked in the browser — the merged text
 * survives, the keys do not). A character offset survives that merge and still
 * says exactly which characters the confirmation covers.
 */
export type MarkdownPasteSpan = {
  markdown: string
  text: string
  startOffset: number
}

// Pasting keeps the reader's line structure: a blank line starts a new
// paragraph, a single newline stays inside the same paragraph.
export function splitPlainParagraphs(markdown: string): string[][] {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map(block => {
      const lines = block.split('\n')
      while (lines.length && lines[lines.length - 1] === '') lines.pop()
      return lines
    })
    .filter(lines => lines.some(line => line.trim().length > 0))
}

export function plainPasteText(markdown: string): string {
  return splitPlainParagraphs(markdown).map(lines => lines.join('\n')).join('\n')
}

function $createPlainParagraphs(markdown: string, linkUrls = false): ParagraphNode[] {
  return splitPlainParagraphs(markdown).map(lines => {
    const paragraph = $createParagraphNode()
    lines.forEach((line, index) => {
      if (index > 0) paragraph.append($createLineBreakNode())
      if (!line) return
      if (!linkUrls) {
        paragraph.append($createTextNode(line))
        return
      }

      let offset = 0
      while (offset < line.length) {
        const rest = line.slice(offset)
        const urlMatch = autoLinkUrlMatcher(rest)
        const emailMatch = autoLinkEmailMatcher(rest)
        const match = [urlMatch, emailMatch]
          .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
          .sort((left, right) => left.index - right.index)[0]
        if (!match) {
          paragraph.append($createTextNode(rest))
          break
        }
        if (match.index > 0) paragraph.append($createTextNode(rest.slice(0, match.index)))
        paragraph.append($createAutoLinkNode(match.url).append($createTextNode(match.text)))
        offset += match.index + match.length
      }
    })
    return paragraph
  })
}

function hasAutoLink(text: string): boolean {
  return autoLinkUrlMatcher(text) !== null || autoLinkEmailMatcher(text) !== null
}

type FlatText = {text: string; starts: Array<{index: number; key: NodeKey; size: number}>}

// Reads the document the way a range reads back (`RangeSelection.getTextContent`):
// one `\n` between non-inline blocks, `\n` for every line break. Offsets recorded
// here therefore line up with the text a range returns.
function $flatText(): FlatText {
  const starts: FlatText['starts'] = []
  let text = ''
  let prevWasElement = true
  const visit = (node: LexicalNode) => {
    if ($isElementNode(node) && !node.isInline()) {
      if (!prevWasElement) text += '\n'
      prevWasElement = true
      for (const child of node.getChildren()) visit(child)
      return
    }
    if ($isTextNode(node)) starts.push({index: text.length, key: node.getKey(), size: node.getTextContentSize()})
    text += node.getTextContent()
    prevWasElement = false
  }
  for (const child of $getRoot().getChildren()) visit(child)
  return {text, starts}
}

function $pointAt(index: number, flat: FlatText): PastePoint | null {
  let found: FlatText['starts'][number] | null = null
  for (const entry of flat.starts) {
    if (entry.index > index) break
    found = entry
  }
  if (!found) return null
  const offset = index - found.index
  if (offset > found.size) return null
  return {key: found.key, offset, type: 'text'}
}

function $topBlock(node: LexicalNode): ElementNode | null {
  const block = node.getTopLevelElement()
  return block && $isElementNode(block) ? block : null
}

// Lexical throws when a point still names a node from an earlier state, so both
// ends are looked up before the range is built.
function $rangeBetween(start: PastePoint, end: PastePoint): RangeSelection | null {
  if (!$getNodeByKey(start.key) || !$getNodeByKey(end.key)) return null
  const selection = $createRangeSelection()
  try {
    selection.anchor.set(start.key, start.offset, start.type)
    selection.focus.set(end.key, end.offset, end.type)
  } catch {
    return null
  }
  return selection
}

/**
 * The range this paste still covers, or null when it no longer reads back as
 * pasted. The recorded offset is tried first so text typed above the paste does
 * not silently shift the answer onto its neighbour; a shifted but unambiguous
 * paste is accepted, and anything ambiguous is refused.
 */
function $spanRange(span: MarkdownPasteSpan): RangeSelection | null {
  if (!span.text) return null
  const flat = $flatText()
  const candidates: number[] = []
  if (flat.text.startsWith(span.text, span.startOffset)) candidates.push(span.startOffset)
  const first = flat.text.indexOf(span.text)
  if (first >= 0 && !candidates.includes(first) && flat.text.indexOf(span.text, first + 1) < 0) candidates.push(first)
  for (const index of candidates) {
    const start = $pointAt(index, flat)
    const end = $pointAt(index + span.text.length, flat)
    if (!start || !end) continue
    const range = $rangeBetween(start, end)
    if (range && range.getTextContent() === span.text) return range
  }
  return null
}

export function isMarkdownPasteIntact(state: EditorState, span: MarkdownPasteSpan): boolean {
  return state.read(() => $spanRange(span) !== null)
}

/** The block the paste ends in — the prompt is drawn next to it. */
export function markdownPasteAnchorKey(editor: LexicalEditor, span: MarkdownPasteSpan): NodeKey | null {
  return editor.getEditorState().read(() => {
    const range = $spanRange(span)
    return range ? $topBlock(range.focus.getNode())?.getKey() ?? null : null
  })
}

/** The block the paste ends in, in viewport coordinates. */
export function markdownPasteAnchorRect(editor: LexicalEditor, span: MarkdownPasteSpan): DOMRect | null {
  const key = markdownPasteAnchorKey(editor, span)
  const element = key ? editor.getElementByKey(key) : null
  return element ? element.getBoundingClientRect() : null
}

function $hasContentBefore(point: PastePoint): boolean {
  const node = $getNodeByKey(point.key)
  const block = node ? $topBlock(node) : null
  if (!node || !block) return false
  if (node.getKey() === block.getKey()) return point.offset > 0
  return point.offset > 0 || block.getFirstDescendant()?.getKey() !== node.getKey()
}

function $hasContentAfter(point: PastePoint): boolean {
  const node = $getNodeByKey(point.key)
  const block = node ? $topBlock(node) : null
  if (!node || !block) return false
  if (node.getKey() === block.getKey()) return point.offset < block.getChildrenSize()
  if (block.getLastDescendant()?.getKey() !== node.getKey()) return true
  return point.offset < ($isTextNode(node) ? node.getTextContentSize() : $isElementNode(node) ? node.getChildrenSize() : 0)
}

// Replace the pasted source with the nodes its Markdown describes. The update
// carries its own history entry, so one undo restores the plain text.
export function applyMarkdownPaste(editor: LexicalEditor, span: MarkdownPasteSpan, transformers: Transformer[]): boolean {
  if (!editor.isEditable()) return false
  let applied = false
  editor.update(() => {
    const selection = $spanRange(span)
    if (!selection) return
    let nodes: LexicalNode[]
    try {
      nodes = $generateNodesFromMarkdownString(span.markdown.replace(/\r\n?/g, '\n'), transformers)
    } catch {
      return
    }
    if (!nodes.length) return
    $inferPastedCodeLanguages(nodes)
    // Absorb Lexical's first-block merge without losing a heading/quote/code
    // block when the paste started in the middle of a paragraph that already
    // has text.
    const leading = $hasContentBefore(selection.anchor) && nodes[0].getType() !== 'paragraph' ? $createParagraphNode() : null
    if (leading) nodes.unshift(leading)
    // The text after the paste is appended to whatever block ends the range, so
    // it needs a paragraph of its own to land in.
    const trailing = $hasContentAfter(selection.focus) && nodes[nodes.length - 1].getType() !== 'paragraph' ? $createParagraphNode() : null
    if (trailing) nodes.push(trailing)
    $addUpdateTag(HISTORY_PUSH_TAG)
    $setSelection(selection)
    selection.insertNodes(nodes)
    for (const separator of [leading, trailing]) {
      if (separator?.isAttached() && separator.isEmpty()) separator.remove()
    }
    applied = true
  }, {discrete: true})
  return applied
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let index = 0
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index += 1
  return index
}

// Markdown arrives as source text, never as the styled result: the caller shows
// a prompt for the span and decides whether `applyMarkdownPaste` runs.
export function registerMarkdownPaste(editor: LexicalEditor, transformers: Transformer[], onPaste?: (span: MarkdownPasteSpan) => void): () => void {
  return editor.registerCommand(PASTE_COMMAND, event => {
    if (!editor.isEditable() || !event || !('clipboardData' in event) || !event.clipboardData) return false
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || $isTableSelection(selection)) return false
    const code = $findMatchingParent(selection.anchor.getNode(), $isCodeNode)
    if ($isCodeNode(code)) {
      const focusCode = $findMatchingParent(selection.focus.getNode(), $isCodeNode)
      if (focusCode?.is(code) && !code.getLanguage()) {
        const language = detectPastedCodeLanguage(event.clipboardData.getData('text/plain'))
        if (language) code.setLanguage(language)
      }
      // The official handler inserts text into the code block in this update.
      return false
    }
    for (const point of [selection.anchor, selection.focus]) {
      let node = point.getNode()
      while (node.getParent()) {
        if ($isCodeNode(node) || node.getType() === 'tablecell') return false
        node = node.getParent()!
      }
    }
    const source = readClipboardSource(event.clipboardData)
    if (!source) return false
    if (source.kind === 'code') {
      $addUpdateTag(HISTORY_PUSH_TAG)
      selection.insertNodes([$createCodeNode(source.language || undefined).append($createTextNode(source.text))])
      event.preventDefault()
      return true
    }
    if (source.kind === 'links') {
      $addUpdateTag(HISTORY_PUSH_TAG)
      selection.insertNodes($createPlainParagraphs(source.text, true))
      event.preventDefault()
      return true
    }
    const markdown = source.text
    const paragraphs = $createPlainParagraphs(markdown)
    if (!paragraphs.length) return false
    const before = $flatText().text
    $addUpdateTag(HISTORY_PUSH_TAG)
    selection.insertNodes(paragraphs)
    // Where the source landed is read off the document itself: the text before and
    // after the insert shares a prefix up to the paste, and that prefix survives
    // whatever merging Lexical does to the inserted nodes.
    const startOffset = commonPrefixLength(before, $flatText().text)
    event.preventDefault()
    if (onPaste) {
      const span: MarkdownPasteSpan = {markdown, text: plainPasteText(markdown), startOffset}
      // The span is only meaningful in the committed state, and this paste's update
      // commits on a later microtask — so the caller is told once that update lands,
      // never about a state that does not contain the paste yet.
      let answered = false
      const unregister = editor.registerUpdateListener(({editorState}) => {
        if (answered) return
        answered = true
        unregister()
        if (isMarkdownPasteIntact(editorState, span)) onPaste(span)
      })
    }
    return true
  }, COMMAND_PRIORITY_HIGH)
}

export type PromptBox = {top: number; bottom: number; left: number; right: number}
export type PromptPlacement = {top: number; left: number; above: boolean}

function clampBetween(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Where the confirmation card goes, in viewport coordinates. It hugs the block
 * the paste ended in while that block is on screen, but it never leaves the
 * visible part of the editor: a long paste ends far below the fold, so anchoring
 * blindly would put the card off-screen and read as "no prompt at all".
 */
export function placeMarkdownPastePrompt(input: {
  anchor: PromptBox
  view: PromptBox
  size: {width: number; height: number}
  gap?: number
}): PromptPlacement {
  const gap = input.gap ?? 8
  const {anchor, view, size} = input
  const minTop = view.top + gap
  const maxTop = Math.max(minTop, view.bottom - gap - size.height)
  const below = anchor.bottom + gap
  const above = anchor.top - gap - size.height
  const flipped = above >= minTop && below > maxTop
  const top = clampBetween(flipped ? above : below, minTop, maxTop)
  const left = Math.max(view.left + gap, view.right - gap - size.width)
  return {top: Math.round(top), left: Math.round(left), above: flipped}
}
