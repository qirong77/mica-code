import { ArcoAction } from '@mica-config-ui/web'
import { Suspense, useCallback, useMemo, useRef, useState } from 'react'
import { IconArrowLeft, IconCheck, IconCopy } from '@tabler/icons-react'
import { pluginPagePath } from '@packages/mica-web-shared/index.js'
import { createPluginHostApi } from './plugin-host'
import { useIsMobile } from './hooks'
import { notify } from './notify'
import { lazyView } from './lazy-view'
import { PluginSurface } from './PluginSurface'

// 插件只依赖宿主组件能力，不直接 import ChatView 或另造对话渲染器。
const EMPTY_CALLBACKS = Object.freeze({})
const PageMarkdown = lazyView(() => import('./ChatView'), 'Markdown')
// Notebook 等不嵌入对话的页面不应为 Conversation 把 ChatView 相关代码带进首屏。
// 只有插件实际渲染 api.ui.Conversation 时，外层 PluginPage 的 Suspense 才会触发这次加载。
const LazyPluginConversation = lazyView(() => import('./PluginConversation'), 'PluginConversation')

function createLazyPluginConversation(api, callbacks = {}) {
  function Conversation(props) {
    return (
      <LazyPluginConversation
        key={props.scope || 'default'}
        {...props}
        api={api}
        hostCallbacks={callbacks}
      />
    )
  }
  Conversation.displayName = 'MicaPluginConversation'
  return Conversation
}
function PluginMarkdown(props) {
  return (
    <Suspense fallback={<div className="chat-markdown whitespace-pre-wrap">{props.text}</div>}>
      <PageMarkdown {...props} />
    </Suspense>
  )
}

/**
 * 插件整页（清单 `desktop.page`）。
 *
 * 宿主只画外面这层壳：地址、返回、标题，以及把 `api` 交给插件自己的 `Page` 组件。
 * 与配置页同一套做法——盖住整个窗口、左上角一个返回——因为整页的用途就是要宽度和高度
 * （时间轴、表格），塞进对话区右侧只会把它挤成鸡肋。
 *
 * 整页同时是一个**真地址**：`/plugins/pages/<插件 id>` 由运行时提供同一份产物（见
 * `mica-web-shared` 的 `pluginPagePath`），所以这里显示的地址既可复制，也能直接
 * 在浏览器里打开——那是同一个页面、同一条插件数据。页面内切换内容（例如笔记换了
 * 一篇）用 `api.page.setSearch()` 同步到地址栏，深链因此可刷新、可分享。
 *
 * 这里不认识任何具体插件：页面标题来自清单，内容来自插件目录的 `desktop.jsx`。
 */
