import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
// 控件全部来自设置页那同一套（见 packages/mica-config-ui）：插件面板里不另写按钮、
// 输入框、标签，否则同一个应用里会出现三种按钮高度和两套状态色。
import { Alert, Button, CollapsiblePanel, Empty, SettingRow, Tag } from '@mica-config-ui/web'
import { ModalShell } from './chat-modal'
import { applyPanelResult, pluginPanelTabs, usePluginPanels } from './plugin-panels'

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
 * 插件声明的状态色调 → 共享 `Tag` 的色板。
 *
 * 插件说 `warn` 是「需要注意但没坏」，与 `error` 的「出错了」必须能分开看，所以
 * warn 落到 amber 而不是和默认灰混在一起。
 */
const TAG_TONES = {
  ok: 'green',
  error: 'red',
  warn: 'amber',
  accent: 'blue',
  muted: 'default'
}

/** 动作的 `tone` → 共享 `Button` 的变体；没声明的一律是行内次要动作。 */
const BUTTON_VARIANTS = { primary: 'primary', danger: 'danger' }

const tagTone = (tone) => TAG_TONES[tone] || 'default'
const buttonVariant = (tone) => BUTTON_VARIANTS[tone] || 'ghost'

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
  onTogglePanel,
  onCompose,
  onLaunchSession,
  onDialog,
  onOpenPath
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
      applyPanelResult(result, { onCompose, onLaunchSession, onDialog, onOpenPath })
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
export function PluginPanels({
  nodeId,
  sessionId,
  cwd,
  role,
  openPlugin,
  focusSection,
  onClose,
  onCompose,
  onLaunchSession,
  onDialog,
  onOpenPath
}) {
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
      display={open.display}
      nodeId={nodeId}
      sessionId={sessionId}
      cwd={cwd}
      focusSection={focusSection}
      onClose={onClose}
      onCompose={onCompose}
      onLaunchSession={onLaunchSession}
      onDialog={onDialog}
      onOpenPath={onOpenPath}
    />
  )
}

