import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react'
import { ArcoAction, Input } from '@mica-config-ui/arco'
import { filterRecent, moveHighlight } from '@packages/mica-web-shared'
import { post } from './bridge'

/**
 * 受控浏览器顶栏：状态点 + 后退/前进/刷新 + 可编辑地址 + 标签条。
 *
 * 它不是展示条：地址框是真的输入框（回车导航、Esc 还原、点走还原），按钮走与 agent
 * 同一条 navigate 链路；「最近访问」的列表由主进程另开一个浮层窗口显示，这里只负责
 * 按输入筛好、把锚点（地址框的位置）和高亮一起送过去——浮层不抢焦点，用户还能继续打字。
 *
 * 组件本身来自共享组件库（`@mica-config-ui/arco` 就是设置页用的那一套 Arco small），
 * 不再照着尺寸手写一遍。
 */

const INITIAL = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  recents: []
}
/** 点浮层里的条目时输入框可能先失焦：留一小段时间让选取先落地。 */
const BLUR_CLOSE_MS = 140

export function Bar({ store }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [address, setAddress] = useState(state.url || '')
  const [dirty, setDirty] = useState(false)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const inputRef = useRef(null)
  const anchorRef = useRef(null)
  const blurTimer = useRef(0)
  const dirtyRef = useRef(false)
  const urlRef = useRef(state.url || '')
  dirtyRef.current = dirty
  urlRef.current = state.url || ''

  const items = useMemo(
    () => filterRecent(state.recents || [], dirty ? address : ''),
    [state.recents, address, dirty]
  )
  const itemsRef = useRef(items)
  itemsRef.current = items

  // 页面地址变了（导航、重定向、切标签页）：收起浮层；没在编辑就把新地址写回地址框
  useEffect(() => {
    setOpen(false)
    setHighlight(-1)
    if (!dirtyRef.current) setAddress(state.url || '')
  }, [state.url])

  // 浮层开着时，列表或高亮一变就推一次（同一个动作既定位又更新内容）
  useEffect(() => {
    if (!open) return
    const node = anchorRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    post('recent:show', {
      anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      items,
      highlight
    })
  }, [open, items, highlight])

  useEffect(() => {
    if (!open) post('recent:close')
  }, [open])

  // 浮层里鼠标划过某一行：把高亮同步回地址框，回车与点选的是同一条
  useEffect(() => {
    const api = window.__micaChrome
    if (!api) return undefined
    api.highlight = (index) => setHighlight(moveHighlight(Number(index), itemsRef.current.length, 0))
    // 从浮层里点了一条：输入框可能还留着筛选词（浮层不抢焦点），先把编辑状态收掉，
    // 随后的状态推送才能把新地址写回来
    api.picked = () => {
      setDirty(false)
      setOpen(false)
      setHighlight(-1)
    }
    return () => {
      delete api.highlight
      delete api.picked
    }
  }, [])

  useEffect(() => () => window.clearTimeout(blurTimer.current), [])

  function beginEdit() {
    window.clearTimeout(blurTimer.current)
    setDirty(false)
    setOpen(true)
    setHighlight(-1)
    window.requestAnimationFrame(() => {
      const dom = inputRef.current?.dom
      if (dom && typeof dom.select === 'function') dom.select()
    })
  }

  function handleChange(value) {
    setAddress(value)
    setDirty(true)
    setOpen(true)
    setHighlight(-1)
  }

  function endEdit() {
    window.clearTimeout(blurTimer.current)
    blurTimer.current = window.setTimeout(() => {
      setOpen(false)
      setHighlight(-1)
      if (!dirtyRef.current) return
      setDirty(false)
      setAddress(urlRef.current)
    }, BLUR_CLOSE_MS)
  }

  function submit() {
    const picked = highlight >= 0 ? itemsRef.current[highlight] : null
    const value = String(picked ? picked.url : address || '').trim()
    setOpen(false)
    setHighlight(-1)
    setDirty(false)
    if (!value) {
      setAddress(urlRef.current)
      return
    }
    setAddress(value)
    post('navigate', { url: value })
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (open) {
        setOpen(false)
        setHighlight(-1)
        return
      }
      setDirty(false)
      setAddress(urlRef.current)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const list = itemsRef.current
      if (!list.length) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      if (!open) {
        setOpen(true)
        setHighlight(moveHighlight(-1, list.length, step))
        return
      }
      setHighlight(moveHighlight(highlight, list.length, step))
      return
    }
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      submit()
    }
  }

  // 复制 / 粘贴交给主进程：应用没有原生菜单，⌘V 不能指望系统编辑命令送到这个窗口
  useEffect(() => {
    const selected = () => {
      const dom = inputRef.current?.dom
      if (dom && typeof dom.selectionStart === 'number' && dom.selectionStart !== dom.selectionEnd) {
        return String(dom.value || '').slice(dom.selectionStart, dom.selectionEnd)
      }
      const selection = window.getSelection ? window.getSelection() : null
      return selection ? String(selection) : ''
    }
    const onKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const key = String(event.key).toLowerCase()
      if (key === 'v') {
        event.preventDefault()
        post('paste')
        return
      }
      if (key !== 'c') return
      const text = selected()
      if (!text) return
      event.preventDefault()
      post('copy', { text })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // Electron 默认不给页面右键菜单：有选中就复制选中的，没有就复制整条地址
  useEffect(() => {
    const onContextMenu = (event) => {
      const dom = inputRef.current?.dom
      const text =
        (dom && typeof dom.selectionStart === 'number' && dom.selectionStart !== dom.selectionEnd
          ? String(dom.value || '').slice(dom.selectionStart, dom.selectionEnd)
          : '') ||
        (event.target === dom ? String(dom?.value || '') : '')
      if (!text) return
      event.preventDefault()
      post('copy', { text })
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [])

  // 右侧只放当前页标题：标签页之间的切换归 agent（顶栏不放一排按钮——用户要的是
  // 一条能自己操作的地址栏，不是第二个标签管理器）。
  const pageTitle = String(state.title || '').trim()

  return (
    <div className="chrome-bar">
      <div className="chrome-nav">
        <ArcoAction
          iconOnly
          title="后退"
          aria-label="后退"
          disabled={!state.canGoBack}
          onClick={() => post('back')}
        >
          <ArrowLeft size={15} aria-hidden="true" />
        </ArcoAction>
        <ArcoAction
          iconOnly
          title="前进"
          aria-label="前进"
          disabled={!state.canGoForward}
          onClick={() => post('forward')}
        >
          <ArrowRight size={15} aria-hidden="true" />
        </ArcoAction>
        <ArcoAction iconOnly title="刷新" aria-label="刷新" onClick={() => post('reload')}>
          <RotateCw size={14} aria-hidden="true" />
        </ArcoAction>
      </div>
      <div className="chrome-address" ref={anchorRef}>
        <Input
          ref={inputRef}
          size="small"
          value={address}
          spellCheck={false}
          autoComplete="off"
          placeholder="输入网址"
          aria-label="地址"
          title={`${urlRef.current}\n输入网址后回车导航，Esc 取消`}
          onChange={handleChange}
          onFocus={beginEdit}
          onBlur={endEdit}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div className="chrome-title">
        {pageTitle ? (
          <span className="chrome-page-title" title={pageTitle}>
            {pageTitle}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export { INITIAL }
