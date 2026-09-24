import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  RefreshCw,
  Square,
  XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Badge } from './ui/badge'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Separator } from './ui/separator'
import { api } from '@/lib/api'
import { STATE_META, formatCount, formatDuration, formatTokens } from '@/lib/format'
import type { CellRow, CellTest } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Props {
  row: CellRow | null
  tag: string
  onClose: () => void
  onChanged: () => void
}

/** How many test rows to paint at once; wal-recovery-ordering has 97. */
const TEST_PAGE = 40

export function CellDrawer({ row, tag, onClose, onChanged }: Props) {
  const [log, setLog] = useState<string[]>([])
  const [logError, setLogError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [failedOnly, setFailedOnly] = useState(false)
  const [testLimit, setTestLimit] = useState(TEST_PAGE)
  const open = row !== null

  useEffect(() => {
    if (!row) {
      setLog([])
      setLogError(null)
      setShowLog(false)
      setFailedOnly(false)
      setTestLimit(TEST_PAGE)
      return
    }
    let alive = true
    const load = async () => {
      const result = await api.log(row.key, 400)
      if (!alive) return
      if (result.ok) {
        setLog(result.lines ?? [])
        setLogError(null)
      } else {
        setLogError(result.error ?? '无法读取日志')
      }
    }
    void load()
    const timer = window.setInterval(load, row.running ? 4000 : 30_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [row])

  // Failed tests first: "哪些没通过" is the question this dialog exists to answer.
  const tests = useMemo(() => {
    const all = row?.tests ?? []
    const failed = all.filter((t) => t.status === 'failed')
    const rest = all.filter((t) => t.status !== 'failed')
    return failedOnly ? failed : [...failed, ...rest]
  }, [row?.tests, failedOnly])

  if (!row) return null
  const meta = STATE_META[row.state]
  const allTests = row.tests ?? []
  const failCount = allTests.filter((t) => t.status === 'failed').length
  const passCount = allTests.length - failCount

  async function act(key: string, fn: () => Promise<{ ok?: boolean; error?: string }>) {
    setPending(key)
    try {
      await fn()
      onChanged()
    } finally {
      setPending(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className={cn('size-2.5 rounded-full', meta.dot)} />
            {row.agent} / {row.task}
            <Badge variant={meta.variant}>{meta.label}</Badge>
          </DialogTitle>
          <DialogDescription>
            {row.attempt_dir ?? '尚无产物目录'} · tag {tag}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="部分通过">
            {row.partial_total ? `${row.partial_passed}/${row.partial_total}` : '—'}
          </Field>
          <Field label="总耗时">{formatDuration(row.wall_secs)}</Field>
          <Field label="轮次">{formatCount(row.rounds)}</Field>
          <Field label="工具调用">{formatCount(row.tool_calls)}</Field>
          <Field label="Prompt">{formatTokens(row.prompt_tokens)}</Field>
          <Field label="缓存">
            {row.cached_pct === null ? '—' : `${row.cached_pct.toFixed(0)}%`}
          </Field>
          <Field label="Output">{formatTokens(row.output_tokens)}</Field>
          <Field label="峰值上下文">{formatTokens(row.peak_ctx)}</Field>
        </div>

        {Object.keys(row.phases).length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground nums">
            {Object.entries(row.phases).map(([phase, secs]) => (
              <span key={phase}>
                {phase.replace('agent_', '')}: {formatDuration(secs)}
              </span>
            ))}
          </div>
        )}

        {row.exception && (
          <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
            <span className="font-medium">异常：</span>
            {row.exception}
          </div>
        )}

        {row.note && (
          <div className="text-xs text-muted-foreground">备注：{row.note}</div>
        )}

        {/* --- per-test verdicts ------------------------------------------- */}
        {allTests.length > 0 && (
          <>
            <Separator />
            <div className="min-w-0 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">测试明细</span>
                  <Badge variant="outline" size="sm">
                    {passCount} 通过
                  </Badge>
                  {failCount > 0 && (
                    <Badge variant="destructive" size="sm">
                      {failCount} 失败
                    </Badge>
                  )}
                </div>
                {failCount > 0 && (
                  <Button
                    variant={failedOnly ? 'secondary' : 'outline'}
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => {
                      setFailedOnly((v) => !v)
                      setTestLimit(TEST_PAGE)
                    }}
                  >
                    {failedOnly ? '显示全部' : '只看失败'}
                  </Button>
                )}
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2 no-scrollbar">
                {tests.slice(0, testLimit).map((test) => (
                  <TestRow key={test.name} test={test} />
                ))}
                {tests.length > testLimit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => setTestLimit((n) => n + TEST_PAGE)}
                  >
                    还有 {tests.length - testLimit} 条，显示更多
                  </Button>
                )}
              </div>
            </div>
          </>
        )}

        {/* --- raw harbor log (collapsed; it is long and rarely the point) -- */}
        <Separator />
        <div className="min-w-0 space-y-2">
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="flex w-full items-center gap-2 text-left"
          >
            {showLog ? (
              <ChevronDown className="size-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 text-muted-foreground" />
            )}
            <span className="text-xs font-medium">运行日志</span>
            <span className="text-xs text-muted-foreground">
              {log.length ? `尾部 ${log.length} 行` : '（日志为空）'}
            </span>
            {logError && (
              <span className="text-xs text-destructive">{logError}</span>
            )}
          </button>
          {showLog && (
            <pre className="max-h-72 overflow-y-auto rounded-md border bg-muted/40 p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all no-scrollbar">
              {log.length ? log.join('\n') : '（日志为空）'}
            </pre>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            关闭
          </Button>
          {row.running ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={pending !== null}
              onClick={() => void act('stop', () => api.cellStop(row.key))}
            >
              {pending === 'stop' ? <Loader2 className="animate-spin" /> : <Square />}
              停止该 cell
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={pending !== null}
              onClick={() =>
                void act('start', () => api.cellStart(row.agent, row.task, tag))
              }
            >
              {pending === 'start' ? <Loader2 className="animate-spin" /> : <Play />}
              单独重跑
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void act('refresh', async () => ({ ok: true }))}
          >
            {pending === 'refresh' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TestRow({ test }: { test: CellTest }) {
  const failed = test.status === 'failed'
  return (
    <div className="flex items-start gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent/40">
      {failed ? (
        <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
      )}
      <div className="min-w-0 flex-1">
        <div className={cn('break-all', !failed && 'text-muted-foreground')}>
          {test.name.replace(/^test_outputs\.py::/, '')}
        </div>
        {failed && test.trace && (
          <div className="mt-0.5 break-all text-[11px] text-destructive/80">
            {test.trace}
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium nums">{children}</div>
    </div>
  )
}
