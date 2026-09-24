import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CellDrawer } from './components/CellDrawer'
import { ControlPanel } from './components/ControlPanel'
import { LiveFeed } from './components/LiveFeed'
import { Matrix } from './components/Matrix'
import { ProgressPanel } from './components/ProgressPanel'
import { TotalsTable } from './components/TotalsTable'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Separator } from './components/ui/separator'
import { api } from './lib/api'
import { formatAgo } from './lib/format'
import type { ResultsPayload, StatePayload } from './lib/types'

const REFRESH_MS = 4000

export default function App() {
  const [state, setState] = useState<StatePayload | null>(null)
  const [results, setResults] = useState<ResultsPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [tag, setTag] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const busyRef = useRef(false)
  /** Coalesced request queued while another fetch is in flight. */
  const queuedRef = useRef<{ nextTag?: string; nextTasks?: string[] } | null>(null)
  const refreshRef = useRef<((nextTag?: string, nextTasks?: string[]) => void) | null>(null)
  // The task selection drives the matrix columns, so it lives here rather than
  // inside ControlPanel.  The ref lets `refresh` read the latest value without
  // being rebuilt (and re-firing) on every click.
  const [selectedTasks, setSelectedTasks] = useState<string[]>([])
  const selectedTasksRef = useRef<string[]>([])
  const serverTasksKey = useRef<string | null>(null)

  useEffect(() => {
    const server = state?.settings?.tasks
    if (!server?.length) return
    const key = server.join('\u0000')
    if (key === serverTasksKey.current) return
    serverTasksKey.current = key
    setSelectedTasks(server)
    selectedTasksRef.current = server
  }, [state?.settings?.tasks])

  const refresh = useCallback(
    async (nextTag?: string, nextTasks?: string[]) => {
      if (busyRef.current) {
        // Remember the newest intent and replay it when the in-flight fetch
        // settles.  Dropping it silently leaves the matrix on stale columns
        // whenever a click lands during the 4 s poll.
        queuedRef.current = { nextTag, nextTasks }
        return
      }
      busyRef.current = true
      try {
        const nextState = await api.state()
        setState(nextState)
        const resolvedTag = nextTag ?? tag
        const tasks = nextTasks ?? selectedTasksRef.current
        // Send `tasks` once a selection exists (or was explicitly cleared), but
        // not on the very first load, where an empty list just means "not yet
        // initialised" and the server should apply the saved default.
        const hasSelection = nextTasks !== undefined || tasks.length > 0
        const nextResults = await api.results({
          ...(resolvedTag ? { tag: resolvedTag } : {}),
          ...(hasSelection ? { tasks } : {}),
        })
        setResults(nextResults)
        if (!nextTag) setTag(nextResults.tag)
        setError(null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        busyRef.current = false
        const queued = queuedRef.current
        if (queued) {
          queuedRef.current = null
          refreshRef.current?.(queued.nextTag, queued.nextTasks)
        }
      }
    },
    [tag],
  )

  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  /** Selection changes must re-fetch immediately: the matrix is the feedback. */
  const handleTasksChange = useCallback(
    (next: string[]) => {
      setSelectedTasks(next)
      selectedTasksRef.current = next
      void refresh(undefined, next)
    },
    [refresh],
  )

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => setTick((n) => n + 1), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [live])

  useEffect(() => {
    if (tick > 0) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  const progress = results?.progress
  const settings = state?.settings

  const selectedRow = useMemo(
    () => results?.matrix.find((row) => row.key === selected) ?? null,
    [results, selected],
  )

  const run = state?.run
  const isRunning = Boolean(run?.active || run?.scheduler_alive)

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Mica Bench</h1>
          <span className="text-xs text-muted-foreground">
            agent harness 对比测评控制台
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={tag ?? ''}
            onChange={(event) => {
              const next = event.target.value
              setTag(next)
              void refresh(next)
            }}
            className="h-8 max-w-[200px] rounded-md border border-input bg-background px-2 text-sm shadow-sm"
          >
            {(state?.runs ?? []).map((name) => (
              <option key={name} value={name} className="bg-background">
                {name}
              </option>
            ))}
          </select>

          {state?.proxy.running ? (
            <Badge size="md" variant="success">
              代理 :{state.proxy.port}
            </Badge>
          ) : (
            <Badge size="md" variant="muted">
              代理未启动
            </Badge>
          )}

          <Badge size="md" variant={isRunning ? 'default' : 'muted'}>
            {isRunning ? '调度中' : '空闲'}
          </Badge>

          {state?.disk_free_mb != null && (
            <Badge size="md" variant={state.disk_free_mb < 12000 ? 'warning' : 'outline'}>
              磁盘 {(state.disk_free_mb / 1024).toFixed(0)}G
            </Badge>
          )}

          <Button
            variant={live ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setLive((value) => !value)}
          >
            {live ? '自动刷新' : '已暂停'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            刷新
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm">
          <span className="font-medium">无法连接控制面：</span> {error}
          <div className="mt-1 text-xs text-muted-foreground">
            启动后端：<code>cd ~/mica-bench/console &amp;&amp; python3 -m server.main</code>
          </div>
        </div>
      )}

      {settings && (
        <ControlPanel
          settings={settings}
          agents={state?.agents ?? []}
          allTasks={state?.all_tasks ?? []}
          taskCatalog={state?.task_catalog ?? []}
          proxy={state?.proxy ?? null}
          run={run ?? null}
          selectedTasks={selectedTasks}
          onTasksChange={handleTasksChange}
          onChanged={() => void refresh()}
        />
      )}

      {progress && (
        <ProgressPanel
          progress={progress}
          byAgent={results?.by_agent ?? []}
          agents={state?.agents ?? []}
          run={run ?? null}
          meanWall={progress.mean_wall_secs}
        />
      )}

      {results && state && (
        <Matrix
          results={results}
          agents={state.agents}
          onSelect={setSelected}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {results && state && (
          <TotalsTable
            byAgent={results.by_agent}
            agents={state.agents}
            totals={results.totals}
          />
        )}
        <LiveFeed eventsPath={state?.proxy.events_path} />
      </div>

      <Separator />

      <footer className="flex flex-wrap items-center justify-between gap-2 pb-4 text-xs text-muted-foreground">
        <span>
          数值口径：token / 轮次一律来自本地代理 <code>events.jsonl</code>，不采用 agent 自报。
        </span>
        <span className="nums">
          {results
            ? `tag ${results.tag} · 快照 ${formatAgo((Date.now() / 1000) - results.generated_at)}`
            : '—'}
        </span>
      </footer>

      <CellDrawer
        row={selectedRow}
        tag={results?.tag ?? 'run'}
        onClose={() => setSelected(null)}
        onChanged={() => void refresh()}
      />
    </div>
  )
}
