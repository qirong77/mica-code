import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconAdjustments, IconClock, IconGauge } from '@tabler/icons-react'
// 设置页的同一批控件：会话级开关与默认值表单必须是同一套 UI，不在两端各写一份
import {
  AutoCompactFields,
  CapabilityList,
  CapabilityParameters,
  ConfigSwitch as Switch,
  applyGroupEnabled,
  autoCompactDraftFromSettings,
  autoCompactNumbersFromSettings
} from '@mica-config-ui/web'
import { ModalShell } from './chat-modal'
import { LoopPanel } from './LoopPanel'

/**
 * 输入框旁的「会话设置」弹窗：会话能力 / 自动压缩 / 定时任务三块。
 *
 * 三个菜单都属于**当前会话**，不是应用级设置——同一应用里另一条会话照旧按默认值走。
 * 默认值分别在设置页的 Capabilities、Auto Compact 与 CLI `/loop` 里，只影响以后新建
 * 的会话（定时任务本身也只挂在当前会话上）。
 *
 * 数据来自常驻 chat host（`mica/capabilities/get`、`mica/autoCompact/get`）；提交走
 * 对应的 set 方法，成功后 host 发 `mica/capabilities/updated` /
 * `mica/autoCompact/overrideUpdated`，同一会话的其他窗口据此同步。
 */

const SECTIONS = [
  { id: 'capabilities', label: '会话能力', icon: IconAdjustments },
  { id: 'autoCompact', label: '自动压缩', icon: IconGauge },
  { id: 'loop', label: '定时任务', icon: IconClock }
]

// 页签定义直接交给 CapabilityList，字段名必须与它的 CapabilityGroupDef 对齐（`key`）。
const CAPABILITY_TABS = [
  { key: 'tools', label: 'Tools', disabledKey: 'disabledTools' },
  { key: 'skills', label: 'Skills', disabledKey: 'disabledSkills' },
  { key: 'mcpServers', label: 'MCP', disabledKey: 'disabledMcpServers' }
]

const EMPTY_SELECTION = {
  version: 1,
  disabledSkills: [],
  disabledTools: [],
  disabledMcpServers: []
}

/** 运行时枚举不直接上屏：`configured` / `connected` 这类值在中文界面里读起来像没做完。 */
const MCP_STATUS_LABEL = {
  connected: '已连接',
  connecting: '连接中',
  configured: '已配置',
  failed: '连接失败'
}

const TOOL_SOURCE_LABEL = {
  builtin: '内置',
  runtime: '运行期'
}

const KIND_LABEL = {
  tools: '工具',
  skills: 'Skill',
  mcpServers: 'MCP 服务'
}

