import { useMemo, useState } from 'react'
import {
  CONTEXT_KIND_META,
  OVERHEAD_META,
  bodyOverInputNote,
  contextBarSegments,
  contextItemSubtitle,
  contextItemTitle,
  contextTotalTokens,
  filterContextItems,
  formatTokens,
  formatShare,
  indexContextItems,
  kindMeta,
  overheadNote,
  staleReferenceNote,
  sortContextItems
} from './context-usage'

const RENDER_STEP = 50

function StackBar({ context }) {
  const segments = contextBarSegments(context)
  const total = contextTotalTokens(context)
  if (segments.length === 0 || total <= 0) return null
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-[3px] border border-line bg-canvas">
      {segments.map((segment) => {
        const share = formatShare(segment.tokens, total)
        return (
          <div
            key={segment.key}
            className={segment.bar}
            style={{ flexGrow: Math.max(segment.tokens, 1), flexBasis: 0 }}
            title={`${segment.label} · ~${formatTokens(segment.tokens)} tokens · ${share}`}
          />
        )
      })}
    </div>
  )
}

function Legend({ context }) {
  const segments = contextBarSegments(context)
  const total = contextTotalTokens(context)
  if (segments.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-fg-muted">
      {segments.map((segment) => (
        <span key={segment.key} className="flex items-center gap-1.5">
          <span className={`size-2 shrink-0 rounded-[2px] ${segment.bar}`} />
          <span className="text-fg-soft">{segment.label}</span>
          <span className="font-mono tabular-nums text-fg-dim">{formatTokens(segment.tokens)}</span>
          <span className="font-mono tabular-nums text-fg-ghost">
            {formatShare(segment.tokens, total)}
          </span>
        </span>
      ))}
    </div>
  )
}

/**
 * 上下文占用：堆叠条 + 类别表。回答「谁占了 context」。
 * 占比的分母优先用最近一次真实请求的 input（与状态栏 ctx 同源），
 * 没有真实请求时才退回消息体估算。
 */
