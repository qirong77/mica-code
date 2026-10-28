import { useCallback, useEffect, useRef, useState } from 'react'
import { IconAdjustments, IconClock, IconPuzzle } from '@tabler/icons-react'
// 设置页的同一批控件：会话级开关与默认值表单必须是同一套 UI，不在两端各写一份
import {
  CapabilityList,
  CapabilityParameters,
  ConfigSwitch as Switch,
  applyGroupEnabled
} from '@mica-config-ui/web'
import { ModalShell } from './chat-modal'
import { LoopPanel } from './LoopPanel'
import { PluginSettingsPanel } from './SessionPluginSettings'

/**
 * 输入框旁的「会话设置」弹窗：会话能力 / 定时任务 / 插件三块。
 *
 * 三块都属于**当前会话**，不是应用级设置——同一应用里另一条会话照旧按默认值走。
 * 能力默认值在设置页的 Capabilities、定时任务在 CLI `/loop` 里（定时任务本身也只挂在
 * 当前会话上）。插件一节按清单渲染：只有插件把设置项标成 `perSession`，它才会出现，
 * 因此自动压缩的阈值这类「每条会话可以不一样」的配置由插件自己声明，内核不认识它。
 *
 * 数据来自常驻 chat host 的 `mica/capabilities/get`；提交走对应的 set 方法，成功后
 * host 发 `mica/capabilities/updated`，同一会话的其他窗口据此同步。
 */

const SECTIONS = [
  { id: 'capabilities', label: '会话能力', icon: IconAdjustments },
  { id: 'loop', label: '定时任务', icon: IconClock },
  { id: 'plugins', label: '插件', icon: IconPuzzle }
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
  const [tab, setTab] = useState('tools')
  const [error, setError] = useState('')
  // 保存中标志的同步副本：apply 里要立刻判重，不能等 setSaving 触发下一次渲染。
  const savingRef = useRef(false)
  // 最近一次本地选择（连点时不依赖尚未重渲染的 state）与 host 已确认的选择
  const selectionRef = useRef(null)
  const confirmedRef = useRef(EMPTY_SELECTION)
  const pendingSaveRef = useRef(null)
  // 点了哪一行就开哪一行的详情；null 表示没有详情弹窗。
  const [detail, setDetail] = useState(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const capabilityResult = await window.mica.chat.capabilities(nodeId, { sessionId, cwd })
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
      selectionRef.current = capabilityResult.selection || EMPTY_SELECTION
      confirmedRef.current = selectionRef.current
    } catch (loadError) {
      setError(formatError(loadError))
    }
  }, [nodeId, sessionId, cwd])

  useEffect(() => {
    void load()
  }, [load])

  // 保存串行化：连点不丢弃，攒成「最后一次选择」再发一轮请求。丢弃会让开关停在
  // DOM 已翻转、状态没变的中间态，用户必须再点一次才生效。
  const flushSave = useCallback(async () => {
    if (savingRef.current) return
    const next = pendingSaveRef.current
    if (!next) return
    pendingSaveRef.current = null
    savingRef.current = true
    setError('')
    try {
      const result = await window.mica.chat.setCapabilities(nodeId, next, { sessionId, cwd })
      if (!result?.ok) {
        pendingSaveRef.current = null
        setSelection(confirmedRef.current)
        selectionRef.current = confirmedRef.current
        setError(result?.error || '保存失败')
        return
      }
      const applied = result.selection || next
      confirmedRef.current = applied
      // 请求期间又点了几下时本地已有更新的选择，不用这次的响应盖回去
      if (!pendingSaveRef.current) {
        selectionRef.current = applied
        setSelection(applied)
      }
    } catch (saveError) {
      pendingSaveRef.current = null
      setSelection(confirmedRef.current)
      selectionRef.current = confirmedRef.current
      setError(formatError(saveError))
    } finally {
      savingRef.current = false
      if (pendingSaveRef.current) void flushSave()
    }
  }, [nodeId, sessionId, cwd])

  const apply = useCallback(
    (next) => {
      if (running) {
        setError('本轮正在运行，结束后再调整（避免工具集在一轮中途变化）')
        return
      }
      selectionRef.current = next
      setSelection(next)
      pendingSaveRef.current = next
      void flushSave()
    },
    [running, flushSave]
  )

  const activeTab = CAPABILITY_TABS.find((entry) => entry.key === tab) || CAPABILITY_TABS[0]
  const items = listItems(catalog, tab)
  const disabled = selection?.[activeTab.disabledKey] || []

  function toggle(name, enabled) {
    if (!selection) return
    toggleWith(activeTab.disabledKey, name, enabled)
  }

  function toggleWith(disabledKey, name, enabled) {
    const base = selectionRef.current
    if (!base) return
    const current = new Set(base[disabledKey])
    if (enabled) current.delete(name)
    else current.add(name)
    void apply({ ...base, [disabledKey]: [...current] })
  }

  // 整组开关：一次改写组内全部成员，仍然是同一个禁用名单（能力校验按工具名逐条判定）。
  function toggleGroup(disabledKey, names, enabled) {
    const base = selectionRef.current
    if (!base) return
    void apply({
      ...base,
      [disabledKey]: applyGroupEnabled(base[disabledKey], names, enabled)
    })
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
                {sectionMeta(entry.id, { catalog, loopProps, totalCount, disabledCount })}
              </span>
            </button>
          )
        })}
      </nav>

      <div className="session-settings-panel">
        {/* 能力列表来自设置页同一份组件（见 packages/mica-config-ui），这里只负责数据与
            落点。外壳加 `mica-config-ui is-embed` 拿到同一套配色与控件。 */}
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

          {section === 'loop' ? <LoopPanel {...loopProps} /> : null}

          {section === 'plugins' ? (
            <PluginSettingsPanel nodeId={nodeId} sessionId={sessionId} cwd={cwd} running={running} />
          ) : null}

          {error ? <p className="session-settings-error">{error}</p> : null}
        </div>
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

function sectionMeta(id, { catalog, loopProps, totalCount, disabledCount }) {
  if (id === 'capabilities') return catalog ? `${totalCount - disabledCount}/${totalCount}` : ''
  // 插件一节按需加载，导航项先不显示计数（显示 0 会让人以为没有可配置的插件）。
  if (id === 'plugins') return ''
  const loop = loopProps?.loop
  if (!loop) return '未设置'
  return loop.status === 'active' ? '运行中' : '已暂停'
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
