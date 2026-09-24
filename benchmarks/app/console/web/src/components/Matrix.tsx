import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { STATE_META, formatTokens } from '@/lib/format'
import type { AgentMeta, CellRow, ResultsPayload } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Props {
  results: ResultsPayload
  agents: AgentMeta[]
  onSelect: (key: string) => void
}

export function Matrix({ results, agents, onSelect }: Props) {
  const tasks = results.tasks
  const index = new Map(results.matrix.map((row) => [row.key, row]))

  const shown = agents.filter((agent) => tasks.some((task) => index.has(`${agent.id}__${task}`)))

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">矩阵</CardTitle>
        <p className="text-xs text-muted-foreground">
          行 = agent（{shown.length}），列 = 任务（{tasks.length}），每格 = 该 agent
          在该任务上的一次运行（共 {shown.length * tasks.length}）。点击任意单元格查看测试明细（哪些用例没通过）、Token 与单 cell 操作。
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto no-scrollbar">
          {/* min-w-max keeps the task columns at a readable width and lets the
           * card scroll horizontally instead of squeezing every name into an
           * ellipsis; w-full still stretches to fill when there is room. */}
          <table className="w-full min-w-max border-separate border-spacing-1">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-card px-1 text-left text-xs font-medium text-muted-foreground">
                  agent ＼ 任务
                </th>
                {tasks.map((task) => (
                  <th
                    key={task}
                    className="px-1 pb-1 text-left align-bottom text-[11px] font-medium text-muted-foreground"
                  >
                    <span className="block max-w-[140px] truncate" title={task}>
                      {task}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((agent) => (
                <tr key={agent.id}>
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-card pr-2 text-xs font-medium">
                    {agent.label}
                  </td>
                  {tasks.map((task) => {
                    const row = index.get(`${agent.id}__${task}`)
                    if (!row) {
                      return (
                        <td key={task}>
                          <div className="h-12 rounded border border-dashed border-border/60" />
                        </td>
                      )
                    }
                    return (
                      <td key={task}>
                        <CellButton row={row} onClick={() => onSelect(row.key)} />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t pt-3">
          {(Object.keys(STATE_META) as (keyof typeof STATE_META)[]).map((state) => (
            <div key={state} className="flex items-center gap-1.5 text-xs">
              <span className={cn('size-2 rounded-full', STATE_META[state].dot)} />
              <span className="text-muted-foreground">{STATE_META[state].label}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function CellButton({ row, onClick }: { row: CellRow; onClick: () => void }) {
  const meta = STATE_META[row.state]
  const partial =
    row.partial_total && row.partial_total > 0
      ? `${row.partial_passed ?? 0}/${row.partial_total}`
      : null

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${row.agent} / ${row.task} — ${meta.label}${
        row.exception ? ` · ${row.exception}` : ''
      }`}
      className={cn(
        'group relative h-12 w-full min-w-[124px] overflow-hidden rounded border px-1.5 py-1 text-left transition-transform hover:-translate-y-px hover:ring-1 hover:ring-ring',
        row.state === 'pass' && 'border-success/40 bg-success/10',
        row.state === 'fail' && 'border-destructive/40 bg-destructive/10',
        row.state === 'timeout' && 'border-warning/40 bg-warning/10',
        row.state === 'exception' && 'border-warning/30 bg-warning/5',
        row.state === 'stalled' && 'border-border bg-muted/50',
        row.state === 'running' && 'border-primary/40 bg-primary/10',
        row.state === 'pending' && 'border-border/60 bg-transparent',
      )}
    >
      <span className={cn('absolute inset-y-0 left-0 w-0.5', meta.fill)} />
      <span className="block pl-1 text-[10px] font-medium leading-tight">{meta.label}</span>
      {partial && (
        <span className="block pl-1 text-[10px] leading-tight text-muted-foreground nums">
          {partial}
        </span>
      )}
      {row.rounds > 0 && (
        <span className="block pl-1 text-[10px] leading-tight text-muted-foreground nums">
          {row.rounds}轮 {formatTokens(row.prompt_tokens)}
        </span>
      )}
    </button>
  )
}
