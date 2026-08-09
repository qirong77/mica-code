// 终端风格输入框（移植自 text-area-terminal 的 TerminalTextarea，逻辑 1:1）：
// - 隐藏真实 textarea 接收输入
// - 渲染层展示纯文本 + 选区高亮（不做 markdown 高亮）
// - mirror div 从 DOM 直接读光标像素坐标
// - 光标位置通过 ref 直接操作 DOM，不触发 React 重渲染
// - 光标宽度 = 光标下字素宽度（行尾用 fallback），高度 = 当前字号，行盒内垂直居中
// - 闪烁由 JS 控制（530ms 间隔），输入时暂停 800ms 保持常亮，失焦/有选区隐藏光标
import { useCallback, useEffect, useRef, useState } from 'react'

const BLINK_INTERVAL = 530
const PAUSE_DURATION = 800
const FALLBACK_CHAR_WIDTH = 8

const TEXTAREA_CURSOR_STYLE_PROPS = [
  'boxSizing',
  'width',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
  'tabSize'
]

const GRAPHEME_SEGMENTER =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

function getGraphemeAt(value, index) {
  // 终端文本通常以 ASCII 为主，走常量时间快路径；复杂 Unicode 才调用分词器。
  const code = value.charCodeAt(index)
  if (code < 0x80) return value[index]
  return GRAPHEME_SEGMENTER?.segment(value).containing(index)?.segment
}

