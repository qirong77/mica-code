import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Loader2, X } from 'lucide-react'
import { usePluginPanels } from './plugin-panels'

/**
 * 对话右侧的插件面板：仓库侧那一条按钮 + 点开的抽屉。
 *
 * 宿主不认识任何具体插件——按钮来自清单（`desktop.panel`），抽屉里的内容是插件给的
 * **数据**（`ctx.desktop.panel()` 返回的视图：标题、只读行、条目、输入框、按钮），
 * 宿主只负责画与回传动作。这样用户装在自己 `$MICA_HOME/plugins` 里的插件也能有界面，
 * 而它没有、也不需要前端模块。
 *
 * 视图里没有富文本：插件要表达「一个频道、一条建议、一次运行结果」，都落到条目与行上。
 * 每个 section 画成一块独立的折叠卡片，插件用 `collapsed` 决定初始状态。
 */

/** 打开时每隔一会儿重新取一次视图：插件有自己的定时器（复盘），界面得跟上。 */
const REFRESH_MS = 4000

/**
 * 输入框上方那排快捷按钮（悬浮在输入框之上，左对齐）。
 *
 * 按钮来自清单 `desktop.panel.shortcuts`：`action` 点了直接把动作交给插件（例如「立刻
 * 检查」立刻投递一轮），`section` 点了打开面板并展开那一块（频道设置 / 复盘设置）。
 * 插件因此能把「马上要做的事」和「要改的配置」分开放，而宿主只管渲染。
 */
