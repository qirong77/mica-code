import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconArrowDown, IconArrowUp, IconX } from '@tabler/icons-react'
import {
  FIND_MATCH_LIMIT,
  compileFindMatcher,
  findCountLabel,
  findTextMatches,
  stepMatchIndex
} from './chat-find'

/**
 * 主对话区的查找条（Cmd/Ctrl+F），交互照 VS Code 的 find widget：
 * 输入框内联「Aa / ab / .*」三个开关，右侧是「无结果」/「n/总数」，再往右是上一个、
 * 下一个、关闭。Enter = 下一个、Shift+Enter = 上一个，Esc 关掉。
 *
 * 命中上色走 CSS Custom Highlight API（`::highlight()`），**不往 DOM 里包 `<mark>`**：
 * 对话区是 React 管的，而且流式回答每 80ms 就换一次文本；在它底下插入包装节点，下一次
 * diff 就可能把包装节点当脏数据删掉、或者索性报「要删的节点不是我的子节点」。
 */

/** 命中的高亮名，与 app.css 里的 `::highlight(chat-find-match)` 对应。 */
const MATCH_HIGHLIGHT = 'chat-find-match'
const CURRENT_HIGHLIGHT = 'chat-find-current'

/** 挂出去的 Range 上限：每帧都要参与高亮绘制，条数多了滚动会明显发涩。 */
const HIGHLIGHT_RANGE_LIMIT = 800

/** 输入查询时的重扫防抖；流式回答期间由 MutationObserver 另按 SCAN_DEBOUNCE 重扫。 */
const QUERY_DEBOUNCE = 90
const CONTENT_DEBOUNCE = 300

/** 命中离视野边缘多近就不动滚动位置（像素）。 */
const SCROLL_MARGIN = 28

function highlightRegistry() {
  const registry = globalThis.CSS?.highlights
  return registry && typeof globalThis.Highlight === 'function' ? registry : null
}

function applyFindHighlights(ranges, activeIndex) {
  const registry = highlightRegistry()
  if (!registry) return
  const HighlightCtor = globalThis.Highlight
  registry.set(MATCH_HIGHLIGHT, new HighlightCtor(...ranges.slice(0, HIGHLIGHT_RANGE_LIMIT)))
  const active = ranges[activeIndex]
  if (active) registry.set(CURRENT_HIGHLIGHT, new HighlightCtor(active))
  else registry.delete(CURRENT_HIGHLIGHT)
}

function clearFindHighlights() {
  const registry = highlightRegistry()
  if (!registry) return
  registry.delete(MATCH_HIGHLIGHT)
  registry.delete(CURRENT_HIGHLIGHT)
}

/**
 * 扫一遍对话区的文本节点，收集命中 Range。
 *
 * 只认单个文本节点内部的命中：跨元素断开的字（`**粗**体` 里的 `粗体`）不算——那需要
 * 把相邻节点拼起来再回填区间，代价远大于收益。命中按文档顺序返回，序号就是「第几条」。
 */
function collectMatchRanges(root, matcher) {
  const ranges = []
  if (!root || !matcher?.pattern || typeof NodeFilter === 'undefined') {
    return { ranges, truncated: false }
  }
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      // 图标按钮的隐藏文案、查找条自己的文字不参与查找
      if (parent.closest('button, [aria-hidden="true"], .chat-find')) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })
  let truncated = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const remaining = FIND_MATCH_LIMIT - ranges.length
    if (remaining <= 0) {
      truncated = true
      break
    }
    const result = findTextMatches(node.nodeValue, matcher, remaining)
    for (const match of result.matches) {
      const range = doc.createRange()
      range.setStart(node, match.start)
      range.setEnd(node, match.end)
      ranges.push(range)
    }
    if (result.truncated) {
      truncated = true
      break
    }
  }
  return { ranges, truncated }
}

/** 命中已经在视野里就不动滚动位置；否则把它摆到视野中间。 */
function scrollRangeIntoView(range, root) {
  const scroller = root?.closest('.chat-scroll')
  if (!scroller || !range) return
  const rect = range.getBoundingClientRect()
  if (!rect.height && !rect.width) return
  const box = scroller.getBoundingClientRect()
  if (rect.top >= box.top + SCROLL_MARGIN && rect.bottom <= box.bottom - SCROLL_MARGIN) return
  const centered = box.top + Math.max(0, (box.height - rect.height) / 2)
  scroller.scrollTop += rect.top - centered
}

/**
 * 新查询从哪条命中开始：视野里第一条（VS Code 也是从可见位置往下找），
 * 全在视野上方时回到第一条。命中按文档顺序排列，看到的第一个就是答案，不用量完所有矩形。
 */
function firstMatchIndex(ranges, root) {
  const scroller = root?.closest('.chat-scroll')
  if (!scroller) return 0
  const top = scroller.getBoundingClientRect().top
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges[index].getBoundingClientRect().bottom >= top) return index
  }
  return 0
}