export function SessionSettingsDialog({
  nodeId,
  sessionId,
  cwd,
  running,
  section: initialSection = 'capabilities',
  loopProps = null,
  onClose
}) {
  const [section, setSection] = useState(initialSection)
  const [catalog, setCatalog] = useState(null)
  const [selection, setSelection] = useState(null)
  const [compact, setCompact] = useState(null)
  const [tab, setTab] = useState('tools')
  const [error, setError] = useState('')
  // 保存中标志的同步副本：apply 里要立刻判重，不能等 setSaving 触发下一次渲染。
  const savingRef = useRef(false)
  // 点了哪一行就开哪一行的详情；null 表示没有详情弹窗。
  const [detail, setDetail] = useState(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const [capabilityResult, compactResult] = await Promise.all([
        window.mica.chat.capabilities(nodeId, { sessionId, cwd }),
        window.mica.chat.autoCompact(nodeId, { sessionId, cwd })
      ])
      if (!capabilityResult?.ok) {
        setError(capabilityResult?.error || '读取能力列表失败')
        return
      }
      setCatalog({
        skills: Array.isArray(capabilityResult.skills) ? capabilityResult.skills : [],
        tools: Array.isArray(capabilityResult.tools) ? capabilityResult.tools : [],
        mcpServers: Array.isArray(capabilityResult.mcpServers) ? capabilityResult.mcpServers : []
      })
      setSelection(capabilityResult.selection || EMPTY_SELECTION)
      if (compactResult?.ok) setCompact(normalizeCompact(compactResult))
      else if (compactResult?.error) setError(compactResult.error)
    } catch (loadError) {
      setError(formatError(loadError))
    }
  }, [nodeId, sessionId, cwd])

  useEffect(() => {
    void load()
  }, [load])

  const apply = useCallback(
    async (next) => {
      if (running) {
        setError('本轮正在运行，结束后再调整（避免工具集在一轮中途变化）')
        return
      }
      // 保存中的连点直接丢弃：上一次请求还在飞，用它的响应覆盖本地选择会让开关来回跳。
      if (savingRef.current) return
      savingRef.current = true
      const previous = selection
      setSelection(next)
      setError('')
      try {
        const result = await window.mica.chat.setCapabilities(nodeId, next, { sessionId, cwd })
        if (!result?.ok) {
          setSelection(previous)
          setError(result?.error || '保存失败')
          return
        }
        setSelection(result.selection || next)
      } catch (saveError) {
        setSelection(previous)
        setError(formatError(saveError))
      } finally {
        savingRef.current = false
      }
    },
    [nodeId, sessionId, cwd, running, selection]
  )

  // 压缩设置在请求间隙生效，运行中改也不会让本轮换阈值，所以不受 running 限制。
  const applyCompact = useCallback(
    async (override) => {
      const previous = compact
      setCompact((current) => current && { ...current, override })
      setError('')
      try {
        const result = await window.mica.chat.setAutoCompact(nodeId, override, { sessionId, cwd })
        if (!result?.ok) {
          setCompact(previous)
          setError(result?.error || '保存失败')
          return
        }
        setCompact((current) => normalizeCompact({ ...current, ...result }))
      } catch (saveError) {
        setCompact(previous)
        setError(formatError(saveError))
      }
    },
    [nodeId, sessionId, cwd, compact]
  )

  const activeTab = CAPABILITY_TABS.find((entry) => entry.key === tab) || CAPABILITY_TABS[0]
  const items = listItems(catalog, tab)
  const disabled = selection?.[activeTab.disabledKey] || []

  function toggle(name, enabled) {
    if (!selection) return
    toggleWith(activeTab.disabledKey, name, enabled)
  }

  function toggleWith(disabledKey, name, enabled) {
    if (!selection) return
    const current = new Set(selection[disabledKey])
    if (enabled) current.delete(name)
    else current.add(name)
    void apply({ ...selection, [disabledKey]: [...current] })
  }

  // 整组开关：一次改写组内全部成员，仍然是同一个禁用名单（能力校验按工具名逐条判定）。
  function toggleGroup(disabledKey, names, enabled) {
    if (!selection) return
    void apply({
      ...selection,
      [disabledKey]: applyGroupEnabled(selection[disabledKey], names, enabled)
    })
  }

  // 生效值 → 编辑器草稿（分钟、字符串），默认值 → 「默认 x」提示用的数字表。
  // 两者都来自 mica-common 的合并规则，这里只做搬运。
  const compactDraft = useMemo(
    () => (compact ? autoCompactDraftFromSettings(compact.effective) : null),
    [compact]
  )
  const compactDefaults = useMemo(
    () => autoCompactNumbersFromSettings(compact?.defaults),
    [compact]
  )

  // 编辑器按分钟编辑，存储用毫秒：换算只在这一处。
  function patchCompact(key, raw) {
    if (!compact) return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    const storeKey = key === 'minIntervalMinutes' ? 'minIntervalMs' : key
    const storeValue = key === 'minIntervalMinutes' ? value * 60_000 : value
    void applyCompact({ ...compact.override, [storeKey]: storeValue })
  }

  function resetCompactKey(key) {
    if (!compact) return
    const next = { ...compact.override }
    delete next[key === 'minIntervalMinutes' ? 'minIntervalMs' : key]
    void applyCompact(next)
  }

  const totalCount = countAll(catalog)
  const disabledCount = disabledTotal(selection)

  return (
    <ModalShell
      title="会话设置"
      icon={<IconAdjustments size={14} />}
      subtitle="只影响当前会话"
      // 详情开着时 Esc 先关详情：两个弹窗都在 window 上听 Esc，这里不拦会把整层一起关掉。
      onClose={() => (detail ? setDetail(null) : onClose())}
      className="session-settings-modal"
    >
      <nav className="session-settings-nav" aria-label="会话设置分类">
        {SECTIONS.map((entry) => {
          const Icon = entry.icon
          return (
            <button
              key={entry.id}
              type="button"
              className={`session-settings-nav-item${section === entry.id ? ' is-active' : ''}`}
              aria-current={section === entry.id ? 'true' : undefined}
              onClick={() => {
                setSection(entry.id)
                setDetail(null)
              }}
            >
              <Icon size={14} aria-hidden="true" />
              <span className="session-settings-nav-label">{entry.label}</span>
              <span className="session-settings-nav-meta">
                {sectionMeta(entry.id, {
                  catalog,
                  compact,
                  loopProps,
                  totalCount,
                  disabledCount
                })}
              </span>
            </button>
          )
        })}
      </nav>

      <div className="session-settings-panel">
        {/* 能力列表与自动压缩编辑器都来自设置页同一份组件（见 packages/mica-config-ui），
            这里只负责数据与落点。外壳加 `mica-config-ui is-embed` 拿到同一套配色与控件。 */}
        <div className="mica-config-ui is-embed">
          {section === 'capabilities' ? (
            catalog ? (
              <CapabilityList
                groups={CAPABILITY_TABS}
                group={tab}
                onGroupChange={(kind) => {
                  setTab(kind)
                  setDetail(null)
                }}
                counts={Object.fromEntries(
                  CAPABILITY_TABS.map((entry) => [entry.key, tabCount(catalog, selection, entry)])
                )}
                items={items.map((item) => ({
                  name: item.name,
                  description: item.description || '',
                  group: item.group,
                  source: item.source,
                  readOnly: item.readOnly,
                  parameters: item.parameters
                }))}
                countLabel={`${items.filter((item) => !disabled.includes(item.name)).length}/${items.length} 启用`}
                disabled={running}
                isEnabled={(name) => !disabled.includes(name)}
                onToggle={(name, checked) => toggle(name, checked)}
                onToggleGroup={
                  tab === 'tools'
                    ? (names, enabled) => toggleGroup(activeTab.disabledKey, names, enabled)
                    : null
                }
                onOpenDetail={(item) => setDetail({ kind: tab, name: item.name })}
              />
            ) : (
              <p className="capability-note">正在加载…</p>
            )
          ) : null}

          {section === 'autoCompact' ? (
            compact ? (
              <>
                <AutoCompactFields
                  draft={compactDraft}
                  defaults={compactDefaults}
                  onChange={patchCompact}
                  onToggle={(enabled) => applyCompact({ ...compact.override, enabled })}
                  onResetKey={resetCompactKey}
                />
                <p className="capability-note">
                  新会话的默认压缩设置在设置页 Auto Compact 里配置。
                </p>
              </>
            ) : (
              <p className="capability-note">正在加载…</p>
            )
          ) : null}
        </div>

        {section === 'loop' ? <LoopPanel {...loopProps} /> : null}

        {error ? <p className="session-settings-error">{error}</p> : null}
      </div>

      {detail ? (
        <CapabilityDetail
          detail={detail}
          item={items.find((entry) => entry.name === detail.name)}
          enabled={!disabled.includes(detail.name)}
          running={running}
          onToggle={(checked) => toggleWith(activeTab.disabledKey, detail.name, checked)}
          onClose={() => setDetail(null)}
        />
      ) : null}
    </ModalShell>
  )
}

