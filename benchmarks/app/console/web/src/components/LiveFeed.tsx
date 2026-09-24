import { useEffect, useState } from 'react'

import { Badge } from './ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { api } from '@/lib/api'
import { formatAgo, formatTokens } from '@/lib/format'
import type { EventRow } from '@/lib/types'
import { cn } from '@/lib/utils'

const POLL_MS = 3000

export function LiveFeed({ eventsPath }: { eventsPath?: string }) {
  const [rows, setRows] = useState<EventRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now() / 1000)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const data = await api.events(60)
        if (alive) {
          setRows([...data.rows].reverse())
          setError(null)
          setNow(Date.now() / 1000)
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void load()
    const timer = window.setInterval(load, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">实时请求</CardTitle>
        <CardDescription className="truncate" title={eventsPath}>
          本地代理逐条记录，token 与轮次以它为准
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="mb-1 flex items-center gap-2 px-2 text-[10px] text-muted-foreground">
          <span className="w-16 shrink-0">时间</span>
          <span className="w-20 shrink-0">agent</span>
          <span className="w-10 shrink-0">#</span>
          <span className="min-w-0 flex-1">task</span>
          <span className="w-16 shrink-0 text-right">prompt</span>
          <span className="w-14 shrink-0 text-right">cached</span>
          <span className="w-14 shrink-0 text-right">output</span>
          <span className="w-12 shrink-0 text-right">tools</span>
          <span className="w-10 shrink-0 text-right">http</span>
        </div>
        <div className="max-h-[320px] space-y-1 overflow-y-auto no-scrollbar">
          {rows.length === 0 && (
            <p className="text-xs text-muted-foreground">暂无请求。</p>
          )}
          {rows.map((row) => {
            const failed = row.proxy_error || (row.status ?? 0) >= 400
            const probe = row.method === 'GET'
            return (
              <div
                key={`${row.agent}-${row.task}-${row.seq}-${row.ts}`}
                className={cn(
                  'flex items-center gap-2 rounded px-2 py-1 text-[11px] nums',
                  failed ? 'bg-destructive/10' : 'bg-muted/40',
                )}
              >
                <span className="w-16 shrink-0 text-muted-foreground">
                  {formatAgo(now - row.ts)}
                </span>
                <span className="w-20 shrink-0 truncate font-medium">{row.agent}</span>
                <span className="w-10 shrink-0 text-muted-foreground">
                  #{row.seq}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={row.task ?? ''}>
                  {row.task ?? '—'}
                </span>
                {probe ? (
                  <Badge variant="muted" className="shrink-0">
                    探测
                  </Badge>
                ) : (
                  <>
                    <span className="w-16 shrink-0 text-right">
                      {formatTokens(row.usage?.input ?? null)}
                    </span>
                    <span className="w-14 shrink-0 text-right text-muted-foreground">
                      {row.usage?.cached ? formatTokens(row.usage.cached) : '—'}
                    </span>
                    <span className="w-14 shrink-0 text-right">
                      {formatTokens(row.usage?.output ?? null)}
                    </span>
                    <span className="w-12 shrink-0 text-right text-muted-foreground">
                      {row.tool_calls ?? 0}🔧
                    </span>
                  </>
                )}
                <span
                  className={cn(
                    'w-10 shrink-0 text-right',
                    failed && 'font-medium text-destructive',
                  )}
                >
                  {row.status ?? '—'}
                </span>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
