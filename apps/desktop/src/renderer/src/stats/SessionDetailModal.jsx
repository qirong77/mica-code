import { useEffect, useMemo, useState } from 'react'
import { SessionDetailView } from '@mica-config-ui/web'
import { USAGE_SOURCE_LABELS, usageSourceOf } from '@packages/mica-web-shared/usage-source.js'
import { ModalMeta, ModalShell } from '../chat-modal'

const OVERLINE_CLASS = 'text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-dim'

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtTokens(value) {
  const n = Number(value) || 0
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

function rate(u) {
  const input = u.inputTokens || 0
  return input > 0 ? `${(((u.cachedInputTokens || 0) / input) * 100).toFixed(0)}%` : '—'
}

function StatCard({ label, primary, secondary }) {
  return (
    <div className="rounded-[4px] border border-line bg-panel-hi px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-fg-faint">{label}</div>
      <div className="mt-0.5 font-mono text-xs text-fg-strong tabular-nums">{primary}</div>
      <div className="mt-0.5 font-mono text-[10px] text-fg-dim tabular-nums">{secondary}</div>
    </div>
  )
}

/** 某一类来源（委派 / 插件 / 内核后台）的请求数与 token 合计。 */
function sumRecords(groups, kind) {
  const totals = { requests: 0, input: 0, cached: 0, output: 0, total: 0 }
  const group = groups.find((item) => item.kind === kind)
  if (!group) return totals
  for (const { record } of group.items) {
    totals.requests += (record.requests || []).length
    totals.input += record.summary?.inputTokens || 0
    totals.cached += record.summary?.cachedInputTokens || 0
    totals.output += record.summary?.outputTokens || 0
    totals.total += record.summary?.totalTokens || 0
  }
  return totals
}

function UsageTable({
  rows,
  title,
  showSource = false,
  pageSizeOptions = [5, 10, 20, 50, 100],
  defaultPageSize = 10
}) {
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-fg-muted">
        <span className="text-fg-faint">{title}</span>
        <span className="tabular-nums">
          {rows.length} req · {fmtTokens(total.input)} in · {fmtTokens(total.output)} out
        </span>
        <span className="tabular-nums text-fg-dim">
          缓存率 {total.input > 0 ? `${((total.cached / total.input) * 100).toFixed(1)}%` : '—'}
        </span>
      </div>
      <div className="mt-1.5 overflow-x-auto">
        <table className="w-full min-w-[640px] table-fixed text-[11px]">
          <colgroup>
            <col className="w-[17%]" />
            {showSource && <col className="w-[9%]" />}
            <col className="w-[22%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[9%]" />
          </colgroup>
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-fg-faint">
              <th scope="col" className="whitespace-nowrap pb-1 text-left font-normal">
                时间
              </th>
              {showSource && (
                <th scope="col" className="whitespace-nowrap pb-1 text-left font-normal">
                  来源
                </th>
              )}
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
              <tr key={u.usageId || `${title}-${i}`} className="border-t border-line">
                <td className="py-1 pr-2 whitespace-nowrap font-mono text-[10px] text-fg-dim tabular-nums">
                  {fmtTime(u.occurredAt)}
                </td>
                {showSource && (
                  <td className="truncate py-1 pr-2 text-[10px] text-fg-dim">
                    {u.sourceLabel || '—'}
                  </td>
                )}
                <td
                  className="truncate py-1 pr-2 font-mono text-[10px] text-fg-muted"
                  title={u.model}
                >
                  {u.model || '—'}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-muted tabular-nums">
                  {(u.inputTokens || 0).toLocaleString()}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-dim tabular-nums">
                  {(u.cachedInputTokens || 0).toLocaleString()}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-muted tabular-nums">
                  {((u.inputTokens || 0) - (u.cachedInputTokens || 0)).toLocaleString()}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-muted tabular-nums">
                  {(u.outputTokens || 0).toLocaleString()}
                </td>
                <td className="py-1 pr-2 text-right font-mono text-[10px] text-fg-dim tabular-nums">
                  {rate(u)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-1.5">
        <label className="flex items-center gap-1 text-[10px] text-fg-faint">
          每页
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value))
              setPage(0)
            }}
            className="rounded-[4px] border border-line bg-panel-hi px-1.5 py-0.5 font-mono text-[10px] text-fg-muted"
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
              className="rounded-[4px] border border-line bg-panel-hi px-2 py-0.5 text-[10px] text-fg-muted transition-colors enabled:hover:text-fg-strong disabled:opacity-40"
            >
              上一页
            </button>
            <span className="font-mono text-[10px] text-fg-faint tabular-nums">
              {current + 1} / {totalPages}
            </span>
            <button
              type="button"
              disabled={current >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              className="rounded-[4px] border border-line bg-panel-hi px-2 py-0.5 text-[10px] text-fg-muted transition-colors enabled:hover:text-fg-strong disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function UsageRecordCard({ record, source }) {
  const requests = record.requests || []
  const summary = record.summary || {}
  const title =
    source.kind === 'plugin' ? source.pluginId || record.subagentType : record.subagentType
  return (
    <div className="rounded-[4px] border border-line bg-panel-hi px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="rounded-[3px] bg-warn/12 px-1.5 py-0.5 text-[10px] font-semibold text-warn">
          {title || 'request'}
        </span>
        <span className="rounded-[3px] bg-panel px-1.5 py-0.5 text-[10px] text-fg-dim">
          {USAGE_SOURCE_LABELS[source.kind]}
        </span>
        <span
          className={`rounded-[3px] px-1.5 py-0.5 text-[10px] font-medium uppercase ${
            record.status === 'completed'
              ? 'bg-success/12 text-success-soft'
              : record.status === 'failed'
                ? 'bg-danger/12 text-danger-soft'
                : 'bg-panel-hi text-fg'
          }`}
        >
          {record.status || '—'}
        </span>
        {record.description && (
          <span className="truncate text-[11px] text-fg" title={record.description}>
            {record.description}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-fg-faint tabular-nums">
          {requests.length} req · {fmtTokens(summary.totalTokens || 0)} tokens
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-fg-faint">
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
          <summary className="cursor-pointer select-none text-[10px] text-fg-faint hover:text-fg-muted">
            <span className="group-open:hidden">展开逐条请求</span>
            <span className="hidden group-open:inline">收起逐条请求</span>
          </summary>
          <UsageTable rows={requests} title={`${title || '请求'} 请求`} />
        </details>
      )}
    </div>
  )
}

