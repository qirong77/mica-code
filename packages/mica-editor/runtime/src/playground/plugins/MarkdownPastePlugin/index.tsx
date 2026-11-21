import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext'
import {Button} from '@arco-design/web-react'
import {COMMAND_PRIORITY_LOW, KEY_ESCAPE_COMMAND, mergeRegister} from 'lexical'
import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {PLAYGROUND_TRANSFORMERS} from '../MarkdownTransformers'
import {
  applyMarkdownPaste,
  isMarkdownPasteIntact,
  markdownPasteAnchorRect,
  placeMarkdownPastePrompt,
  registerMarkdownPaste,
  type MarkdownPasteSpan,
  type PromptBox,
  type PromptPlacement,
} from './markdownPaste'
import './index.css'

// The visible part of the editor (or of the window, when the editor scroller is
// taller than the viewport). The prompt is kept inside this box so a long paste
// can not push it below the fold.
function visibleBox(rect: DOMRect | null, width: number, height: number): PromptBox | null {
  if (!rect) return null
  const box = {
    top: Math.max(rect.top, 0),
    bottom: Math.min(rect.bottom, height),
    left: Math.max(rect.left, 0),
    right: Math.min(rect.right, width),
  }
  return box.bottom - box.top > 64 && box.right - box.left > 160 ? box : null
}

function windowBox(width: number, height: number): PromptBox {
  return {top: 0, bottom: height, left: 0, right: width}
}

export default function MarkdownPastePlugin() {
  const [editor] = useLexicalComposerContext()
  const [span, setSpan] = useState<MarkdownPasteSpan | null>(null)
  const [placement, setPlacement] = useState<(PromptPlacement & {width: number}) | null>(null)
  const promptRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => registerMarkdownPaste(editor, PLAYGROUND_TRANSFORMERS, next => setSpan(next)), [editor])

  // The prompt only stands while the pasted source still reads back as pasted:
  // typing into it, deleting it or undoing the paste drops it. Focus is not a
  // reason to drop it — the card holds buttons, and tabbing into them must not
  // make it disappear under the pointer.
  useEffect(() => {
    if (!span) return
    return mergeRegister(
      editor.registerUpdateListener(({editorState}) => {
        // A newer paste may already have replaced this one; only the span that is
        // still current decides whether the prompt closes.
        setSpan(current => (current === span && !isMarkdownPasteIntact(editorState, span) ? null : current))
      }),
      editor.registerCommand(KEY_ESCAPE_COMMAND, () => {
        setSpan(current => (current === span ? null : current))
        return false
      }, COMMAND_PRIORITY_LOW),
    )
  }, [editor, span])

  // Any click outside the card means the reader moved on, and that click must
  // still reach the editor — so this listens in the capture phase and never
  // prevents the event.
  useEffect(() => {
    if (!span) return
    const onPointerDown = (event: PointerEvent) => {
      const prompt = promptRef.current
      if (prompt && event.target instanceof Node && prompt.contains(event.target)) return
      setSpan(current => (current === span ? null : current))
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSpan(current => (current === span ? null : current))
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [span])

  // The card is portalled to the body and positioned with viewport coordinates:
  // the editor surface lives inside scrolling, clipping and transformed
  // ancestors, and an absolutely positioned card inside them was either clipped
  // or placed relative to the whole document (hence below the fold on a long
  // paste).
  useLayoutEffect(() => {
    if (!span) return
    const place = () => {
      const prompt = promptRef.current
      if (!prompt) return
      const width = window.innerWidth
      const height = window.innerHeight
      const view = visibleBox(editor.getRootElement()?.getBoundingClientRect() ?? null, width, height) ?? windowBox(width, height)
      const rect = markdownPasteAnchorRect(editor, span)
      const anchor: PromptBox = rect
        ? {top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right}
        : // The block is gone from the DOM: sit at the bottom of what is visible.
          {top: view.bottom - 1, bottom: view.bottom, left: view.left + 16, right: view.left + 16}
      const next = placeMarkdownPastePrompt({anchor, view, size: {width: prompt.offsetWidth, height: prompt.offsetHeight}})
      setPlacement(current =>
        current && current.top === next.top && current.left === next.left && current.above === next.above && current.width === width
          ? current
          : {...next, width},
      )
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    if (observer && promptRef.current) observer.observe(promptRef.current)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      observer?.disconnect()
    }
  }, [editor, span])

  const convert = useCallback(() => {
    if (span) applyMarkdownPaste(editor, span, PLAYGROUND_TRANSFORMERS)
    setSpan(null)
  }, [editor, span])

  const dismiss = useCallback(() => setSpan(null), [])

  if (!span || typeof document === 'undefined') return null
  return createPortal(
    <div
      className={`markdown-paste-prompt${placement?.above ? ' is-above' : ''}`}
      ref={promptRef}
      role="group"
      aria-label="Markdown 粘贴提示"
      style={{
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        opacity: placement ? 1 : 0,
        pointerEvents: placement ? 'auto' : 'none',
      }}>
      <span className="markdown-paste-prompt-label" role="status">
        识别到 Markdown
      </span>
      <span className="markdown-paste-prompt-actions">
        <Button htmlType="button" type="text" size="mini" className="markdown-paste-prompt-action is-primary" onClick={convert}>
          按 Markdown 渲染
        </Button>
        <Button htmlType="button" type="text" size="mini" className="markdown-paste-prompt-action" onClick={dismiss}>
          保留原文
        </Button>
      </span>
    </div>,
    document.body,
  )
}