function PluginPanelDock({
  pluginId,
  label,
  display,
  nodeId,
  sessionId,
  cwd,
  focusSection,
  onClose,
  onCompose,
  onLaunchSession,
  onDialog,
  onOpenPath
}) {
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [drafts, setDrafts] = useState({})
  // 弹窗形态下的当前页签（存 section 标题）。抽屉形态不用它。
  const [activeTab, setActiveTab] = useState('')
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
      applyPanelResult(result, { onCompose, onLaunchSession, onDialog, onOpenPath })
      setFeedback(result?.ok === false ? result.error || '动作失败' : result?.message || '')
    },
    [
      applyView,
      cwd,
      drafts,
      nodeId,
      onCompose,
      onDialog,
      onLaunchSession,
      onOpenPath,
      pluginId,
      sessionId
    ]
  )

  const sections = useMemo(() => view?.sections || [], [view])
  const statusTone = view?.status?.tone || 'muted'

  const { tabs, activeIndex: initialTabIndex } = useMemo(
    () => pluginPanelTabs(sections, focusSection),
    [sections, focusSection]
  )
  const sectionKeys = useMemo(() => tabs.map((tab) => tab.key), [tabs])

  // `focusSection` 只在它变化时生效一次：否则每 4 秒刷新都会把用户刚点开的其它块重新收起。
  const appliedFocusRef = useRef(null)

  useEffect(() => {
    if (sections.length === 0) return
    const focusKey = focusSection ? `${pluginId}:${focusSection}` : ''
    if (appliedFocusRef.current === focusKey) return
    appliedFocusRef.current = focusKey
    // 弹窗形态：快捷按钮点名的那一块直接切到它；没点名就停在当前页签，
    // 页签被删掉（插件改了分区）才回落到第一块。
    if (focusSection && sectionKeys.includes(focusSection)) setActiveTab(focusSection)
    else setActiveTab((previous) => (sectionKeys.includes(previous) ? previous : sectionKeys[0]))
  }, [focusSection, pluginId, sectionKeys, sections])

  const renderSection = (section, key, { tabbed = false } = {}) => (
    <PluginPanelSection
      key={key}
      section={section}
      tabbed={tabbed}
      // 抽屉里的折叠由 <details> 自己管（用户点开就是点开，4 秒刷新不会把它翻回去）；
      // 快捷按钮点名的那一块靠 key 变化重挂载来强制展开。
      focused={Boolean(focusSection) && key === focusSection}
      drafts={drafts}
      setDrafts={setDrafts}
      commit={section.commit ? () => runAction(section.commit) : null}
      busy={busy}
      runAction={runAction}
    />
  )

  const placeholder = (
    <>
      {error && <Alert message={error} />}
      {!view && !error && (
        <p className="chat-plugin-loading">
          <Loader2 size={13} className="chat-plugin-spin" /> 正在读取…
        </p>
      )}
    </>
  )

  // 呈现形态由清单决定（`desktop.panel.display`）：同一份视图数据，只换外壳。
  // 弹窗走共用 ModalShell，Esc / 点遮罩 / 关闭按钮的行为与其它弹窗一致；里面是
  // **页签**而不是一列折叠卡片——内容一多，折叠列表要滚很久才能找到那一块。
  if (display === 'modal') {
    const focused = tabs.findIndex((tab) => tab.key === activeTab)
    const tabIndex = focused >= 0 ? focused : initialTabIndex
    const activeSection = sections[tabIndex]
    return (
      <ModalShell
        title={view?.title || label}
        subtitle={view?.subtitle || null}
        className="chat-plugin-modal"
        actions={
          <>
            {view?.status && <Tag tone={tagTone(statusTone)}>{view.status.label}</Tag>}
            {feedback && (
              <span className="chat-plugin-feedback" role="status">
                {feedback}
              </span>
            )}
          </>
        }
        onClose={onClose}
      >
        {/* 设置页那套控件与配色：页签是 .session-tab（全应用只有这一种页签形态），
            行是 SettingRow，按钮 / 标签 / 空态 / 错误条都来自 @mica-config-ui/web。
            高度由 .chat-plugin-modal 定死，切页签时弹窗不再一伸一缩。 */}
        <div className="mica-config-ui is-embed chat-plugin-panel">
          {sections.length > 0 && (
            <div className="session-tabs" role="tablist" aria-label="面板分区">
              {tabs.map((tab, index) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={index === tabIndex}
                  className={`session-tab${index === tabIndex ? ' session-tab-active' : ''}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
          <div className="chat-plugin-panel-body">
            {placeholder}
            {activeSection && renderSection(activeSection, sectionKeys[tabIndex], { tabbed: true })}
          </div>
        </div>
      </ModalShell>
    )
  }

  const body = (
    <>
      {placeholder}
      {sections.map((section, index) => renderSection(section, sectionKeys[index]))}
    </>
  )

  return (
    <aside className="chat-plugin-dock" aria-label={`${view?.title || label} 插件面板`}>
      <header className="chat-plugin-dock-head">
        <div className="chat-plugin-dock-title">
          <span>{view?.title || label}</span>
          {view?.status && <Tag tone={tagTone(statusTone)}>{view.status.label}</Tag>}
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
      <div className="mica-config-ui is-embed chat-plugin-dock-body">{body}</div>
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
  tabbed = false,
  focused,
  drafts,
  setDrafts,
  commit,
  busy,
  runAction
}) {
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

  const body = (
    <PluginPanelRows
      section={section}
      drafts={drafts}
      changeDraft={changeDraft}
      busy={busy}
      runAction={runAction}
    />
  )

  // 弹窗形态：标题已经是页签本身，再套一层折叠卡片就是两遍同名标题。
  if (tabbed) return <div className="chat-plugin-tab-pane">{body}</div>

  // 抽屉形态沿用设置页的折叠卡片（details），折叠状态归它自己管。
  return (
    <CollapsiblePanel
      // key 带上分区标题：插件改了分区顺序也不会把折叠状态串到另一块上。
      // 被快捷按钮点名时换成 'focus'，重挂载一次以强制展开。
      key={`${section.title || ''}:${focused ? 'focus' : section.collapsed ? 'closed' : 'open'}`}
      title={section.title || '未命名'}
      meta={section.subtitle || null}
      defaultOpen={focused || !section.collapsed}
    >
      {body}
    </CollapsiblePanel>
  )
}

/** 一块分区的内容：只读行、条目、输入框、动作，全部落在共享 `SettingRow` 上。 */
function PluginPanelRows({ section, drafts, changeDraft, busy, runAction }) {
  const hasRows = (section.rows?.length || 0) + (section.items?.length || 0) > 0
  const hasFields = (section.fields?.length || 0) > 0
  return (
    <div className="chat-plugin-rows">
      {section.rows?.map((row) => (
        <SettingRow key={row.label} label={row.label}>
          <span
            className={`chat-plugin-value${row.tone ? ` tone-${row.tone}` : ''}`}
            title={row.value || undefined}
          >
            {row.value ?? '—'}
          </span>
        </SettingRow>
      ))}
      {section.items?.map((item) => (
        <SettingRow key={item.key} label={item.label}>
          <span className="chat-plugin-item">
            <span
              className={`chat-plugin-value tone-${item.tone || 'muted'}`}
              title={item.value || undefined}
            >
              {item.value || ''}
            </span>
            {item.actions?.length > 0 && (
              <span className="chat-plugin-item-actions">
                {item.actions.map((action) => (
                  <Button
                    key={action.id}
                    variant={buttonVariant(action.tone)}
                    disabled={action.disabled || Boolean(busy)}
                    loading={busy === `${action.id}:${item.key}`}
                    onClick={() => void runAction(action.id, item.key)}
                  >
                    {action.label}
                  </Button>
                ))}
              </span>
            )}
          </span>
        </SettingRow>
      ))}
      {/* 整块都没内容时才画空态：只读行为空不代表没东西（可能还有输入框或动作）。 */}
      {!hasRows && !hasFields && section.empty ? <Empty description={section.empty} /> : null}
      {section.fields?.map((field) => (
        <SettingRow
          key={field.key}
          label={field.label}
          hint={field.hint}
          htmlFor={`chat-plugin-field-${field.key}`}
        >
          <input
            id={`chat-plugin-field-${field.key}`}
            className="text-input"
            type="text"
            inputMode={field.type === 'number' ? 'numeric' : undefined}
            value={drafts[field.key] ?? ''}
            placeholder={field.placeholder || ''}
            onChange={(event) => changeDraft(field.key, event.target.value)}
          />
        </SettingRow>
      ))}
      {section.actions?.length > 0 && (
        <div className="chat-plugin-section-actions">
          {section.actions.map((action) => (
            <Button
              key={action.id}
              variant={buttonVariant(action.tone)}
              title={action.hint || action.label}
              disabled={action.disabled || Boolean(busy)}
              loading={busy === action.id}
              onClick={() => void runAction(action.id)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
