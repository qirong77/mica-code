import { useEffect, useMemo, useState } from 'react'

const BATCH = 50
const OVERLINE_CLASS = 'text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a8a8a]'

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function tokensShort(n) {
  const value = Number(n) || 0
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(value)
}

function rate(u) {
  const input = u.inputTokens || 0
  return input > 0 ? `${(((u.cachedInputTokens || 0) / input) * 100).toFixed(0)}%` : '—'
}

const ROLE_STYLE = {
  user: 'bg-[#232a3a] text-[#9fb4e8]',
  assistant: 'bg-[#2a2a2a] text-[#eaeaea]',
  tool: 'bg-[#1e2e26] text-[#7fc79a]'
}
const ROLE_LABEL = { user: 'You', assistant: 'Assistant', tool: 'Tool' }

function MessageRow({ message, index }) {
  const role = message.role || 'assistant'
  return (
    <div className="flex flex-col gap-1.5 border-b border-[#1e1e1e] py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <span
          className={`rounded-[3px] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${ROLE_STYLE[role] || ROLE_STYLE.assistant}`}
        >
          {ROLE_LABEL[role] || role}
        </span>
        {role === 'tool' && message.toolCallId && (
          <span className="truncate font-mono text-[10px] text-[#707070]">
            {message.toolCallId}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-[#4a4a4a]">#{index + 1}</span>
      </div>
      {message.content ? (
        <details className="group">
          <summary className="cursor-pointer select-none text-[10px] text-[#707070] transition-colors hover:text-[#9a9a9a]">
            <span className="group-open:hidden">展开内容</span>
            <span className="hidden group-open:inline">收起</span>
          </summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-[#d6d6d6]">
            {message.content}
          </pre>
        </details>
      ) : null}
      {Array.isArray(message.toolCalls) && message.toolCalls.length > 0 && (
        <div className="flex flex-col gap-1">
          {message.toolCalls.map((tc, i) => (
            <details
              key={`${tc.id || i}`}
              className="group rounded-[4px] border border-[#2a2a2a] bg-[#161616] px-2 py-1"
            >
              <summary className="cursor-pointer select-none font-mono text-[11px] text-[#d0a86a]">
                {tc.name || 'tool_call'}
                {tc.arguments ? (
                  <span className="ml-1.5 text-[10px] text-[#707070]">
                    <span className="group-open:hidden">展开参数</span>
                    <span className="hidden group-open:inline">收起参数</span>
                  </span>
                ) : null}
              </summary>
              {tc.arguments ? (
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-[#9a9a9a]">
                  {tc.arguments}
                </pre>
              ) : null}
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

function UsageTable({ rows, title, pageSizeOptions = [5, 10, 20, 50, 100], defaultPageSize = 5 }) {
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  if (!rows || rows.length === 0) return null
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const current = Math.min(page, totalPages - 1)
  const shown = rows.slice(current * pageSize, (current + 1) * pageSize)
  const total = rows.reduce(
    (acc, u) => {
      acc.input += u.inputTokens || 0
      acc.cached += u.cachedInputTokens || 0
      acc.output += u.outputTokens || 0
      acc.total += u.totalTokens || 0
      return acc
    },
    { input: 0, cached: 0, output: 0, total: 0 }
  )
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[#9a9a9a]">
        <span className="text-[#707070]">{title}</span>
        <span className="tabular-nums">
          {rows.length} req · {tokensShort(total.input)} in · {tokensShort(total.output)} out
        </span>
        <span className="tabular-nums text-[#8a8a8a]">
          缓存率 {total.input > 0 ? `${((total.cached / total.input) * 100).toFixed(1)}%` : '—'}
        </span>
      </div>
      <div className="mt-1.5 overflow-x-auto thin-scrollbar">
        <table className="w-full min-w-[640px] table-fixed text-[11px]">
          <colgroup>
            <col className="w-[17%]" />
            <col className="w-[22%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[9%]" />
          </colgroup>
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-[#707070]">
              <th scope="col" className="whitespace-nowrap pb-1 text-left font-normal">
                时间
              </th>
              <th scope="col" className="whitespace-nowrap pb-1 text-left font-normal">
                模型
              </th>
              <th scope="col" className="whitespace-nowrap pb-1 text-right font-normal">
                输入
              </th>
              <th scope="col" className="whitespace-nowrap pb-1 text-right font-normal">
                缓存
              </th>
              <th scope="col" className="whitespace-nowrap pb-1 text-right font-normal">
                未缓存
              </th>
              <th scope="col" className="whitespace-nowrap pb-1 text-right font-normal">
                输出
              </th>
              <th scope="col" className="whitespace-nowrap pb-1 text-right font-normal">
                缓存率
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((u, i) => (
              <tr key={u.usageId || `${title}-${i}`} className="border-t border-[#1e1e1e]">
                <td className="py-1 pr-2 whitespace-nowrap font-mono text-[10px] text-[#8a8a8a] tabular-nums">
                  {fmtTime(u.occurredAt)}
                </td>
                <td
                  className="truncate py-1 pr-2 font-mono text-[10px] text-[#9a9a9a]"
                  title={u.model}
                >
                  {u.model || '—'}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-[#9a9a9a] tabular-nums">
                  {(u.inputTokens || 0).toLocaleString()}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-[#8a8a8a] tabular-nums">
                  {(u.cachedInputTokens || 0).toLocaleString()}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-[#9a9a9a] tabular-nums">
                  {((u.inputTokens || 0) - (u.cachedInputTokens || 0)).toLocaleString()}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-[#9a9a9a] tabular-nums">
                  {(u.outputTokens || 0).toLocaleString()}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-[#8a8a8a] tabular-nums">
                  {rate(u)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-1.5">
        <label className="flex items-center gap-1 text-[10px] text-[#707070]">
          每页
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value))
              setPage(0)
            }}
            className="rounded-[4px] border border-[#2a2a2a] bg-[#181818] px-1.5 py-0.5 font-mono text-[10px] text-[#9a9a9a]"
            aria-label="每页条数"
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          条
        </label>
        {totalPages > 1 && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={current === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded-[4px] border border-[#2a2a2a] bg-[#181818] px-2 py-0.5 text-[10px] text-[#9a9a9a] transition-colors enabled:hover:text-[#eaeaea] disabled:opacity-40"
            >
              上一页
            </button>
            <span className="font-mono text-[10px] text-[#707070] tabular-nums">
              {current + 1} / {totalPages}
            </span>
            <button
              type="button"
              disabled={current >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              className="rounded-[4px] border border-[#2a2a2a] bg-[#181818] px-2 py-0.5 text-[10px] text-[#9a9a9a] transition-colors enabled:hover:text-[#eaeaea] disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function SubagentCard({ record }) {
  const requests = record.requests || []
  const summary = record.summary || {}
  return (
    <div className="rounded-[4px] border border-[#2a2a2a] bg-[#161616] px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="rounded-[3px] bg-[#332b1a] px-1.5 py-0.5 text-[10px] font-semibold text-[#d0a86a]">
          {record.subagentType || 'subagent'}
        </span>
        <span
          className={`rounded-[3px] px-1.5 py-0.5 text-[10px] font-medium uppercase ${
            record.status === 'completed'
              ? 'bg-[#1e2e26] text-[#7fc79a]'
              : record.status === 'failed'
                ? 'bg-[#331f1f] text-[#e08a8a]'
                : 'bg-[#2a2a2a] text-[#c8c8c8]'
          }`}
        >
          {record.status || '—'}
        </span>
        {record.description && (
          <span className="truncate text-[11px] text-[#d6d6d6]" title={record.description}>
            {record.description}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-[#707070] tabular-nums">
          {requests.length} req · {tokensShort(summary.totalTokens || 0)} tokens
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-[#707070]">
        {record.taskId && <span title={record.taskId}>task {record.taskId}</span>}
        {record.initiatedByCallId && (
          <span title={record.initiatedByCallId}>call {record.initiatedByCallId}</span>
        )}
        {record.parentTaskId && (
          <span title={record.parentTaskId}>parent {record.parentTaskId}</span>
        )}
        {record.model && <span>{record.model}</span>}
        <span>
          {fmtTime(record.startedAt)}
          {record.finishedAt ? ` → ${fmtTime(record.finishedAt)}` : ''}
        </span>
      </div>
      {requests.length > 0 && (
        <details className="group mt-1">
          <summary className="cursor-pointer select-none text-[10px] text-[#707070] hover:text-[#9a9a9a]">
            <span className="group-open:hidden">展开逐条请求</span>
            <span className="hidden group-open:inline">收起逐条请求</span>
          </summary>
          <UsageTable rows={requests} title={`${record.subagentType || 'subagent'} 请求`} />
        </details>
      )}
    </div>
  )
}

export function SessionDetailModal({ sessionId, onClose }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)
  const [visible, setVisible] = useState(BATCH)

  useEffect(() => {
    let alive = true
    setDetail(null)
    setError(null)
    setVisible(BATCH)
    window.mica.stats
      .sessionDetail(sessionId)
      .then((data) => {
        if (alive) setDetail(data)
      })
      .catch((err) => {
        if (alive) setError(String(err?.message || err))
      })
    return () => {
      alive = false
    }
  }, [sessionId])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const messages = detail?.messages || []
  const usageHistory = useMemo(() => detail?.usageHistory || [], [detail])
  const subagents = useMemo(() => detail?.subagentUsageHistory || [], [detail])
  const subRequests = useMemo(
    () => subagents.flatMap((record) => record.requests || []),
    [subagents]
  )
  const allUsage = useMemo(() => {
    const rows = [
      ...usageHistory.map((u) => ({ ...u, source: 'main' })),
      ...subRequests.map((u) => ({ ...u, source: 'sub' }))
    ]
    return rows.sort((a, b) => (a.occurredAt || '').localeCompare(b.occurredAt || ''))
  }, [usageHistory, subRequests])

  const totals = useMemo(() => {
    const sum = (list) =>
      list.reduce(
        (acc, u) => {
          acc.input += u.inputTokens || 0
          acc.cached += u.cachedInputTokens || 0
          acc.output += u.outputTokens || 0
          acc.total += u.totalTokens || 0
          return acc
        },
        { input: 0, cached: 0, output: 0, total: 0 }
      )
    const main = sum(usageHistory)
    const sub = sum(subRequests)
    return {
      main,
      sub,
      all: {
        input: main.input + sub.input,
        cached: main.cached + sub.cached,
        output: main.output + sub.output,
        total: main.total + sub.total
      }
    }
  }, [usageHistory, subRequests])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[6px] border border-[#2a2a2a] bg-[#141414] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[#2a2a2a] px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-[#eaeaea]">
              {detail?.title || 'Session detail'}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-[#707070]">
              <span className="font-mono">{detail?.id ? detail.id.slice(0, 12) : ''}</span>
              {detail?.model && <span>{detail.model}</span>}
              {detail?.effort && <span>effort {detail.effort}</span>}
              {detail?.role && <span>role {detail.role}</span>}
              <span
                className={
                  detail?.turnState === 'completed'
                    ? 'text-[#7fc79a]'
                    : detail?.turnState === 'aborted'
                      ? 'text-[#d0a86a]'
                      : 'text-[#e08a8a]'
                }
              >
                {detail?.turnState || '—'}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-[#4a4a4a]">
              {fmtTime(detail?.createdAt)} → {fmtTime(detail?.updatedAt)}
              {detail?.cwd ? ` · ${detail.cwd}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 rounded-[4px] border border-[#2a2a2a] bg-[#181818] px-2 py-0.5 text-[11px] text-[#9a9a9a] transition-colors hover:text-[#eaeaea]"
          >
            Esc ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar px-4 py-3">
          {error ? (
            <div className="rounded-[4px] border border-[#332424] bg-[#1a1414] px-3 py-2 text-xs text-[#e08a8a]">
              {error}
            </div>
          ) : !detail ? (
            <div className="py-10 text-center text-xs text-[#707070]">加载中…</div>
          ) : (
            <div className="flex flex-col gap-5">
              <section>
                <h3 className={OVERLINE_CLASS}>Token 情况</h3>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="rounded-[4px] border border-[#2a2a2a] bg-[#161616] px-2.5 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-[#707070]">
                      主 agent
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-[#eaeaea] tabular-nums">
                      {usageHistory.length} req
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-[#8a8a8a] tabular-nums">
                      {tokensShort(totals.main.input)} in · {tokensShort(totals.main.output)} out
                    </div>
                  </div>
                  <div className="rounded-[4px] border border-[#2a2a2a] bg-[#161616] px-2.5 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-[#707070]">
                      sub-agents
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-[#eaeaea] tabular-nums">
                      {subRequests.length} req
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-[#8a8a8a] tabular-nums">
                      {tokensShort(totals.sub.input)} in · {tokensShort(totals.sub.output)} out
                    </div>
                  </div>
                  <div className="rounded-[4px] border border-[#2a2a2a] bg-[#161616] px-2.5 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-[#707070]">合计</div>
                    <div className="mt-0.5 font-mono text-xs text-[#eaeaea] tabular-nums">
                      {tokensShort(totals.all.total)}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-[#8a8a8a] tabular-nums">
                      {totals.all.input.toLocaleString()} in · {totals.all.output.toLocaleString()}{' '}
                      out
                    </div>
                  </div>
                  <div className="rounded-[4px] border border-[#2a2a2a] bg-[#161616] px-2.5 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-[#707070]">缓存率</div>
                    <div className="mt-0.5 font-mono text-xs text-[#eaeaea] tabular-nums">
                      {totals.all.input > 0
                        ? `${((totals.all.cached / totals.all.input) * 100).toFixed(1)}%`
                        : '—'}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-[#8a8a8a] tabular-nums">
                      {totals.all.cached.toLocaleString()} cached
                    </div>
                  </div>
                </div>
                <UsageTable rows={allUsage} title="逐条请求（主 + sub 合并，按时间排序）" />
              </section>

              <section>
                <h3 className={OVERLINE_CLASS}>对话 / 工具调用</h3>
                <p className="mt-1 text-[10px] text-[#4a4a4a]">
                  按模型请求顺序展示；思考内容不随会话持久化，历史会话无法还原思考过程。
                </p>
                <div className="mt-2">
                  {messages.length === 0 ? (
                    <div className="py-4 text-center text-[11px] text-[#707070]">无消息记录</div>
                  ) : (
                    messages
                      .slice(0, visible)
                      .map((message, i) => <MessageRow key={i} message={message} index={i} />)
                  )}
                  {messages.length > visible && (
                    <button
                      type="button"
                      onClick={() => setVisible((v) => v + BATCH)}
                      className="mt-2 w-full rounded-[4px] border border-[#2a2a2a] bg-[#181818] py-1.5 text-[11px] text-[#9a9a9a] transition-colors hover:text-[#eaeaea]"
                    >
                      显示更多（{messages.length - visible} 条）
                    </button>
                  )}
                </div>
              </section>

              {subagents.length > 0 && (
                <section>
                  <h3 className={OVERLINE_CLASS}>Sub-agents</h3>
                  <div className="mt-2 flex flex-col gap-2">
                    {subagents.map((record) => (
                      <SubagentCard
                        key={record.taskId || record.initiatedByCallId || Math.random()}
                        record={record}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