export default function TerminalComposer({
  value,
  placeholder,
  textareaRef,
  onChange,
  onKeyDown,
  onPaste
}) {
  const preRef = useRef(null)
  const mirrorRef = useRef(null)
  const cursorRef = useRef(null)
  const mirrorTextRef = useRef(null)
  const measureMarkerRef = useRef(null)
  const fallbackCharWRef = useRef(FALLBACK_CHAR_WIDTH)
  const syncFrameRef = useRef(null)
  const blinkTimerRef = useRef(null)
  const pauseTimerRef = useRef(null)

  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [blinkOn, setBlinkOn] = useState(true)
  const [focused, setFocused] = useState(false)
  const [windowFocused, setWindowFocused] = useState(
    () => typeof document !== 'undefined' && document.hasFocus()
  )

  // ---- 闪烁管理（与原项目一致） ----
  const stopBlinking = useCallback(() => {
    if (blinkTimerRef.current) clearInterval(blinkTimerRef.current)
    blinkTimerRef.current = null
    setBlinkOn(true)
  }, [])

  const resumeBlinking = useCallback(() => {
    if (blinkTimerRef.current) clearInterval(blinkTimerRef.current)
    blinkTimerRef.current = setInterval(() => setBlinkOn((v) => !v), BLINK_INTERVAL)
  }, [])

  const pauseBlinking = useCallback(() => {
    stopBlinking()
    if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
    pauseTimerRef.current = setTimeout(resumeBlinking, PAUSE_DURATION)
  }, [stopBlinking, resumeBlinking])

  useEffect(() => {
    resumeBlinking()
    return () => {
      if (blinkTimerRef.current) clearInterval(blinkTimerRef.current)
      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
      if (syncFrameRef.current !== null) cancelAnimationFrame(syncFrameRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- 字符宽度测量（行尾光标的 fallback 宽度） ----
  const measureCharW = useCallback(() => {
    const ta = textareaRef.current
    const measure = document.createElement('span')
    measure.style.visibility = 'hidden'
    measure.style.position = 'absolute'
    measure.style.whiteSpace = 'pre'
    measure.textContent = 'M'
    if (ta) measure.style.font = window.getComputedStyle(ta).font
    document.body.appendChild(measure)
    const w = measure.getBoundingClientRect().width
    document.body.removeChild(measure)
    fallbackCharWRef.current = w > 0 ? w : FALLBACK_CHAR_WIDTH
    return w
  }, [textareaRef])

  // ---- 同步 mirror 尺寸与 textarea client 区域一致 ----
  const syncMirrorSize = useCallback(() => {
    const ta = textareaRef.current
    const mirror = mirrorRef.current
    if (!ta || !mirror) return
    // clientWidth 排除滚动条，mirror 和 textarea 内容区宽度一致
    mirror.style.width = `${ta.clientWidth}px`
    mirror.style.height = `${ta.clientHeight}px`
  }, [textareaRef])

  // ---- 光标位置更新 ----
  const updateCursorPos = useCallback(() => {
    const ta = textareaRef.current
    const mirror = mirrorRef.current
    const cursor = cursorRef.current
    if (!ta || !mirror || !cursor) return

    const pos = ta.selectionStart
    // 复用 Text 和 span，避免每次光标移动都创建、回收 DOM 节点。
    if (!mirrorTextRef.current || !measureMarkerRef.current) {
      mirrorTextRef.current = document.createTextNode('')
      measureMarkerRef.current = document.createElement('span')
      measureMarkerRef.current.style.display = 'inline-block'
      mirror.replaceChildren(mirrorTextRef.current, measureMarkerRef.current)
    }

    // mirror 复制 textarea 计算样式，保证换行与光标测量和输入区一致。
    // font shorthand 一次到位，避免逐属性遗漏导致测宽偏差。
    const styles = window.getComputedStyle(ta)
    mirror.style.font = styles.font
    for (const property of TEXTAREA_CURSOR_STYLE_PROPS) mirror.style[property] = styles[property]
    mirror.style.width = `${ta.clientWidth}px`

    mirrorTextRef.current.data = ta.value.slice(0, pos)

    // 用光标下的实际字素作为 marker，使块状光标与该字符同宽；
    // 字素分割可避免拆开组合字符、代理对或 ZWJ emoji。
    const currentChar = getGraphemeAt(ta.value, pos)
    const measurableChar = currentChar && currentChar !== '\n' ? currentChar : '\u200b'
    const marker = measureMarkerRef.current
    marker.textContent = measurableChar

    const fontSize = Number.parseFloat(styles.fontSize) || 13
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20

    // marker.offsetLeft/Top 已包含 padding，光标起始为 0,0，不重复加 padding
    const left = marker.offsetLeft - ta.scrollLeft
    // marker 位于行盒顶部；终端光标只覆盖字面高度，并在行盒内垂直居中。
    const top = marker.offsetTop + (lineHeight - fontSize) / 2 - ta.scrollTop
    const measuredWidth = marker.getBoundingClientRect().width
    const width = measuredWidth > 0 ? measuredWidth : fallbackCharWRef.current
    cursor.style.transform = `translate(${left}px, ${top}px)`
    cursor.style.width = `${width}px`
    cursor.style.height = `${fontSize}px`
  }, [textareaRef])

  // 初始测量 + 字体加载后重新测量并刷新光标
  useEffect(() => {
    measureCharW()
    document.fonts?.ready?.then(() => {
      measureCharW()
      updateCursorPos()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 每次字体批次加载完成时刷新
  useEffect(() => {
    const handler = () => {
      measureCharW()
      updateCursorPos()
    }
    document.fonts?.addEventListener?.('loadingdone', handler)
    return () => document.fonts?.removeEventListener?.('loadingdone', handler)
  }, [measureCharW, updateCursorPos])

  // ---- 综合更新 ----
  const sync = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    syncMirrorSize()
    updateCursorPos()
    setSelection((current) =>
      current.start === ta.selectionStart && current.end === ta.selectionEnd
        ? current
        : { start: ta.selectionStart, end: ta.selectionEnd }
    )
  }, [syncMirrorSize, updateCursorPos, textareaRef])

  // 输入时多个相关事件往往会在同一帧触发，只进行一次布局测量。
  const scheduleSync = useCallback(() => {
    if (syncFrameRef.current !== null) return
    syncFrameRef.current = requestAnimationFrame(() => {
      syncFrameRef.current = null
      sync()
    })
  }, [sync])

  // ---- 容器尺寸变化时同步 mirror ----
  useEffect(() => {
    syncMirrorSize()
    const ta = textareaRef.current
    if (!ta || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => syncMirrorSize())
    ro.observe(ta)
    return () => ro.disconnect()
  }, [syncMirrorSize, textareaRef])

  // ---- 输入变化时刷新光标与选区 ----
  useEffect(() => {
    scheduleSync()
  }, [value, scheduleSync])

  // ---- 文本域聚焦期间跟随选区变化（含程序化 setSelectionRange） ----
  useEffect(() => {
    if (!focused) return undefined
    const handler = () => scheduleSync()
    document.addEventListener('selectionchange', handler)
    return () => document.removeEventListener('selectionchange', handler)
  }, [focused, scheduleSync])

  // ---- 窗口失焦时隐藏光标 ----
  useEffect(() => {
    const onFocus = () => setWindowFocused(true)
    const onBlur = () => setWindowFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // ---- 事件处理 ----
  const handleChange = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    onChange?.(ta.value)
    pauseBlinking()
    scheduleSync()
  }, [onChange, pauseBlinking, scheduleSync, textareaRef])

  const handleKeyDown = useCallback(
    (event) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      pauseBlinking()
      scheduleSync()
      onKeyDown?.(event)
    },
    [onKeyDown, pauseBlinking, scheduleSync]
  )

  const handleScroll = useCallback(() => {
    const ta = textareaRef.current
    const layer = preRef.current
    if (!ta || !layer) return
    layer.scrollTop = ta.scrollTop
    layer.scrollLeft = ta.scrollLeft
    updateCursorPos()
  }, [textareaRef, updateCursorPos])

  const handleFocus = useCallback(() => {
    setFocused(true)
    setBlinkOn(true)
    resumeBlinking()
    sync()
  }, [resumeBlinking, sync])

  const handleBlur = useCallback(() => {
    setFocused(false)
    setBlinkOn(false)
    if (blinkTimerRef.current) clearInterval(blinkTimerRef.current)
    if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
  }, [])

  const handleCompositionStart = useCallback(() => {
    stopBlinking()
    scheduleSync()
  }, [stopBlinking, scheduleSync])

  // ---- 选区渲染（纯文本，不做 markdown 高亮） ----
  const { before, selected, after } = (() => {
    const s = Math.min(selection.start, selection.end)
    const e = Math.max(selection.start, selection.end)
    return {
      before: value.slice(0, s),
      selected: value.slice(s, e),
      after: value.slice(e)
    }
  })()

  const hasSelection = selected.length > 0
  const cursorHidden = !focused || !windowFocused || hasSelection || !blinkOn

  return (
    <div className="chat-composer-input" onClick={() => textareaRef.current?.focus()}>
      {/* 渲染层：显示文本 + 选区高亮 */}
      <div ref={preRef} className="chat-composer-markdown-layer" aria-hidden="true">
        {value ? (
          hasSelection ? (
            <>
              <span>{before}</span>
              <span className="chat-composer-selection">{selected}</span>
              <span>{after}</span>
            </>
          ) : (
            <span>{value}</span>
          )
        ) : (
          <span className="chat-composer-placeholder">{placeholder}</span>
        )}
      </div>

      {/* 隐藏 mirror：用于测量光标真实像素位置 */}
      <div ref={mirrorRef} className="chat-composer-cursor-mirror" aria-hidden="true" />

      {/* 自绘光标 */}
      <span
        ref={cursorRef}
        className="chat-composer-terminal-cursor"
        style={{ visibility: cursorHidden ? 'hidden' : 'visible' }}
        aria-hidden="true"
      />

      {/* 隐藏的真实 textarea */}
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        aria-label="对话输入"
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={scheduleSync}
        onSelect={scheduleSync}
        onClick={scheduleSync}
        onScroll={handleScroll}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onPaste={onPaste}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={scheduleSync}
      />
    </div>
  )
}