export function PluginPage({
  entry,
  onClose,
  onCreateSession,
  conversationCallbacks = EMPTY_CALLBACKS,
  onSessionBound,
  standalone = false
}) {
  const isMobile = useIsMobile()
  const hasMacWindowControls = window.micaClient && navigator.platform.startsWith('Mac')
  const beforeClose = useMemo(() => new Set(), [entry.id])
  const closing = useRef(false)
  // 当前地址的查询参数：初值来自浏览器地址（深链），之后由插件通过 `api.page.setSearch` 改写。
  const [search, setSearch] = useState(() => (standalone ? window.location.search : ''))
  const searchRef = useRef(search)
  searchRef.current = search
  const pagePath = pluginPagePath(entry.id, entry.page.route)
  const address = `${window.location.origin}${pagePath}${search}`

  /**
   * 同步页面当前定位到地址栏。
   *
   * 独立打开（地址就是这个页面）时连浏览器地址一起改，刷新 / 复制链接都落在同一处；
   * 从应用里打开时只改显示的那一行，应用自己的地址不能被插件页顶掉（返回之后还要
   * 回到对话）。
   */
  const setPageSearch = useCallback(
    (values) => {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(values || {})) {
        const text = value == null ? '' : String(value)
        if (text) params.set(key, text)
      }
      const next = params.toString() ? `?${params.toString()}` : ''
      setSearch(next)
      if (standalone) {
        try {
          window.history.replaceState(null, '', `${pagePath}${next}`)
        } catch {
          // replaceState 在极少数沙箱环境里会抛，地址栏保持上一次的值不影响功能
        }
      }
    },
    [pagePath, standalone]
  )

  const hostApi = useMemo(
    () =>
      createPluginHostApi(entry.id, null, {
        createSession: onCreateSession,
        bindSession: onSessionBound
      }),
    [entry.id, onCreateSession, onSessionBound]
  )
  const close = useCallback(async () => {
    if (closing.current) return false
    closing.current = true
    try {
      for (const handler of beforeClose) if ((await handler()) === false) return false
      hostApi.experience('dismiss', { surface: 'page', action: 'close' })
      onClose()
      return true
    } catch (error) {
      notify({
        key: `plugin-page-close:${entry.id}`,
        text: '页面暂时无法关闭',
        detail: error?.message || String(error),
        level: 'error'
      })
      return false
    } finally {
      closing.current = false
    }
  }, [beforeClose, entry.id, hostApi, onClose])
  const Conversation = useMemo(() => {
    const callbacks = { ...conversationCallbacks, createSession: onCreateSession }
    for (const name of [
      'onOpenFile',
      'onOpenDocument',
      'onOpenReview',
      'onOpenTerminal',
      'onOpenSettings',
      'onOpenPluginSettings'
    ]) {
      const action = callbacks[name]
      if (typeof action !== 'function') continue
      callbacks[name] = async (...args) => {
        if (await close()) return action(...args)
      }
    }
    return createLazyPluginConversation(hostApi, callbacks)
  }, [close, conversationCallbacks, hostApi, onCreateSession])
  const api = useMemo(
    () => ({
      ...hostApi,
      ui: { Markdown: PluginMarkdown, Conversation },
      page: {
        beforeClose(handler) {
          beforeClose.add(handler)
          return () => beforeClose.delete(handler)
        },
        /** 这个页面可被打开的完整地址；带 `values` 时按它拼查询参数。 */
        url(values) {
          const params = new URLSearchParams()
          for (const [key, value] of Object.entries(values || {})) {
            const text = value == null ? '' : String(value)
            if (text) params.set(key, text)
          }
          const query = params.toString()
          return `${window.location.origin}${pagePath}${query ? `?${query}` : ''}`
        },
        /** 打开这个页面时的查询参数（深链）；没带就是空对象。 */
        search() {
          const params = new URLSearchParams(searchRef.current)
          return Object.fromEntries(params.entries())
        },
        setSearch: setPageSearch
      }
    }),
    [Conversation, hostApi, beforeClose, pagePath, setPageSearch]
  )
  const Page = entry.module.Page ?? entry.module.default

  return (
    <div className="no-drag fixed inset-0 z-[9500] flex flex-col bg-canvas">
      <header className="drag-region grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-2 border-b border-line bg-panel px-2">
        <div
          className={`flex min-w-0 items-center gap-2 ${isMobile ? 'col-span-3' : ''} ${hasMacWindowControls ? 'pl-20' : ''}`}
        >
          <ArcoAction
            type="button"
            title={standalone ? '打开 Mica' : '返回对话'}
            aria-label={standalone ? '打开 Mica' : '返回对话'}
            className="no-drag flex h-6 shrink-0 items-center gap-1 px-1.5 transition-colors"
            onClick={close}
          >
            <IconArrowLeft size={13} />
            <span className="text-xs">{standalone ? '打开 Mica' : '返回对话'}</span>
          </ArcoAction>
          <span className="min-w-0 truncate text-xs font-medium text-fg-strong">
            {entry.page.title || entry.label}
          </span>
        </div>
        {!isMobile && (
          <div className="no-drag flex h-5 min-w-0 max-w-[min(560px,45vw)] items-center gap-1 rounded border border-line bg-canvas px-2">
            <span
              className="min-w-0 select-text truncate font-mono text-[11px] leading-none text-fg-muted"
              title={address}
            >
              {address}
            </span>
            <CopyAddress address={address} />
          </div>
        )}
      </header>
      {/* is-fill 让插件内容占满标题栏以下的空间。 */}
      <div className="mica-config-ui is-embed is-fill min-h-0 flex-1 overflow-hidden">
        <Suspense
          fallback={
            <div className="grid h-full place-items-center text-xs text-fg-muted">正在加载…</div>
          }
        >
          <PluginSurface api={api} surface="page" className="h-full min-h-0">
            <Page api={api} onClose={close} />
          </PluginSurface>
        </Suspense>
      </div>
    </div>
  )
}

/** 复制整页地址：桌面应用窗口里没有地址栏，这一枚是把它带出去的唯一入口。 */
function CopyAddress({ address }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title="复制地址"
      aria-label="复制地址"
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:text-fg-strong"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        } catch (error) {
          notify({
            key: 'plugin-page-copy',
            text: '复制地址失败',
            detail: error?.message || String(error),
            level: 'error'
          })
        }
      }}
    >
      {copied ? <IconCheck size={11} /> : <IconCopy size={11} />}
    </button>
  )
}