export function PluginQuickBar({
  nodeId,
  sessionId,
  cwd,
  role,
  openPlugin,
  focusSection,
  onTogglePanel
}) {
  const panels = usePluginPanels(role)
  const [pending, setPending] = useState('')
  // 动作可以回一句话（「先添加频道」这类）：显示在按钮旁边，几秒后自己消失。
  const [feedback, setFeedback] = useState('')
  useEffect(() => {
    if (!feedback) return undefined
    const timer = setTimeout(() => setFeedback(''), 4000)
    return () => clearTimeout(timer)
  }, [feedback])
  const items = []
  for (const panel of panels) {
    for (const shortcut of panel.shortcuts) {
      items.push({ panel, shortcut, key: `${panel.id}:${shortcut.label}` })
    }
  }
  if (items.length === 0) return null

  const runShortcut = async (panel, shortcut) => {
    if (shortcut.section) {
      const active = openPlugin === panel.id && focusSection === shortcut.section
      onTogglePanel(active ? '' : panel.id, active ? '' : shortcut.section)
      return
    }
    if (pending) return
    setPending(shortcut.action)
    try {
      const result = await window.mica.chat.pluginPanels
        .action(nodeId, {
          pluginId: panel.id,
          action: shortcut.action,
          sessionId,
          cwd
        })
        .catch((cause) => ({ ok: false, error: String(cause?.message || cause) }))
      setFeedback(result?.ok === false ? result.error || '动作失败' : result?.message || '')
    } finally {
      setPending('')
    }
  }

  return (
    <div className="chat-plugin-quickbar" role="toolbar" aria-label="插件快捷操作">
      {items.map(({ panel, shortcut, key }) => {
        const active =
          Boolean(shortcut.section) && openPlugin === panel.id && focusSection === shortcut.section
        return (
          <button
            key={key}
            type="button"
            title={
              shortcut.section
                ? `${active ? '收起' : '打开'}「${shortcut.label}」`
                : `${panel.label} · ${shortcut.label}`
            }
            aria-pressed={active}
            disabled={Boolean(pending)}
            className={[
              'chat-plugin-quickbar-button',
              shortcut.action ? 'is-primary' : '',
              active ? 'is-active' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => void runShortcut(panel, shortcut)}
          >
            {pending === shortcut.action ? '…' : shortcut.label}
          </button>
        )
      })}
      {feedback && (
        <span className="chat-plugin-quickbar-note" role="status">
          {feedback}
        </span>
      )}
    </div>
  )
}

/** 抽屉本体：只画 `openPlugin` 指定的那一块。 */
export function PluginPanels({ nodeId, sessionId, cwd, role, openPlugin, focusSection, onClose }) {
  const panels = usePluginPanels(role)
  const open = panels.find((panel) => panel.id === openPlugin) || null

  // 角色换掉（或插件被停用）时收起：面板是按角色出现的，留着会变成一块无主的浮层
  useEffect(() => {
    if (openPlugin && !open) onClose()
  }, [onClose, open, openPlugin])

  if (!open) return null
  return (
    <PluginPanelDock
      key={open.id}
      pluginId={open.id}
      label={open.label}
      nodeId={nodeId}
      sessionId={sessionId}
      cwd={cwd}
      focusSection={focusSection}
      onClose={onClose}
    />
  )
}

function PluginPanelDock({ pluginId, label, nodeId, sessionId, cwd, focusSection, onClose }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [drafts, setDrafts] = useState({})
  const [collapsed, setCollapsed] = useState({})
  const aliveRef = useRef(true)

  // 分区动作也能回一句话（注册成功/失败原因）：显示在面板顶部，几秒后自己消失。
  const [feedback, setFeedback] = useState('')
  useEffect(() => {
    if (!feedback) return undefined
    const timer = setTimeout(() => setFeedback(''), 8000)
    return () => clearTimeout(timer)
  }, [feedback])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const applyView = useCallback((result, { resetDrafts = false } = {}) => {
    if (!aliveRef.current) return
    if (result?.ok && result.view) {
      setView(result.view)
      setError('')
      if (!resetDrafts) return
      // 只在动作之后把草稿对齐到视图：定时刷新若也重置，用户正在输入的字会被清掉
      const next = {}
      for (const section of result.view.sections || []) {
        for (const field of section.fields || []) next[field.key] = field.value ?? ''
      }
      setDrafts(next)
    } else {
      setError(result?.error || '插件面板不可用')
    }
  }, [])

  const load = useCallback(async () => {
    const result = await window.mica.chat.pluginPanels
      .view(nodeId, { pluginId, sessionId, cwd })
      .catch((cause) => ({ ok: false, error: String(cause?.message || cause) }))
    applyView(result)
  }, [applyView, cwd, nodeId, pluginId, sessionId])

  useEffect(() => {
    // 首次打开要带一次字段初值，之后的刷新只更新状态行/条目
    void window.mica.chat.pluginPanels
      .view(nodeId, { pluginId, sessionId, cwd })
      .catch((cause) => ({ ok: false, error: String(cause?.message || cause) }))
      .then((result) => applyView(result, { resetDrafts: true }))
    const timer = setInterval(() => {
      // 抽屉开着才刷新：关掉之后没有任何人看它，不该每 4 秒叫醒一次会话 host
      if (typeof document !== 'undefined' && document.hidden) return
      void load()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [applyView, cwd, load, nodeId, pluginId, sessionId])

  const runAction = useCallback(
    async (action, key) => {
      setBusy(key ? `${action}:${key}` : action)
      const result = await window.mica.chat.pluginPanels
        .action(nodeId, { pluginId, action, key, values: drafts, sessionId, cwd })
        .catch((cause) => ({ ok: false, error: String(cause?.message || cause) }))
      setBusy('')
      applyView(result, { resetDrafts: true })
      setFeedback(result?.ok === false ? result.error || '动作失败' : result?.message || '')
    },
    [applyView, cwd, drafts, nodeId, pluginId, sessionId]
  )

  const sections = useMemo(() => view?.sections || [], [view])
  const statusTone = view?.status?.tone || 'muted'

  // 折叠状态按 section 标题记：新出现的块用插件给的 `collapsed` 初始化，之后的定时刷新
  // 不覆盖用户已经点开/收起的选择（刷新换的是数组，不是用户的意图）。
  // 快捷按钮指定了 `focusSection` 时反过来——那是用户刚刚点名要看的那一块。
  const sectionKeys = useMemo(
    () => sections.map((section, index) => section.title || `section-${index}`),
    [sections]
  )

  // `focusSection` 只在它变化时生效一次：否则每 4 秒刷新都会把用户刚点开的其它块重新收起。
  const appliedFocusRef = useRef(null)

  useEffect(() => {
    if (sections.length === 0) return
    const focusKey = focusSection ? `${pluginId}:${focusSection}` : ''
    if (appliedFocusRef.current === focusKey) return
    appliedFocusRef.current = focusKey
    setCollapsed((previous) => {
      let changed = false
      const next = { ...previous }
      sections.forEach((section, index) => {
        const key = sectionKeys[index]
        const target = focusSection ? key !== focusSection : section.collapsed === true
        if (focusSection) {
          if (next[key] !== target) {
            next[key] = target
            changed = true
          }
          return
        }
        if (key in next) return
        next[key] = target
        changed = true
      })
      return changed ? next : previous
    })
  }, [focusSection, pluginId, sectionKeys, sections])

  const toggleSection = useCallback((key) => {
    setCollapsed((previous) => ({ ...previous, [key]: !previous[key] }))
  }, [])

  return (
    <aside className="chat-plugin-dock" aria-label={`${view?.title || label} 插件面板`}>
      <header className="chat-plugin-dock-head">
        <div className="chat-plugin-dock-title">
          <span>{view?.title || label}</span>
          {view?.status && (
            <span className={`chat-plugin-chip tone-${statusTone}`}>{view.status.label}</span>
          )}
        </div>
        <button type="button" className="chat-plugin-close" title="收起" onClick={onClose}>
          <X size={13} />
        </button>
      </header>
      {view?.subtitle && <p className="chat-plugin-dock-subtitle">{view.subtitle}</p>}
      {feedback && (
        <p className="chat-plugin-feedback" role="status">
          {feedback}
        </p>
      )}
      <div className="chat-plugin-dock-body">
        {error && <p className="chat-plugin-error">{error}</p>}
        {!view && !error && (
          <p className="chat-plugin-empty">
            <Loader2 size={12} className="chat-plugin-spin" /> 正在读取…
          </p>
        )}
        {sections.map((section, index) => {
          const key = sectionKeys[index]
          return (
            <PluginPanelSection
              key={key}
              section={section}
              collapsed={collapsed[key] === true}
              onToggle={() => toggleSection(key)}
              drafts={drafts}
              setDrafts={setDrafts}
              commit={section.commit ? () => runAction(section.commit) : null}
              busy={busy}
              runAction={runAction}
            />
          )
        })}
      </div>
    </aside>
  )
}

/**
 * 声明了 `commit` 的 section（设置类）在输入停顿后自己提交，用户不用再点按钮；
 * 没声明的仍靠 section 底部的动作按钮带上 `values`。
 */
const COMMIT_DELAY_MS = 500

/** 一块折叠卡片：标题行可点，内容只在展开时渲染。 */
function PluginPanelSection({
  section,
  collapsed,
  onToggle,
  drafts,
  setDrafts,
  commit,
  busy,
  runAction
}) {
  const toggleable = Boolean(section.title)
  const commitTimer = useRef(null)
  // 计时器要调「最新一次渲染」的提交回调：它闭包里带着最新的字段值，
  // 直接用 onChange 那一刻的回调会把改动前的 drafts 提交上去。
  const commitRef = useRef(commit)
  commitRef.current = commit

  useEffect(() => () => clearTimeout(commitTimer.current), [])

  const changeDraft = (key, value) => {
    setDrafts((previous) => ({ ...previous, [key]: value }))
    if (!commit) return
    clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(() => void commitRef.current?.(), COMMIT_DELAY_MS)
  }

  return (
    <section className={`chat-plugin-section ${collapsed ? 'is-collapsed' : ''}`}>
      {section.title &&
        (toggleable ? (
          <button
            type="button"
            className="chat-plugin-section-head"
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            <ChevronRight size={12} className="chat-plugin-section-chevron" />
            <span className="chat-plugin-section-title">{section.title}</span>
          </button>
        ) : (
          <div className="chat-plugin-section-head">
            <span className="chat-plugin-section-title">{section.title}</span>
          </div>
        ))}
      {!collapsed && (
        <div className="chat-plugin-section-body">
          {section.rows?.length > 0 && (
            <dl className="chat-plugin-rows">
              {section.rows.map((row) => (
                <div className="chat-plugin-row" key={row.label}>
                  <dt>{row.label}</dt>
                  <dd className={row.tone ? `tone-${row.tone}` : undefined} title={row.value}>
                    {row.value ?? '—'}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {section.items && section.items.length > 0 && (
            <ul className="chat-plugin-items">
              {section.items.map((item) => (
                <li className="chat-plugin-item" key={item.key}>
                  <div className="chat-plugin-item-main">
                    <span className={`chat-plugin-item-label tone-${item.tone || 'muted'}`}>
                      {item.label}
                    </span>
                    {item.value && (
                      <span className="chat-plugin-item-value" title={item.value}>
                        {item.value}
                      </span>
                    )}
                  </div>
                  {item.actions?.length > 0 && (
                    <div className="chat-plugin-item-actions">
                      {item.actions.map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          className={`chat-plugin-button tone-${action.tone || 'ghost'}`}
                          disabled={action.disabled || Boolean(busy)}
                          onClick={() => void runAction(action.id, item.key)}
                        >
                          {busy === `${action.id}:${item.key}` ? '…' : action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {section.items && section.items.length === 0 && section.empty && (
            <p className="chat-plugin-empty">{section.empty}</p>
          )}
          {section.fields?.length > 0 && (
            <div className="chat-plugin-fields">
              {section.fields.map((field) => (
                <label className="chat-plugin-field" key={field.key}>
                  <span className="chat-plugin-field-label">{field.label}</span>
                  <input
                    className="chat-plugin-input"
                    type="text"
                    inputMode={field.type === 'number' ? 'numeric' : undefined}
                    value={drafts[field.key] ?? ''}
                    placeholder={field.placeholder || ''}
                    onChange={(event) => changeDraft(field.key, event.target.value)}
                  />
                  {field.hint && <span className="chat-plugin-field-hint">{field.hint}</span>}
                </label>
              ))}
            </div>
          )}
          {section.actions?.length > 0 && (
            <div className="chat-plugin-actions">
              {section.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  title={action.hint || action.label}
                  className={`chat-plugin-button tone-${action.tone || 'ghost'}`}
                  disabled={action.disabled || Boolean(busy)}
                  onClick={() => void runAction(action.id)}
                >
                  {busy === action.id ? '…' : action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
