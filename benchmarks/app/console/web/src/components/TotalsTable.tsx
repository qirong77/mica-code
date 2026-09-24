import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table'
import { formatCount, formatDuration, formatTokens } from '@/lib/format'
import type { AgentMeta, AgentTotals } from '@/lib/types'

interface Props {
  byAgent: AgentTotals[]
  agents: AgentMeta[]
  totals?: Record<string, number>
}

export function TotalsTable({ byAgent, agents, totals }: Props) {
  const rows = agents
    .map((agent) => ({ agent, totals: byAgent.find((a) => a.agent === agent.id) }))
    .filter((row): row is { agent: AgentMeta; totals: AgentTotals } => Boolean(row.totals))

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Agent 对比</CardTitle>
        <CardDescription>
          token / 轮次是本地代理统计的真值。通过率有两种口径：cell 全票通过（严）与
          CTRF 部分分（含部分对）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>agent</TableHead>
              <TableHead className="text-right">完成</TableHead>
              <TableHead className="text-right">通过</TableHead>
              <TableHead className="text-right">部分分</TableHead>
              <TableHead className="text-right">轮次</TableHead>
              <TableHead className="text-right">Prompt</TableHead>
              <TableHead className="text-right">缓存命中</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead className="text-right">轮/cell</TableHead>
              <TableHead className="text-right">Token/cell</TableHead>
              <TableHead className="text-right">工具调用</TableHead>
              <TableHead className="text-right">错误</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ agent, totals: t }) => {
              const rate = t.partial_total ? (100 * t.partial_passed) / t.partial_total : null
              const perCell = t.done ? t.prompt_tokens / t.done : null
              const cachedPct = t.prompt_tokens
                ? (100 * t.cached_tokens) / t.prompt_tokens
                : null
              return (
                <TableRow key={agent.id}>
                  <TableCell className="font-medium">{agent.label}</TableCell>
                  <TableCell className="text-right nums">
                    {t.done}/{t.cells}
                  </TableCell>
                  <TableCell className="text-right nums">
                    <span className={t.pass ? 'font-semibold text-success' : ''}>
                      {t.pass}
                    </span>
                  </TableCell>
                  <TableCell className="text-right nums">
                    {rate === null ? '—' : `${rate.toFixed(1)}%`}
                  </TableCell>
                  <TableCell className="text-right nums">{formatCount(t.rounds)}</TableCell>
                  <TableCell className="text-right nums">
                    {formatTokens(t.prompt_tokens)}
                  </TableCell>
                  <TableCell className="text-right nums text-muted-foreground">
                    {cachedPct === null ? '—' : `${cachedPct.toFixed(0)}%`}
                  </TableCell>
                  <TableCell className="text-right nums">
                    {formatTokens(t.output_tokens)}
                  </TableCell>
                  <TableCell className="text-right nums text-muted-foreground">
                    {t.done ? (t.rounds / t.done).toFixed(1) : '—'}
                  </TableCell>
                  <TableCell className="text-right nums text-muted-foreground">
                    {perCell === null ? '—' : formatTokens(perCell)}
                  </TableCell>
                  <TableCell className="text-right nums">{formatCount(t.tool_calls)}</TableCell>
                  <TableCell className="text-right nums">
                    {t.errors ? (
                      <span className="text-destructive">{t.errors}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
            {totals && (
              <TableRow className="border-t-2 font-medium">
                <TableCell>合计</TableCell>
                <TableCell className="text-right nums">
                  {rows.reduce((s, r) => s + r.totals.done, 0)}
                </TableCell>
                <TableCell className="text-right nums">
                  {rows.reduce((s, r) => s + r.totals.pass, 0)}
                </TableCell>
                <TableCell className="text-right nums">—</TableCell>
                <TableCell className="text-right nums">
                  {formatCount(totals.rounds)}
                </TableCell>
                <TableCell className="text-right nums">
                  {formatTokens(totals.prompt_tokens)}
                </TableCell>
                <TableCell className="text-right nums text-muted-foreground">
                  {totals.prompt_tokens
                    ? `${((100 * totals.cached_tokens) / totals.prompt_tokens).toFixed(0)}%`
                    : '—'}
                </TableCell>
                <TableCell className="text-right nums">
                  {formatTokens(totals.output_tokens)}
                </TableCell>
                <TableCell className="text-right nums">—</TableCell>
                <TableCell className="text-right nums">—</TableCell>
                <TableCell className="text-right nums">
                  {formatCount(totals.tool_calls)}
                </TableCell>
                <TableCell className="text-right nums">
                  {totals.errors ? (
                    <span className="text-destructive">{totals.errors}</span>
                  ) : (
                    '0'
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          {rows.map(({ agent, totals: t }) => (
            <span key={agent.id}>
              {agent.label} 平均单 cell {formatDuration(t.mean_wall_secs)}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