export function ContextUsageSection({ context, messages, contextWindowSize }) {
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('size')

  const total = contextTotalTokens(context)
  const categories = Array.isArray(context?.categories) ? context.categories : []
  const items = useMemo(() => indexContextItems(messages || []), [messages])

  if (!context || (categories.length === 0 && !context.overheadTokens)) return null

  const staleNote = staleReferenceNote(context)
  const bodyNote = bodyOverInputNote(context)
  const overheadHint = overheadNote(context)
  const maxTokens = Math.max(1, ...categories.map((row) => row.tokens), context.overheadTokens || 0)

  return (
    <div className="flex flex-col gap-2">
      <StackBar context={context} />
      <Legend context={context} />

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[10px] text-fg-faint">
        <span className="text-fg-soft">
          持久化消息体 ~{formatTokens(context.messageTokens)} tokens（{context.items} 条）
        </span>
        {context.lastInputTokens > 0 && (
          <span>最近一次请求 input {context.lastInputTokens.toLocaleString()}</span>
        )}
        {context.staleInput?.compactedTokens > 0 && (
          <span>压缩后估算 ~{formatTokens(context.staleInput.compactedTokens)}</span>
        )}
        {contextWindowSize > 0 && <span>窗口 {formatTokens(contextWindowSize)}</span>}
      </div>

      {staleNote && <p className="text-[10px] leading-relaxed text-warn">{staleNote}</p>}
      {bodyNote && <p className="text-[10px] leading-relaxed text-fg-faint">{bodyNote}</p>}
      {overheadHint && <p className="text-[10px] leading-relaxed text-fg-faint">{overheadHint}</p>}

      <table className="mt-1 w-full table-fixed text-[11px]">
        <colgroup>
          <col className="w-[34%]" />
          <col className="w-[12%]" />
          <col className="w-[16%]" />
          <col className="w-[38%]" />
        </colgroup>
        <thead>
          <tr className="text-[10px] text-fg-faint">
            <th scope="col" className="pb-1 text-left font-normal">
              占用来源
            </th>
            <th scope="col" className="pb-1 text-right font-normal">
              条数
            </th>
            <th scope="col" className="pb-1 text-right font-normal">
              估算 tokens
            </th>
            <th scope="col" className="pb-1 pl-2 text-left font-normal">
              占比
            </th>
          </tr>
        </thead>
        <tbody>
          {categories.map((row) => {
            const meta = kindMeta(row.kind)
            return (
              <tr key={row.kind} className="border-t border-line">
                <td className="py-1 pr-2">
                  <span className={`rounded-[3px] px-1.5 py-0.5 text-[10px] ${meta.badge}`}>
                    {meta.label}
                  </span>
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-dim tabular-nums">
                  {row.count}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-muted tabular-nums">
                  {row.tokens.toLocaleString()}
                </td>
                <td className="py-1 pl-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-[2px] bg-canvas">
                      <div
                        className={`h-full ${kindMeta(row.kind).bar}`}
                        style={{ width: `${(row.tokens / maxTokens) * 100}%` }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right font-mono text-[10px] text-fg-dim tabular-nums">
                      {formatShare(row.tokens, total)}
                    </span>
                  </div>
                </td>
              </tr>
            )
          })}
          {context.overheadTokens > 0 && (
            <tr className="border-t border-line">
              <td className="py-1 pr-2">
                <span className={`rounded-[3px] px-1.5 py-0.5 text-[10px] ${OVERHEAD_META.badge}`}>
                  {OVERHEAD_META.label}
                </span>
              </td>
              <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-ghost">—</td>
              <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-muted tabular-nums">
                {context.overheadTokens.toLocaleString()}
              </td>
              <td className="py-1 pl-2">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-[2px] bg-canvas">
                    <div
                      className="h-full bg-fg-ghost"
                      style={{
                        width: `${(context.overheadTokens / Math.max(maxTokens, context.overheadTokens)) * 100}%`
                      }}
                    />
                  </div>
                  <span className="w-10 shrink-0 text-right font-mono text-[10px] text-fg-dim tabular-nums">
                    {formatShare(context.overheadTokens, total)}
                  </span>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <p className="text-[10px] leading-relaxed text-fg-ghost">
        「{OVERHEAD_META.label}」= 最近一次请求的 input 减去持久化消息体估算，包含 system
        prompt、AGENT.md、skills 索引、全部工具 schema、不落盘的思考内容（Responses
        的加密推理链），以及 chars/4 与真实 tokenize 的差（JSON 结构、id、中文都会让实际
        更贵）。「消息结构（信封）」是每条消息的 role/type/call_id/name
        等结构字段，线上请求同样会带上（压缩与状态栏的估算按带缩进的整份历史 JSON
        口径，与这里的逐条口径会差一成左右）。媒体块（图片 / 文档）只记张数、不计字符 （base64
        长度与 vision token 无关）。
      </p>

      <ContextItemList
        items={items}
        total={total}
        filter={filter}
        onFilter={setFilter}
        sort={sort}
        onSort={setSort}
      />
    </div>
  )
}

function ContextItemList({ items, total, filter, onFilter, sort, onSort }) {
  const [visible, setVisible] = useState(RENDER_STEP)
  const [expandedKey, setExpandedKey] = useState(null)

  const counts = useMemo(() => {
    const map = new Map()
    for (const item of items) map.set(item.kind, (map.get(item.kind) || 0) + 1)
    return map
  }, [items])

  const rows = useMemo(
    () => sortContextItems(filterContextItems(items, filter), sort),
    [items, filter, sort]
  )

  if (items.length === 0) return null

  const filterOptions = [
    { key: 'all', label: '全部', count: items.length },
    ...Object.keys(CONTEXT_KIND_META)
      .filter((kind) => counts.has(kind))
      .map((kind) => ({ key: kind, label: CONTEXT_KIND_META[kind].label, count: counts.get(kind) }))
  ]

  return (
    <div className="mt-1 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {filterOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => {
              onFilter(option.key)
              setVisible(RENDER_STEP)
              setExpandedKey(null)
            }}
            className={`rounded-[3px] border px-1.5 py-0.5 text-[10px] transition-colors ${
              filter === option.key
                ? 'border-line-strong bg-active text-fg-strong'
                : 'border-line bg-panel-hi text-fg-muted hover:text-fg-strong'
            }`}
          >
            {option.label}
            <span className="ml-1 font-mono tabular-nums text-fg-ghost">{option.count}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            onSort(sort === 'size' ? 'order' : 'size')
            setExpandedKey(null)
          }}
          className="ml-auto rounded-[3px] border border-line bg-panel-hi px-1.5 py-0.5 text-[10px] text-fg-muted transition-colors hover:text-fg-strong"
        >
          排序：{sort === 'size' ? '体积 ↓' : '对话顺序'}
        </button>
      </div>

      <div className="rounded-[4px] border border-line">
        {rows.slice(0, visible).map((item) => {
          const key = `${item.index}`
          const expanded = expandedKey === key
          const meta = kindMeta(item.kind)
          const subtitle = contextItemSubtitle(item)
          return (
            <div key={key} className="border-b border-line last:border-b-0">
              <button
                type="button"
                onClick={() => setExpandedKey(expanded ? null : key)}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-panel-hi"
              >
                <span className="w-10 shrink-0 text-right font-mono text-[10px] text-fg-ghost tabular-nums">
                  #{item.index + 1}
                </span>
                <span
                  className={`shrink-0 rounded-[3px] px-1.5 py-0.5 text-[10px] ${meta.badge}`}
                  title={meta.label}
                >
                  {meta.label}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg">
                  {contextItemTitle(item)}
                </span>
                {subtitle && (
                  <span
                    className="hidden max-w-[40%] shrink-0 truncate font-mono text-[10px] text-fg-faint md:inline"
                    title={subtitle}
                  >
                    {subtitle}
                  </span>
                )}
                <span className="shrink-0 font-mono text-[10px] text-fg-muted tabular-nums">
                  ~{formatTokens(item.tokens)}
                </span>
                <span className="w-10 shrink-0 text-right font-mono text-[10px] text-fg-dim tabular-nums">
                  {formatShare(item.tokens, total)}
                </span>
                <span className="shrink-0 text-[10px] text-fg-ghost">{expanded ? '▾' : '▸'}</span>
              </button>
              {expanded && (
                <div className="border-t border-line bg-canvas px-2 py-1.5">
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-fg-faint">
                    <span>估算 ~{item.tokens.toLocaleString()} tokens</span>
                    <span>{item.chars.toLocaleString()} chars</span>
                    {item.name && <span>{item.name}</span>}
                    {item.toolCallId && <span title={item.toolCallId}>{item.toolCallId}</span>}
                    {item.encryptedChars > 0 && (
                      <span>加密推理链 {formatTokens(item.encryptedChars)} chars</span>
                    )}
                  </div>
                  {item.content ? (
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-fg">
                      {item.content}
                    </pre>
                  ) : (
                    <div className="mt-1 text-[10px] text-fg-ghost">
                      {item.cleared ? '内容已在 compact 时清理为占位符' : '无正文（仅结构）'}
                    </div>
                  )}
                  {Array.isArray(item.toolCalls) && item.toolCalls.length > 0 && (
                    <div className="mt-1 flex flex-col gap-1">
                      {item.toolCalls.map((call, index) => (
                        <div
                          key={call.id || index}
                          className="rounded-[4px] border border-line bg-panel-hi px-2 py-1"
                        >
                          <div className="font-mono text-[10px] text-warn">
                            {call.name || 'tool_call'}
                          </div>
                          {call.arguments && (
                            <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-fg-muted">
                              {call.arguments}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {rows.length > visible && (
        <button
          type="button"
          onClick={() => setVisible((value) => value + RENDER_STEP)}
          className="w-full rounded-[4px] border border-line bg-panel-hi py-1.5 text-[11px] text-fg-muted transition-colors hover:text-fg-strong"
        >
          显示更多（{rows.length - visible} 条）
        </button>
      )}
    </div>
  )
}