export function ChatFind({ open, focusSignal = 0, targetRef, onClose }) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [count, setCount] = useState(0)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  const rangesRef = useRef([])
  const activeRef = useRef(-1)

  const matcher = useMemo(
    () => compileFindMatcher(query, { caseSensitive, wholeWord, regex }),
    [caseSensitive, query, regex, wholeWord]
  )

  const reset = useCallback(() => {
    rangesRef.current = []
    activeRef.current = -1
    setActiveIndex(-1)
    setCount(0)
    setTruncated(false)
    clearFindHighlights()
  }, [])

  const rescan = useCallback(
    ({ keepActive = false, scroll = true } = {}) => {
      const root = targetRef.current
      const nextError = matcher?.error || ''
      setError(nextError)
      if (!root || !matcher || nextError) {
        reset()
        return
      }
      const result = collectMatchRanges(root, matcher)
      rangesRef.current = result.ranges
      setCount(result.ranges.length)
      setTruncated(result.truncated)
      if (result.ranges.length === 0) {
        activeRef.current = -1
        setActiveIndex(-1)
        clearFindHighlights()
        return
      }
      // 内容在流式输出里长大时保住当前这一条；查询变了才重新从视野里挑
      const index =
        keepActive && activeRef.current >= 0
          ? Math.min(activeRef.current, result.ranges.length - 1)
          : firstMatchIndex(result.ranges, root)
      activeRef.current = index
      setActiveIndex(index)
      applyFindHighlights(result.ranges, index)
      if (scroll) scrollRangeIntoView(result.ranges[index], root)
    },
    [matcher, reset, targetRef]
  )

  // 查询或开关变了才重新定位；内容变化走下面的 MutationObserver（保留当前命中）
  useEffect(() => {
    if (!open) return undefined
    const timer = window.setTimeout(() => rescan(), QUERY_DEBOUNCE)
    return () => window.clearTimeout(timer)
  }, [open, rescan])

  // 流式回答、工具输出会不断往对话区里塞新文本：停下来再补扫一次，别每帧都扫
  useEffect(() => {
    if (!open) return undefined
    const root = targetRef.current
    if (!root || typeof MutationObserver === 'undefined') return undefined
    let timer = 0
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => rescan({ keepActive: true, scroll: false }), CONTENT_DEBOUNCE)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [open, rescan, targetRef])

  // 打开（或再按一次 Cmd+F）时把焦点交回输入框，并全选上一次的查询——和 VS Code 一样，
  // 再按一次就能直接改。
  useEffect(() => {
    if (!open) return undefined
    const handle = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(handle)
  }, [focusSignal, open])

  useEffect(() => {
    if (open) return
    reset()
  }, [open, reset])

  useEffect(() => () => clearFindHighlights(), [])

  const step = useCallback(
    (delta) => {
      const ranges = rangesRef.current
      if (ranges.length === 0) return
      const next = stepMatchIndex(activeRef.current, delta, ranges.length)
      activeRef.current = next
      setActiveIndex(next)
      applyFindHighlights(ranges, next)
      scrollRangeIntoView(ranges[next], targetRef.current)
    },
    [targetRef]
  )

  if (!open) return null

  const label = findCountLabel({ index: activeIndex, count, truncated, error, query })
  const tone = error ? 'is-error' : count === 0 && query ? 'is-empty' : ''
  // 按钮在 mousedown 就拿走焦点的话，用户点完「区分大小写」再打字就没地方去了
  const keepFocus = (event) => event.preventDefault()

  const toggle = (active, title, text, onToggle) => (
    <button
      type="button"
      className={`chat-find-toggle ${active ? 'is-on' : ''}`}
      aria-pressed={active}
      title={title}
      onMouseDown={keepFocus}
      onClick={onToggle}
    >
      {text}
    </button>
  )

  return (
    <div
      className="chat-find no-drag"
      role="search"
      data-no-chat-focus
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose?.()
          return
        }
        if (event.key === 'Enter' || event.key === 'F3') {
          event.preventDefault()
          event.stopPropagation()
          step(event.shiftKey ? -1 : 1)
        }
      }}
    >
      <div className="chat-find-field">
        <input
          ref={inputRef}
          className="chat-find-input"
          type="text"
          value={query}
          placeholder="查找"
          spellCheck={false}
          autoComplete="off"
          aria-label="在对话中查找"
          onChange={(event) => setQuery(event.target.value)}
        />
        {toggle(caseSensitive, '区分大小写', 'Aa', () => setCaseSensitive((value) => !value))}
        {toggle(wholeWord, '全字匹配', 'ab', () => setWholeWord((value) => !value))}
        {toggle(regex, '使用正则表达式', '.*', () => setRegex((value) => !value))}
      </div>
      <span className={`chat-find-count ${tone}`} aria-live="polite">
        {label}
      </span>
      <button
        type="button"
        className="chat-find-icon"
        title="上一个匹配（Shift+Enter）"
        aria-label="上一个匹配"
        disabled={count === 0}
        onMouseDown={keepFocus}
        onClick={() => step(-1)}
      >
        <IconArrowUp size={13} />
      </button>
      <button
        type="button"
        className="chat-find-icon"
        title="下一个匹配（Enter）"
        aria-label="下一个匹配"
        disabled={count === 0}
        onMouseDown={keepFocus}
        onClick={() => step(1)}
      >
        <IconArrowDown size={13} />
      </button>
      <button
        type="button"
        className="chat-find-icon"
        title="关闭（Esc）"
        aria-label="关闭查找"
        onMouseDown={keepFocus}
        onClick={() => onClose?.()}
      >
        <IconX size={13} />
      </button>
    </div>
  )
}
