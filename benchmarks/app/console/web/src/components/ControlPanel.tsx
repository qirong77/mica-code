import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  Save,
  Square,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Badge } from './ui/badge'
import { Button } from './ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './ui/card'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { api } from '@/lib/api'
import { groupTasks, groupsWithSelection } from '@/lib/tasks'
import type {
  AgentMeta,
  ProxyStatus,
  RunState,
  Settings,
  TaskMeta,
} from '@/lib/types'
import { cn } from '@/lib/utils'

interface Props {
  settings: Settings
  agents: AgentMeta[]
  allTasks: string[]
  taskCatalog: TaskMeta[]
  proxy: ProxyStatus | null
  run: RunState | null
  /** Selected tasks live in App so the matrix columns follow them live. */
  selectedTasks: string[]
  onTasksChange: (tasks: string[]) => void
  onChanged: () => void
}

function defaultTag(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `run-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

export function ControlPanel({
  settings,
  agents,
  allTasks,
  taskCatalog,
  proxy,
  run,
  selectedTasks,
  onTasksChange,
  onChanged,
}: Props) {
  const [draft, setDraft] = useState<Settings>(settings)
  const [newTag, setNewTag] = useState(defaultTag())
  const [parallelism, setParallelism] = useState(settings.parallelism)
  const [selectedAgents, setSelectedAgents] = useState<string[]>(settings.agents)
  const [expandedGroups, setExpandedGroups] = useState<string[]>([])
  const [pending, setPending] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // Re-sync only when the server actually changed something, so typing in a
  // field is not clobbered by the 4 s refresh.
  useEffect(() => setDraft(settings), [settings.api_key, settings.api_base, settings.anthropic_base, settings.model, settings.parallelism, settings.agents, settings.tasks, settings.proxy_port])

  // `settings` arrives as a fresh object every 4 s, so an effect keyed on the
  // array would reset the user's selection on each poll.  Compare the joined
  // value and only adopt genuine server-side changes.
  const serverAgentsKey = useRef(settings.agents.join('\u0000'))
  useEffect(() => {
    const key = settings.agents.join('\u0000')
    if (key === serverAgentsKey.current) return
    serverAgentsKey.current = key
    setSelectedAgents(settings.agents)
  }, [settings.agents])

  // Expand the categories that already hold a selected task, once, when the
  // catalogue first arrives.  Doing this on every selection change would fight
  // the user's own collapse clicks.
  const [didInitGroups, setDidInitGroups] = useState(false)
  useEffect(() => {
    if (didInitGroups || !taskCatalog.length) return
    setExpandedGroups(groupsWithSelection(groupTasks(taskCatalog, allTasks), settings.tasks))
    setDidInitGroups(true)
  }, [didInitGroups, taskCatalog, allTasks, settings.tasks])

  const running = Boolean(run?.active || run?.scheduler_alive)
  const dirty = useMemo(
    () =>
      (['api_key', 'api_base', 'anthropic_base', 'model', 'proxy_port'] as const).some(
        (key) => draft[key] !== settings[key],
      ),
    [draft, settings],
  )

  async function guard(key: string, fn: () => Promise<{ ok?: boolean; error?: string }>) {
    setPending(key)
    setMessage(null)
    try {
      const result = await fn()
      if (result.ok === false) {
        setMessage({ kind: 'err', text: result.error ?? '操作失败' })
      }
      onChanged()
      return result
    } catch (cause) {
      setMessage({ kind: 'err', text: cause instanceof Error ? cause.message : String(cause) })
      return { ok: false }
    } finally {
      setPending(null)
    }
  }

  const toggleAgent = (id: string) =>
    setSelectedAgents((list) =>
      list.includes(id) ? list.filter((a) => a !== id) : [...list, id],
    )

  const toggleTask = (task: string) =>
    onTasksChange(
      selectedTasks.includes(task)
        ? selectedTasks.filter((t) => t !== task)
        : [...selectedTasks, task],
    )

  const taskGroups = useMemo(
    () => groupTasks(taskCatalog, allTasks.length ? allTasks : settings.tasks),
    [taskCatalog, allTasks, settings.tasks],
  )

  const toggleGroup = (name: string) =>
    setExpandedGroups((list) =>
      list.includes(name) ? list.filter((g) => g !== name) : [...list, name],
    )

  /** Select-all / clear every task under one category. */
  const setGroupSelected = (name: string, on: boolean) => {
    const members = taskGroups.find((g) => g.name === name)?.tasks ?? []
    const next = new Set(selectedTasks)
    for (const meta of members) {
      if (on) next.add(meta.name)
      else next.delete(meta.name)
    }
    // Keep the canonical task order rather than click order.
    onTasksChange((allTasks.length ? allTasks : settings.tasks).filter((t) => next.has(t)))
  }

  const cells = selectedAgents.length * selectedTasks.length

  return (
    <Card>
      <Tabs defaultValue="run">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <div className="space-y-1">
            <CardTitle className="text-sm">控制台</CardTitle>
            <CardDescription>
              运行 / 停止 / 模型与凭据，全部在这里改，不需要碰命令行。
            </CardDescription>
          </div>
          <TabsList>
            <TabsTrigger value="run">运行</TabsTrigger>
            <TabsTrigger value="config">配置</TabsTrigger>
          </TabsList>
        </CardHeader>

        <CardContent className="space-y-4">
          {message && (
            <div
              className={cn(
                'rounded-md border px-3 py-2 text-xs',
                message.kind === 'ok'
                  ? 'border-success/50 bg-success/10'
                  : 'border-destructive/50 bg-destructive/10',
              )}
            >
              {message.text}
            </div>
          )}

          <TabsContent value="run" className="mt-0 space-y-5">
            {/* --- matrix selection -------------------------------- */}
            <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>Agent</Label>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {agents.map((agent) => {
                      const active = selectedAgents.includes(agent.id)
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          onClick={() => toggleAgent(agent.id)}
                          className={cn(
                            'flex w-full flex-col gap-1 rounded-md border px-3 py-2.5 text-left text-sm transition-colors',
                            active
                              ? 'border-primary bg-primary/5 ring-1 ring-primary'
                              : 'border-input bg-background hover:bg-accent',
                          )}
                        >
                          <span className="flex w-full items-center justify-between gap-2">
                            <span className="truncate font-medium">{agent.label}</span>
                            <Badge
                              variant={agent.family === 'anthropic' ? 'warning' : 'secondary'}
                            >
                              {agent.family === 'anthropic' ? '/anthropic' : '/v1'}
                            </Badge>
                          </span>
                          <span className="line-clamp-2 text-xs text-muted-foreground">
                            {agent.blurb}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>
                        任务（{selectedTasks.length}/{allTasks.length || settings.tasks.length}）
                      </Label>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        选中的任务即下方矩阵的列；每个 agent 各跑这些列
                      </p>
                    </div>
                    <div className="flex gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-w-[72px]"
                        onClick={() => onTasksChange(allTasks)}
                      >
                        全选
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-w-[72px]"
                        onClick={() => onTasksChange(settings.tasks)}
                      >
                        默认集
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-w-[72px]"
                        onClick={() => onTasksChange([])}
                      >
                        清空
                      </Button>
                    </div>
                  </div>
                  <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border bg-background p-2 no-scrollbar">
                      {taskGroups.map((group) => {
                        const expanded = expandedGroups.includes(group.name)
                        const picked = group.tasks.filter((t) =>
                          selectedTasks.includes(t.name),
                        ).length
                        return (
                          <div key={group.name} className="rounded-md">
                            <div className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent/50">
                              <button
                                type="button"
                                onClick={() => toggleGroup(group.name)}
                                className="flex flex-1 items-center gap-2 text-left"
                                aria-expanded={expanded}
                              >
                                {expanded ? (
                                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                                )}
                                <span className="text-xs font-medium">
                                  {group.name}
                                </span>
                                <Badge
                                  variant={picked ? 'default' : 'outline'}
                                  size="sm"
                                >
                                  {picked}/{group.tasks.length}
                                </Badge>
                              </button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={() =>
                                  setGroupSelected(
                                    group.name,
                                    picked !== group.tasks.length,
                                  )
                                }
                              >
                                {picked === group.tasks.length ? '清空' : '全选'}
                              </Button>
                            </div>
                            {expanded && (
                              <div className="flex flex-wrap gap-1.5 py-1.5 pl-6">
                                {group.tasks.map((meta) => {
                                  const active = selectedTasks.includes(meta.name)
                                  return (
                                    <button
                                      key={meta.name}
                                      type="button"
                                      onClick={() => toggleTask(meta.name)}
                                      title={
                                        meta.subcategory
                                          ? `${meta.name} · ${meta.subcategory}`
                                          : meta.name
                                      }
                                      className={cn(
                                        'rounded-md border px-2 py-1 text-xs transition-colors',
                                        active
                                          ? 'border-primary bg-primary text-primary-foreground'
                                          : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
                                      )}
                                    >
                                      {meta.name}
                                    </button>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )
                      })}
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="tag">运行标识 (tag)</Label>
                  <Input
                    id="tag"
                    value={newTag}
                    onChange={(event) => setNewTag(event.target.value)}
                    placeholder="run-0924-1200"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="parallelism">并发 cell 数</Label>
                  <Input
                    id="parallelism"
                    type="number"
                    min={1}
                    max={16}
                    value={parallelism}
                    onChange={(event) => setParallelism(Number(event.target.value))}
                  />
                  <p className="text-xs text-muted-foreground">
                    每个 agent 上限 {Math.max(1, Math.ceil(parallelism / Math.max(1, selectedAgents.length)))} 个，
                    本次共 <span className="font-medium text-foreground">{cells}</span> 个 cell。
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <Button
                    className="w-full"
                    disabled={running || !cells || pending !== null}
                    onClick={() =>
                      void guard('run', () =>
                        api.runStart({
                          tag: newTag,
                          parallelism,
                          agents: selectedAgents,
                          tasks: selectedTasks,
                        }),
                      )
                    }
                  >
                    {pending === 'run' ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Play />
                    )}
                    开始运行
                  </Button>
                  <Button
                    className="w-full"
                    variant="destructive"
                    disabled={!running || pending !== null}
                    onClick={() => void guard('stop', () => api.runStop(false))}
                  >
                    {pending === 'stop' ? <Loader2 className="animate-spin" /> : <Square />}
                    全部停止
                  </Button>
                </div>

                {running && run && (
                  <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
                    <div className="font-medium">正在运行：{run.tag}</div>
                    <div className="text-muted-foreground">
                      {Object.keys(run.cells).length} 个 cell 在执行 · 并发 {run.parallelism}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* --- proxy ------------------------------------------- */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  记录代理
                  {proxy?.running ? (
                    <Badge variant="success">
                      {proxy.pid ? `运行中 · pid ${proxy.pid}` : '运行中 · 已存在的进程'}
                    </Badge>
                  ) : (
                    <Badge variant="muted">未启动</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  :{settings.proxy_port} → {draft.api_base}
                  {proxy?.routes?.['claude-code'] && (
                    <> · claude-code → {draft.anthropic_base}</>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  className="min-w-[92px]"
                  variant="outline"
                  size="sm"
                  disabled={proxy?.running || pending !== null}
                  onClick={() => void guard('proxy', () => api.proxyStart())}
                >
                  启动代理
                </Button>
                <Button
                  className="min-w-[92px]"
                  variant="outline"
                  size="sm"
                  disabled={!proxy?.running || pending !== null}
                  onClick={() => void guard('proxy', () => api.proxyStop())}
                >
                  停止代理
                </Button>
              </div>
            </div>
          </TabsContent>

          {/* --- configuration ------------------------------------- */}
          <TabsContent value="config" className="mt-0 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="api_key">API Key</Label>
                <Input
                  id="api_key"
                  type="password"
                  value={draft.api_key}
                  onChange={(event) => setDraft({ ...draft, api_key: event.target.value })}
                  placeholder="sk-..."
                />
                <p className="text-xs text-muted-foreground">
                  所有 agent 都经本地代理转发，密钥只由代理持有。
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="api_base">OpenAI 兼容端点</Label>
                <Input
                  id="api_base"
                  value={draft.api_base}
                  onChange={(event) => setDraft({ ...draft, api_base: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">mica / codex 走这里。</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="anthropic_base">Anthropic 端点</Label>
                <Input
                  id="anthropic_base"
                  value={draft.anthropic_base}
                  onChange={(event) =>
                    setDraft({ ...draft, anthropic_base: event.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">claude-code 走这里（/anthropic）。</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="model">模型名</Label>
                <Input
                  id="model"
                  value={draft.model}
                  onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  两个端点都用同一个名字（实测 <code>deepseek-flash</code>）。
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="proxy_port">代理端口</Label>
                <Input
                  id="proxy_port"
                  type="number"
                  value={draft.proxy_port}
                  onChange={(event) =>
                    setDraft({ ...draft, proxy_port: Number(event.target.value) })
                  }
                />
                <p className="text-xs text-muted-foreground">改端口后需重启代理。</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              <Button
                className="min-w-[120px]"
                disabled={!dirty || pending !== null}
                onClick={() =>
                  void guard('save', async () => {
                    const result = await api.saveSettings({
                      api_key: draft.api_key,
                      api_base: draft.api_base,
                      anthropic_base: draft.anthropic_base,
                      model: draft.model,
                      proxy_port: draft.proxy_port,
                      parallelism,
                      agents: selectedAgents,
                      tasks: selectedTasks,
                    })
                    setMessage({ kind: 'ok', text: '已保存，代理路由同步更新。' })
                    return result
                  })
                }
              >
                {pending === 'save' ? <Loader2 className="animate-spin" /> : <Save />}
                保存配置
              </Button>
              <span className={cn('text-xs', dirty ? 'text-warning' : 'text-muted-foreground')}>
                {dirty ? '有未保存的修改' : '配置已保存'}
              </span>
            </div>
          </TabsContent>
        </CardContent>
      </Tabs>
    </Card>
  )
}