/**
 * 单条能力的详情。列表只放一行摘要（名字 + 截断的描述），完整描述和来源放这里，
 * 免得长描述把列表撑成两行、挤掉同一列的对齐。
 *
 * 开关仍然只在滑块上：详情里给的是同一份状态，点击正文不会改任何东西。
 */
function CapabilityDetail({ detail, item, enabled, running, onToggle, onClose }) {
  if (!item) return null
  const rows = [
    ['类型', KIND_LABEL[detail.kind] || detail.kind],
    detail.kind === 'tools'
      ? ['来源', TOOL_SOURCE_LABEL[item.source] || item.source || '未知']
      : null,
    detail.kind === 'tools' && item.group ? ['分组', item.group.label] : null,
    detail.kind === 'tools' && typeof item.readOnly === 'boolean'
      ? ['读写', item.readOnly ? '只读' : '可写']
      : null,
    detail.kind === 'mcpServers'
      ? ['状态', MCP_STATUS_LABEL[item.status] || item.status || '未知']
      : null
  ].filter(Boolean)

  return (
    <ModalShell
      title={item.name}
      subtitle={KIND_LABEL[detail.kind] || detail.kind}
      onClose={onClose}
      nested
    >
      <dl className="session-cap-detail-meta">
        {rows.map(([label, value]) => (
          <div key={label} className="session-cap-detail-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div className="session-cap-detail-row">
          <dt>启用</dt>
          <dd>
            <span
              className={`session-cap-detail-switch mica-config-ui is-embed${running ? ' is-disabled' : ''}`}
              onClick={(event) => event.stopPropagation()}
            >
              <Switch
                id={`capability-detail-${detail.kind}-${item.name}`}
                checked={enabled}
                disabled={running}
                label={item.name}
                onChange={onToggle}
              />
            </span>
          </dd>
        </div>
      </dl>
      <p className="session-cap-detail-desc">{item.description || '暂无描述'}</p>
      {/* 入参列表与设置页共用同一份组件与样式，外层补上配置页作用域 */}
      {item.parameters?.length ? (
        <div className="mica-config-ui is-embed session-cap-detail-params">
          <CapabilityParameters parameters={item.parameters} />
        </div>
      ) : null}
    </ModalShell>
  )
}

function sectionMeta(id, { catalog, compact, loopProps, totalCount, disabledCount }) {
  if (id === 'capabilities') return catalog ? `${totalCount - disabledCount}/${totalCount}` : ''
  if (id === 'autoCompact') {
    if (!compact) return ''
    const count = Object.keys(compact.override || {}).length
    return count === 0 ? '默认' : `${count} 项已改`
  }
  const loop = loopProps?.loop
  if (!loop) return '未设置'
  return loop.status === 'active' ? '运行中' : '已暂停'
}

function normalizeCompact(result) {
  return {
    defaults: result.defaults && typeof result.defaults === 'object' ? result.defaults : {},
    override: result.override && typeof result.override === 'object' ? result.override : {},
    effective: result.effective && typeof result.effective === 'object' ? result.effective : {}
  }
}

function listItems(catalog, kind) {
  if (!catalog) return []
  if (kind === 'skills') return catalog.skills
  if (kind === 'tools') return catalog.tools
  return catalog.mcpServers.map((server) => ({
    name: server.name,
    description: `${server.toolCount ?? 0} tools`,
    status: server.status
  }))
}

function countAll(catalog) {
  if (!catalog) return 0
  return catalog.skills.length + catalog.tools.length + catalog.mcpServers.length
}

function disabledTotal(selection) {
  if (!selection) return 0
  return (
    selection.disabledSkills.length +
    selection.disabledTools.length +
    selection.disabledMcpServers.length
  )
}

function tabCount(catalog, selection, entry) {
  const items = listItems(catalog, entry.key)
  const disabled = selection?.[entry.disabledKey] || []
  return `${items.filter((item) => !disabled.includes(item.name)).length}/${items.length}`
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}
