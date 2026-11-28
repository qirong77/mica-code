import { Button, Input } from '@mica-config-ui/web'
import { IconHistory, IconLink, IconPlus, IconRefresh, IconSearch } from '@tabler/icons-react'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lazyView } from './lazy-view'
import {
  appendConversationDraft,
  conversationStateActivate,
  conversationStateBind,
  conversationStateKey,
  conversationStateWithItem,
  normalizeConversationState,
  isConversationTarget,
  RECENT_CONVERSATION_LIMIT
} from './plugin-conversation'
import { setUiState, setUiStateEntries, uiStateKeys, useUiStateValue } from './ui-state'
import { notify } from './notify'

// The embedded surface is the real ChatView, not a second chat implementation. Keep it lazy so
// plugins that only use the host data API do not pay for the chat bundle.
const LazyChatView = lazyView(() => import('./ChatView'), 'ChatView')

function draftId() {
  const random = globalThis.crypto?.randomUUID?.()
  return `plugin-draft-${random || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

function callbackError(error) {
  return error instanceof Error ? error.message : String(error || '未知错误')
}

function defaultOpenFile(path, position, options) {
  if (typeof window === 'undefined') return
  // The application shell listens for this event and opens its shared editor. A standalone page
  // has no editor instance, so use the runtime's explicit path action instead of silently doing
  // nothing (the action may open the file in the host machine's default editor).
  if (typeof window.__micaDesktopAction === 'function') {
    window.dispatchEvent(
      new CustomEvent('mica:open-file', { detail: { path, ...position, ...options } })
    )
    return
  }
  const openPath = window.mica?.files?.openPath
  if (typeof openPath !== 'function') {
    unavailable('打开文件')
    return
  }
  void Promise.resolve(openPath(path)).catch((error) => {
    notify({
      key: 'plugin-conversation-open-file',
      level: 'error',
      text: '打开文件失败',
      detail: callbackError(error)
    })
  })
}

function unavailable(label) {
  notify({
    key: `plugin-conversation:${label}`,
    level: 'warning',
    text: `${label}在独立插件页不可用`,
    detail: '请从 Mica 主页面打开这条操作。'
  })
}

/**
 * Build the component placed at `api.ui.Conversation`.
 *
 * The optional callbacks are supplied by the application page shell. They are intentionally
 * generic (file/settings/review), never tied to one plugin; a standalone plugin page gets the
 * explicit fallback notice instead of a button that silently does nothing.
 */
export function createPluginConversation(api, callbacks = {}) {
  function Conversation(props) {
    return (
      <PluginConversation
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

export function PluginConversation({
  api,
  scope = 'default',
  visible = true,
  reference = null,
  hostCallbacks = {}
}) {
  const pluginId = String(api?.pluginId || '').trim() || 'unknown'
  const scopeName = String(scope || '').trim() || 'default'
  const stateKey = useMemo(() => conversationStateKey(pluginId, scopeName), [pluginId, scopeName])
  const rawState = useUiStateValue(stateKey, null)
  const state = useMemo(() => normalizeConversationState(rawState), [rawState])
  const active = state.items.find((item) => item.key === state.activeId) || null
  const [resolved, setResolved] = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [recent, setRecent] = useState([])
  const [recentLoading, setRecentLoading] = useState(false)
  const [recentError, setRecentError] = useState('')
  const [loops, setLoops] = useState([])
  const creating = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const currentRef = useRef({ stateKey, itemKey: active?.key || null, nodeId: null })
  currentRef.current = {
    stateKey,
    itemKey: active?.key || null,
    nodeId: active?.nodeId || active?.sessionId || null
  }

  const writeState = useCallback(
    (next) => {
      setUiState(stateKey, normalizeConversationState(next))
    },
    [stateKey]
  )

  const updateItem = useCallback(
    (itemKey, patch) => {
      const current = normalizeConversationState(uiStateKeys()[stateKey])
      const item = current.items.find((entry) => entry.key === itemKey)
      if (!item) return
      writeState({
        ...current,
        items: current.items.map((entry) =>
          entry.key === itemKey ? { ...entry, ...patch } : entry
        )
      })
    },
    [stateKey, writeState]
  )

  // Resolve the stable real session back to the current workspace node. If the node was closed,
  // the host API deliberately falls back to the real session id, so refresh still recovers it.
  useEffect(() => {
    let alive = true
    if (!active) {
      setResolved(null)
      return undefined
    }
    if (!active.sessionId) {
      setResolved({ itemKey: active.key, nodeId: active.nodeId || null, cwd: active.cwd || null })
      // Another ChatView can receive the first-turn binding while this scope is unmounted.
      // Recover it from the shared workspace instead of treating its old node as a new session.
      if (active.nodeId && typeof api?.sessions?.resolve === 'function') {
        void api.sessions
          .resolve(active.nodeId)
          .then((result) => {
            if (alive && result?.sessionId && result.sessionId !== active.nodeId) {
              updateItem(active.key, {
                sessionId: result.sessionId,
                nodeId: result.nodeId || active.nodeId
              })
            }
          })
          .catch(() => {})
      }
      return () => {
        alive = false
      }
    }
    // Resolve before mounting; a stale node must not start a second host for the same session.
    setResolved(null)
    if (typeof api?.sessions?.resolve !== 'function') {
      setResolved({ itemKey: active.key, nodeId: active.sessionId, cwd: active.cwd || null })
      return undefined
    }
    Promise.resolve(api.sessions.resolve(active.sessionId, { nodeId: active.nodeId }))
      .then((result) => {
        if (!alive || !result?.nodeId) return
        setResolved({
          itemKey: active.key,
          nodeId: result.nodeId,
          cwd: result.cwd || active.cwd || null
        })
        if (result.nodeId !== active.nodeId || (result.cwd && result.cwd !== active.cwd)) {
          updateItem(active.key, {
            nodeId: result.nodeId,
            ...(result.cwd ? { cwd: result.cwd } : {})
          })
        }
      })
      .catch((error) => {
        if (alive)
          notify({
            key: `plugin-conversation-resolve:${stateKey}`,
            level: 'error',
            text: '定位会话失败，请从历史中重新选择',
            detail: callbackError(error)
          })
      })
    return () => {
      alive = false
    }
  }, [active?.key, active?.nodeId, active?.sessionId, active?.cwd, api?.sessions, updateItem])

  const nodeId = resolved && resolved.itemKey === active?.key ? resolved.nodeId : null
  const cwd = resolved && resolved.itemKey === active?.key ? resolved.cwd : active?.cwd || null
  const node = nodeId
    ? {
        id: nodeId,
        parent: '#',
        text: active?.title || '新对话',
        type: 'terminal',
        sessionId: active?.sessionId || null,
        cwd: cwd || null,
        state: { opened: false, selected: true }
      }
    : null
  // Use the resolved workspace node for async reference insertion. A session can be restored to
  // a different node after a refresh; writing the reference to the old node would make it look
  // as if the reference disappeared from the visible composer.
  currentRef.current = { stateKey, itemKey: active?.key || null, nodeId: nodeId || null, visible }

  // Keep the full ChatView's timer/session settings useful in a standalone page too. Loops are
  // runtime-owned, so this only reads and subscribes to the generic loop channel; it does not
  // create a plugin-specific scheduler.
  useEffect(() => {
    if (
      !nodeId ||
      typeof window === 'undefined' ||
      typeof window.mica?.loops?.list !== 'function'
    ) {
      setLoops([])
      return undefined
    }
    let alive = true
    const apply = (result) => {
      if (!alive) return
      const rows = Array.isArray(result?.loops) ? result.loops : []
      setLoops(rows.filter((row) => row?.nodeId === nodeId))
    }
    const refresh = () =>
      void window.mica.loops
        .list()
        .then(apply)
        .catch(() => {})
    refresh()
    const off = window.mica.loops.onChanged?.((payload) => apply(payload))
    return () => {
      alive = false
      off?.()
    }
  }, [nodeId])

  const addConversation = useCallback(
    (result, options = {}) => {
      const id = typeof result === 'string' ? result : result?.id
      if (!id || !mounted.current || currentRef.current.stateKey !== stateKey) return null
      const now = Date.now()
      const key = `${stateKey}:${draftId()}`
      const item = {
        key,
        nodeId: id,
        title: options.title || result?.title || '新对话',
        ...(options.cwd || result?.cwd ? { cwd: options.cwd || result.cwd } : {}),
        createdAt: now,
        updatedAt: now
      }
      const current = normalizeConversationState(uiStateKeys()[stateKey])
      writeState(conversationStateWithItem(current, item))
      return id
    },
    [stateKey, writeState]
  )

  const createConversation = useCallback(
    async (options = {}) => {
      if (creating.current) return null
      creating.current = true
      try {
        const cwdValue =
          typeof options.cwd === 'string' && options.cwd.trim() ? options.cwd.trim() : null
        let result
        if (typeof hostCallbacks.createSession === 'function') {
          result = hostCallbacks.createSession({ cwd: cwdValue, forceNew: true })
        } else if (typeof api?.sessions?.create === 'function') {
          result = await api.sessions.create({ cwd: cwdValue })
        } else {
          throw new Error('当前宿主不能创建 Mica 会话')
        }
        return addConversation(result, { cwd: cwdValue })
      } catch (error) {
        notify({
          key: `plugin-conversation-create:${stateKey}`,
          level: 'error',
          text: '新建对话失败',
          detail: callbackError(error)
        })
        return null
      } finally {
        creating.current = false
      }
    },
    [addConversation, api?.sessions, hostCallbacks.createSession, stateKey]
  )

  // ChatView's `/new` command is synchronous by design. The application shell can synchronously
  // allocate the same workspace node; standalone pages use the explicit async New conversation
  // button instead and receive a visible explanation rather than a no-op.
  const onNewSession = useCallback(
    (nextCwd) => {
      if (typeof hostCallbacks.createSession !== 'function') {
        unavailable('新建会话')
        return null
      }
      try {
        const result = hostCallbacks.createSession({ cwd: nextCwd || cwd || null, forceNew: true })
        const id = addConversation(result, { cwd: nextCwd || cwd || null })
        if (!id) unavailable('新建会话')
        return id
      } catch (error) {
        notify({
          key: `plugin-conversation-new:${stateKey}`,
          level: 'error',
          text: '新建对话失败',
          detail: callbackError(error)
        })
        return null
      }
    },
    [addConversation, cwd, hostCallbacks.createSession, stateKey]
  )

  const selectSession = useCallback(
    (session) => {
      const current = normalizeConversationState(uiStateKeys()[stateKey])
      const scopeItem =
        typeof session?.key === 'string'
          ? current.items.find((item) => item.key === session.key)
          : null
      if (scopeItem) {
        writeState(conversationStateActivate(current, scopeItem.key))
        return
      }
      const id =
        typeof (session?.id || session?.sessionId) === 'string'
          ? String(session.id || session.sessionId).trim()
          : ''
      if (!id || currentRef.current.stateKey !== stateKey) return
      const existing = current.items.find((item) => item.sessionId === id)
      if (existing) {
        writeState(conversationStateActivate(current, existing.key))
        return
      }
      const item = {
        key: `${stateKey}:session:${id}`,
        sessionId: id,
        nodeId: typeof session.nodeId === 'string' ? session.nodeId : id,
        title: session.title || id,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        updatedAt: Date.now()
      }
      writeState(conversationStateWithItem(current, item))
    },
    [stateKey, writeState]
  )

  const selectRecent = useCallback(
    (session) => {
      selectSession(session)
      setHistoryOpen(false)
      setQuery('')
    },
    [selectSession]
  )

  const loadRecent = useCallback(async () => {
    if (typeof api?.sessions?.list !== 'function') {
      setRecentError('当前宿主没有会话历史')
      return
    }
    setRecentLoading(true)
    setRecentError('')
    try {
      const rows = await api.sessions.list({ limit: RECENT_CONVERSATION_LIMIT })
      if (!mounted.current || currentRef.current.stateKey !== stateKey) return
      setRecent(rows)
      const titles = new Map(rows.map((row) => [row.id, row]))
      const current = normalizeConversationState(uiStateKeys()[stateKey])
      const items = current.items.map((item) => {
        const row = item.sessionId ? titles.get(item.sessionId) : null
        return row
          ? { ...item, title: row.title || item.title, ...(row.cwd ? { cwd: row.cwd } : {}) }
          : item
      })
      writeState({ ...current, items })
    } catch (error) {
      setRecentError(callbackError(error))
    } finally {
      setRecentLoading(false)
    }
  }, [api?.sessions, stateKey, writeState])

  const toggleHistory = useCallback(() => {
    setHistoryOpen((open) => {
      if (!open) void loadRecent()
      return !open
    })
  }, [loadRecent])

  const onSessionBound = useCallback(
    (boundNodeId, sessionId) => {
      const realId = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (!realId || !boundNodeId) return
      const current = normalizeConversationState(uiStateKeys()[stateKey])
      if (!current.items.some((entry) => entry.nodeId === boundNodeId)) return
      writeState(conversationStateBind(current, boundNodeId, realId))
      api.sessions?.bind?.({ nodeId: boundNodeId, sessionId: realId })
    },
    [api?.sessions, stateKey, writeState]
  )

  const onResumeSession = useCallback(
    (session) => {
      selectSession(session)
      return session?.id || null
    },
    [selectSession]
  )

  const appendReference = useCallback(async () => {
    const source = reference
    const target = currentRef.current
    if (!source?.getText || !target.nodeId || !target.visible) return
    try {
      const text = await source.getText()
      if (!mounted.current || !isConversationTarget(currentRef.current, target)) return
      const value = String(text ?? '')
      if (!value) return
      const drafts = uiStateKeys().drafts
      const currentDraft = drafts && typeof drafts === 'object' ? drafts[target.nodeId] : ''
      setUiStateEntries('drafts', {
        [target.nodeId]: appendConversationDraft(currentDraft || '', value)
      })
    } catch (error) {
      notify({
        key: `plugin-conversation-reference:${stateKey}`,
        level: 'error',
        text: '读取引用失败',
        detail: callbackError(error)
      })
    }
  }, [reference, stateKey])

  const callbacks = {
    onOpenFile: hostCallbacks.onOpenFile || defaultOpenFile,
    onOpenDocument: hostCallbacks.onOpenDocument || (() => unavailable('在编辑器中打开')),
    onOpenReview: hostCallbacks.onOpenReview || (() => unavailable('打开评审')),
    onNewSession,
    onResumeSession,
    onOpenTerminal: hostCallbacks.onOpenTerminal
      ? () => hostCallbacks.onOpenTerminal({ nodeId, sessionId: active?.sessionId || null, cwd })
      : () => unavailable('打开终端'),
    onOpenSettings: hostCallbacks.onOpenSettings || (() => unavailable('打开 Mica 设置')),
    onOpenPluginSettings:
      hostCallbacks.onOpenPluginSettings ||
      (() => {
        if (typeof api?.launcher?.configure === 'function') {
          void Promise.resolve(api.launcher.configure()).catch(() => unavailable('打开插件设置'))
        } else unavailable('打开插件设置')
      }),
    onSessionRenamed: hostCallbacks.onSessionRenamed,
    onShareSession: hostCallbacks.onShareSession || (() => unavailable('分享会话'))
  }

  const filteredScope = state.items
    .slice()
    .reverse()
    .filter((item) => matchesConversation(item, query))
    .map((item) => ({ ...item, source: 'scope' }))
  const knownSessionIds = new Set(state.items.map((item) => item.sessionId).filter(Boolean))
  const filteredRecent = recent
    .filter((item) => !knownSessionIds.has(item.id) && matchesConversation(item, query))
    .map((item) => ({ ...item, source: 'recent' }))
  const isMobile =
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px)').matches

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas text-fg">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-panel px-2 py-1">
        <Button
          size="compact"
          variant="ghost"
          icon={<IconPlus size={13} />}
          onClick={() => void createConversation({ cwd })}
        >
          新建对话
        </Button>
        <Button
          size="compact"
          variant={historyOpen ? 'primary' : 'ghost'}
          icon={<IconHistory size={13} />}
          onClick={toggleHistory}
        >
          历史
        </Button>
        {reference?.getText && (
          <Button
            size="compact"
            variant="ghost"
            icon={<IconLink size={13} />}
            disabled={!nodeId}
            onClick={() => void appendReference()}
          >
            {reference.label || '引用当前范围'}
          </Button>
        )}
        <span
          className="ml-auto min-w-0 truncate text-[11px] text-fg-dim"
          title={active?.title || ''}
        >
          {active ? active.title : '尚未选择对话'}
        </span>
      </div>
      {historyOpen && (
        <section
          className="flex max-h-64 shrink-0 flex-col gap-1 border-b border-line bg-panel px-2 py-1.5"
          aria-label="对话历史"
        >
          <div className="flex items-center gap-1">
            <Input
              value={query}
              onChange={setQuery}
              placeholder="搜索当前范围与最近会话"
              aria-label="搜索会话"
              prefix={<IconSearch size={13} />}
              className="min-w-0 flex-1"
            />
            <Button
              size="compact"
              variant="ghost"
              iconOnly
              title="刷新最近会话"
              aria-label="刷新最近会话"
              onClick={() => void loadRecent()}
            >
              <IconRefresh size={13} />
            </Button>
          </div>
          <div className="min-h-0 overflow-y-auto" role="listbox" aria-label="可恢复的会话">
            {filteredScope.map((item) => (
              <ConversationRow
                key={`scope:${item.key}`}
                item={item}
                active={item.key === state.activeId}
                onClick={() => selectRecent(item)}
              />
            ))}
            {filteredRecent.map((item) => (
              <ConversationRow
                key={`recent:${item.id}`}
                item={item}
                active={false}
                onClick={() => selectRecent(item)}
              />
            ))}
            {recentLoading && <p className="px-2 py-1 text-xs text-fg-dim">正在读取最近会话…</p>}
            {!recentLoading && recentError && (
              <p className="px-2 py-1 text-xs text-danger">读取最近会话失败：{recentError}</p>
            )}
            {!recentLoading &&
              !recentError &&
              filteredScope.length === 0 &&
              filteredRecent.length === 0 && (
                <p className="px-2 py-1 text-xs text-fg-dim">没有匹配的会话</p>
              )}
          </div>
          <p className="text-[10px] text-fg-dim">
            最近会话最多显示 {RECENT_CONVERSATION_LIMIT} 条；旧历史不会被删除。
          </p>
        </section>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {node ? (
          <Suspense
            fallback={
              <div className="grid min-h-0 flex-1 place-items-center text-xs text-fg-dim">
                正在加载 Mica 对话…
              </div>
            }
          >
            <LazyChatView
              node={node}
              cwd={cwd}
              visible={visible}
              isMobile={isMobile}
              loops={loops}
              onSessionBound={onSessionBound}
              onOpenFile={callbacks.onOpenFile}
              onOpenDocument={callbacks.onOpenDocument}
              onOpenReview={callbacks.onOpenReview}
              onNewSession={callbacks.onNewSession}
              onResumeSession={callbacks.onResumeSession}
              onOpenTerminal={callbacks.onOpenTerminal}
              onOpenSettings={callbacks.onOpenSettings}
              onOpenPluginSettings={callbacks.onOpenPluginSettings}
              onSessionRenamed={callbacks.onSessionRenamed}
              onShareSession={callbacks.onShareSession}
            />
          </Suspense>
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center px-4 text-center text-xs text-fg-dim">
            <div>
              <p>{active ? '正在定位 Mica 会话…' : '这个范围还没有 Mica 对话。'}</p>
              <p className="mt-1">
                {active
                  ? '也可以从历史中重新选择，或新建对话。'
                  : '点击“新建对话”，或从历史中恢复一条会话。'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function matchesConversation(item, query) {
  const needle = String(query || '')
    .trim()
    .toLocaleLowerCase()
  if (!needle) return true
  return `${item?.title || ''} ${item?.id || ''} ${item?.sessionId || ''} ${item?.cwd || ''}`
    .toLocaleLowerCase()
    .includes(needle)
}

function ConversationRow({ item, active, onClick }) {
  const id = item.id || item.sessionId || item.nodeId
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={`mica-arco-row flex w-full min-w-0 flex-col items-start rounded px-2 py-1 text-left text-xs ${active ? 'bg-overlay' : ''}`}
      onClick={onClick}
    >
      <span className="w-full truncate text-fg-strong">{item.title || '未命名会话'}</span>
      <span className="w-full truncate text-[10px] text-fg-dim" title={item.cwd || id || ''}>
        {item.cwd || id || '当前范围'}
      </span>
    </button>
  )
}
