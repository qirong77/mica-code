import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { StackedBar } from './ui/progress'
import { STATE_META, formatDuration, formatTokens } from '@/lib/format'
import type { AgentMeta, AgentTotals, ResultsPayload, RunState } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Props {
  progress: ResultsPayload['progress']
  byAgent: AgentTotals[]
  agents: AgentMeta[]
  run: RunState | null
  meanWall: number | null
}

const STATE_ORDER = ['pass', 'fail', 'timeout', 'exception', 'stalled', 'running', 'pending'] as const

export function ProgressPanel({ progress, byAgent, agents, run, meanWall }: Props) {
  const { total, done } = progress
  const segments = STATE_ORDER.map((state) => ({
    value: progress[state] ?? 0,
    className: STATE_META[state].fill,
    title: `${STATE_META[state].label} ${progress[state] ?? 0}`,
  }))

  const doneAgents = byAgent.filter((a) => a.done > 0)
  const partialPassed = doneAgents.reduce((sum, a) => sum + a.partial_passed, 0)
  const partialTotal = doneAgents.reduce((sum, a) => sum + a.partial_total, 0)

  const remaining = total - done - progress.running
  const throughput = done > 0 && meanWall ? meanWall : null
  const concurrency = run?.active ? run.parallelism : 1
  const etaSecs =
    throughput && remaining > 0
      ? (remaining * throughput) / Math.max(1, concurrency)
      : null

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">进度</CardTitle>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground nums">
            <span>
              <span className="font-medium text-foreground">{done}</span>/{total} 完成
            </span>
            {progress.running > 0 && <span>{progress.running} 运行中</span>}
            {progress.pending > 0 && <span>{progress.pending} 待运行</span>}
            {progress.stalled > 0 && <span>{progress.stalled} 卡死</span>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <StackedBar segments={segments} className="h-2.5" />

        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {STATE_ORDER.filter((state) => (progress[state] ?? 0) > 0).map((state) => (
            <div key={state} className="flex items-center gap-1.5 text-xs">
              <span className={cn('size-2 rounded-full', STATE_META[state].dot)} />
              <span className="text-muted-foreground">{STATE_META[state].label}</span>
              <span className="font-medium nums">{progress[state]}</span>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 border-t pt-3 sm:grid-cols-4">
          <Stat label="通过" value={String(progress.pass)} tone={progress.pass ? 'good' : undefined} />
          <Stat
            label="部分通过 (cell 等权)"
            value={partialTotal ? `${((100 * partialPassed) / partialTotal).toFixed(1)}%` : '—'}
            hint={partialTotal ? `${partialPassed}/${partialTotal} 项测试` : undefined}
          />
          <Stat label="平均单 cell" value={formatDuration(meanWall)} />
          <Stat
            label="预计剩余"
            value={etaSecs ? formatDuration(etaSecs) : '—'}
            hint={etaSecs ? `按 ${concurrency} 并发外推` : undefined}
          />
        </div>

        <div className="border-t pt-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            分 agent（token / 轮次来自本地代理）
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => {
              const totals = byAgent.find((a) => a.agent === agent.id)
              if (!totals) return null
              const rate = totals.partial_total
                ? (100 * totals.partial_passed) / totals.partial_total
                : null
              return (
                <div key={agent.id} className="rounded-md border px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{agent.label}</span>
                    <span className="text-xs text-muted-foreground nums">
                      {totals.done}/{totals.cells}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground nums">
                    <span title="通过 cell 数">
                      <span className="font-medium text-success">{totals.pass}</span> 通过
                    </span>
                    <span title="代理累计 prompt tokens">
                      {formatTokens(totals.prompt_tokens)} tokens
                    </span>
                    <span title="代理累计请求轮次">{totals.rounds} 轮</span>
                    {rate !== null && (
                      <span title="CTRF 部分通过率">{rate.toFixed(0)}%</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'good'
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'text-base font-semibold nums',
          tone === 'good' && 'text-success',
        )}
      >
        {value}
      </div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}