const SOURCE_SECTION_TITLES = {
  delegation: 'Delegated subagents',
  plugin: '插件请求',
  helper: '内核后台请求'
}
const SOURCE_SECTION_HINTS = {
  delegation: '主对话经工具派出去的子代理：自己的上下文，但花的是同一条会话的钱。',
  plugin: '插件自己的模型请求与它起的后台任务（自动起标题、写提交说明、整理记忆…）。',
  helper: '内核自带的助手请求（压缩摘要、桌面旁问）：不进主上下文，但同样计入本会话。'
}

/**
 * 会话详情：与上下文弹窗、配置页的 Sessions 页共用 `SessionDetailView`（系统提示词 /
 * 对话记录 / Context 分析 / 原始文件），这里只多一个统计页专属的「用量」页签。
 */
export function SessionDetailModal({ sessionId, onClose }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    setDetail(null)
    setError(null)
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

  const usageHistory = useMemo(() => detail?.usageHistory || [], [detail])
  const records = useMemo(() => detail?.subagentUsageHistory || [], [detail])
  // 同一份数组里装着所有「不进主上下文」的请求：委派子代理、插件自己的模型请求、
  // 内核后台助手。归到哪一类由 `usageSourceOf` 统一判定，和统计页的总表同源。
  const groups = useMemo(() => {
    const byKind = new Map()
    let allRecords = 0
    for (const record of records) {
      const source = usageSourceOf(record)
      const list = byKind.get(source.kind) || []
      list.push({ record, source })
      byKind.set(source.kind, list)
      allRecords += (record.requests || []).length
    }
    const ordered = ['delegation', 'plugin', 'helper']
      .filter((kind) => byKind.has(kind))
      .map((kind) => ({
        kind,
        items: byKind
          .get(kind)
          .sort(
            (a, b) =>
              (b.record.summary?.totalTokens || 0) - (a.record.summary?.totalTokens || 0) ||
              String(a.source.id).localeCompare(String(b.source.id))
          )
      }))
    const totals = { requests: 0, input: 0, cached: 0, output: 0, total: 0 }
    for (const { record } of ordered.flatMap((group) => group.items)) {
      totals.requests += (record.requests || []).length
      totals.input += record.summary?.inputTokens || 0
      totals.cached += record.summary?.cachedInputTokens || 0
      totals.output += record.summary?.outputTokens || 0
      totals.total += record.summary?.totalTokens || 0
    }
    return { ordered, totals, allRecords }
  }, [records])

  const delegatedTotals = useMemo(() => sumRecords(groups.ordered, 'delegation'), [groups])
  const pluginTotals = useMemo(() => sumRecords(groups.ordered, 'plugin'), [groups])
  const helperTotals = useMemo(() => sumRecords(groups.ordered, 'helper'), [groups])

  const allUsage = useMemo(() => {
    const rows = [
      ...usageHistory.map((u) => ({ ...u, sourceLabel: USAGE_SOURCE_LABELS.main })),
      ...records.flatMap((record) => {
        const source = usageSourceOf(record)
        return (record.requests || []).map((u) => ({
          ...u,
          sourceLabel: USAGE_SOURCE_LABELS[source.kind]
        }))
      })
    ]
    return rows.sort((a, b) => (a.occurredAt || '').localeCompare(b.occurredAt || ''))
  }, [usageHistory, records])

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
    return {
      main,
      all: {
        input: main.input + groups.totals.input,
        cached: main.cached + groups.totals.cached,
        output: main.output + groups.totals.output,
        total: main.total + groups.totals.total
      }
    }
  }, [groups, usageHistory])

  const usageTab = useMemo(
    () => ({
      id: 'usage',
      label: '用量',
      content: (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard
              label="主对话"
              primary={`${usageHistory.length} req`}
              secondary={`${fmtTokens(totals.main.input)} in · ${fmtTokens(totals.main.output)} out`}
            />
            <StatCard
              label="委派子代理"
              primary={`${delegatedTotals.requests} req`}
              secondary={`${fmtTokens(delegatedTotals.input)} in · ${fmtTokens(delegatedTotals.output)} out`}
            />
            <StatCard
              label="插件"
              primary={`${pluginTotals.requests} req`}
              secondary={`${fmtTokens(pluginTotals.input)} in · ${fmtTokens(pluginTotals.output)} out`}
            />
            <StatCard
              label="内核后台"
              primary={`${helperTotals.requests} req`}
              secondary={`${fmtTokens(helperTotals.input)} in · ${fmtTokens(helperTotals.output)} out`}
            />
            <StatCard
              label="合计"
              primary={fmtTokens(totals.all.total)}
              secondary={`${totals.all.input.toLocaleString()} in · ${totals.all.output.toLocaleString()} out`}
            />
            <StatCard
              label="缓存率"
              primary={
                totals.all.input > 0
                  ? `${((totals.all.cached / totals.all.input) * 100).toFixed(1)}%`
                  : '—'
              }
              secondary={`${totals.all.cached.toLocaleString()} cached`}
            />
          </div>
          <UsageTable
            rows={allUsage}
            title="逐条请求（主对话 + 委派 + 插件 + 内核后台，按时间排序）"
            showSource
          />
          <p className="text-[10px] leading-relaxed text-fg-ghost">
            输入逐条上涨多为上一轮的输出被回放：思考型模型（reasoning）的思考内容同样计入下一次
            input，所以「输出」和「输入增长」会一起变大。
          </p>

          {groups.ordered.map((group) => (
            <section key={group.kind}>
              <h3 className={OVERLINE_CLASS}>{SOURCE_SECTION_TITLES[group.kind]}</h3>
              <p className="mt-1 text-[10px] text-fg-ghost">{SOURCE_SECTION_HINTS[group.kind]}</p>
              <div className="mt-2 flex flex-col gap-2">
                {group.items.map(({ record, source }) => (
                  <UsageRecordCard
                    key={`${source.kind}-${source.id}-${record.taskId || record.startedAt}`}
                    record={record}
                    source={source}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )
    }),
    [allUsage, delegatedTotals, groups, helperTotals, pluginTotals, totals, usageHistory.length]
  )

  return (
    <ModalShell
      title={detail?.title || '会话详情'}
      subtitle={detail?.id ? detail.id.slice(0, 12) : null}
      onClose={onClose}
      className="chat-modal-session-detail"
      meta={
        <ModalMeta
          items={[
            detail?.model,
            detail?.effort ? `effort ${detail.effort}` : null,
            detail?.role ? `role ${detail.role}` : null,
            detail?.turnState || null,
            `${fmtTime(detail?.createdAt)} → ${fmtTime(detail?.updatedAt)}`,
            detail?.cwd
          ]}
        />
      }
    >
      {error ? (
        <div className="rounded-[4px] border border-danger/30 bg-danger/8 px-3 py-2 text-xs text-danger-soft">
          {error}
        </div>
      ) : (
        <div className="mica-config-ui is-embed session-detail-embed">
          <SessionDetailView
            sessionId={sessionId}
            defaultTab="conversation"
            extraTabs={[usageTab]}
          />
        </div>
      )}
    </ModalShell>
  )
}
