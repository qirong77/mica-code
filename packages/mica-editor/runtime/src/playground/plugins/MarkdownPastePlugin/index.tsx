import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext'
import {BLUR_COMMAND, COMMAND_PRIORITY_LOW, KEY_ESCAPE_COMMAND, mergeRegister, type LexicalEditor} from 'lexical'
import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react'
import {PLAYGROUND_TRANSFORMERS} from '../MarkdownTransformers'
import {applyMarkdownPaste, isMarkdownPasteIntact, markdownPasteAnchorKey, registerMarkdownPaste, type MarkdownPasteSpan} from './markdownPaste'
import './index.css'

type Placement = {top: number; left: number}

// The prompt hovers over the pasted source, positioned against the block the
// paste ended in.
function readAnchorRect(editor: LexicalEditor, span: MarkdownPasteSpan): DOMRect | null {
  const blockKey = markdownPasteAnchorKey(editor, span)
  return blockKey ? editor.getElementByKey(blockKey)?.getBoundingClientRect() ?? null : null
}

export default function MarkdownPastePlugin() {
  const [editor] = useLexicalComposerContext()
  const [span, setSpan] = useState<MarkdownPasteSpan | null>(null)
  const promptRef = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<Placement>({top: 0, left: 0})

  useEffect(() => registerMarkdownPaste(editor, PLAYGROUND_TRANSFORMERS, setSpan), [editor])

  // The prompt only stands while the pasted source still reads back as pasted:
  // typing into it, deleting it or undoing the paste drops it, and a lost focus
  // means the reader moved on.
  useEffect(() => {
    if (!span) return
    return mergeRegister(
      editor.registerUpdateListener(({editorState}) => {
        if (!isMarkdownPasteIntact(editorState, span)) setSpan(null)
      }),
      editor.registerCommand(BLUR_COMMAND, () => {
        setSpan(null)
        return false
      }, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_ESCAPE_COMMAND, () => {
        setSpan(null)
        return false
      }, COMMAND_PRIORITY_LOW),
    )
  }, [editor, span])

  // Keep the prompt next to the paste while the page scrolls or resizes.
  useLayoutEffect(() => {
    const prompt = promptRef.current
    if (!span || !prompt) return
    const host = prompt.offsetParent instanceof HTMLElement ? prompt.offsetParent : null
    if (!host) return
    const place = () => {
      const anchor = readAnchorRect(editor, span)
      if (!anchor) return
      const hostRect = host.getBoundingClientRect()
      const promptRect = prompt.getBoundingClientRect()
      const gap = 8
      // Under the paste when it fits, above it otherwise: the prompt belongs to that
      // block and scrolls with it, never pinned to the viewport.
      const below = anchor.bottom - hostRect.top + gap
      const above = anchor.top - hostRect.top - promptRect.height - gap
      const top = below + promptRect.height > hostRect.height - gap && above >= gap ? above : below
      const left = Math.min(Math.max(anchor.left - hostRect.left, gap), Math.max(gap, hostRect.width - promptRect.width - gap))
      setPlacement({top, left})
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [editor, span])

  const convert = useCallback(() => {
    if (span) applyMarkdownPaste(editor, span, PLAYGROUND_TRANSFORMERS)
    setSpan(null)
  }, [editor, span])

  const dismiss = useCallback(() => setSpan(null), [])

  if (!span) return null
  return (
    <div
      className="markdown-paste-prompt"
      ref={promptRef}
      role="status"
      aria-live="polite"
      style={{top: placement.top, left: placement.left}}
      onMouseDown={event => event.preventDefault()}>
      <span className="markdown-paste-prompt-text">已粘贴 Markdown，是否转换为富文本样式？</span>
      <button type="button" className="markdown-paste-prompt-action is-primary" onClick={convert}>
        立即转换
      </button>
      <button type="button" className="markdown-paste-prompt-action" onClick={dismiss}>
        保持原文
      </button>
    </div>
  )
}
