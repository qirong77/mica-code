export type AgentId = string

export interface AgentMeta {
  id: AgentId
  label: string
  family: 'openai' | 'anthropic'
  blurb: string
}

export interface Settings {
  api_key: string
  api_base: string
  anthropic_base: string
  model: string
  agents: AgentId[]
  tasks: string[]
  parallelism: number
  proxy_port: number
  console_port: number
  stall_secs: number
  setup_secs: number
  verify_grace: number
  max_attempts: number
  min_free_mb: number
  upstream_routes: Record<string, { base: string; path_prefix: string }>
}

export interface ProxyStatus {
  running: boolean
  pid: number | null
  port: number
  events_path: string
  routes: Record<string, { base: string; path_prefix: string }>
  log: string
}

export interface RunningCell {
  key: string
  agent: string
  task: string
  pid: number | null
  pid_alive: boolean
  attempt: number
  started_at: number
  age_secs: number
  log: string
  stop_reason: string | null
  heartbeat_age_secs: number | null
}

export interface RunState {
  tag: string
  parallelism: number
  agents: AgentId[]
  tasks: string[]
  started_at: number
  active: boolean
  scheduler_alive: boolean
  cells: Record<string, RunningCell>
}

export interface LogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface StatePayload {
  settings: Settings
  proxy: ProxyStatus
  run: RunState | null
  agents: AgentMeta[]
  all_tasks: string[]
  task_catalog: TaskMeta[]
  runs: string[]
  disk_free_mb: number | null
  log: LogEntry[]
  server_started_at: number
}

export type CellState =
  | 'pending'
  | 'running'
  | 'pass'
  | 'fail'
  | 'timeout'
  | 'exception'
  | 'stalled'

export interface CellRow {
  agent: string
  task: string
  key: string
  state: CellState
  done: boolean
  reward: number | null
  partial_passed: number | null
  partial_total: number | null
  wall_secs: number | null
  phases: Record<string, number>
  exception: string | null
  note: string | null
  running: boolean
  pid: number | null
  heartbeat_age_secs: number | null
  rounds: number
  prompt_tokens: number
  cached_tokens: number
  output_tokens: number
  reasoning_tokens: number
  tool_calls: number
  peak_ctx: number
  errors: number
  probes: number
  cached_pct: number | null
  last_request_at: number | null
  last_request_age_secs: number | null
  started_at: number | null
  finished_at: number | null
  attempt_dir: string | null
  tests: CellTest[]
}

export interface CellTest {
  name: string
  status: string
  trace: string
}

export interface TaskMeta {
  name: string
  category: string
  group: string
  subcategory: string
  tags: string[]
}

export interface AgentTotals {
  agent: string
  cells: number
  done: number
  pass: number
  fail: number
  timeout: number
  exception: number
  stalled: number
  rounds: number
  prompt_tokens: number
  cached_tokens: number
  output_tokens: number
  reasoning_tokens: number
  tool_calls: number
  errors: number
  partial_passed: number
  partial_total: number
  mean_wall_secs: number | null
}

export interface ResultsPayload {
  tag: string
  generated_at: number
  agents: AgentId[]
  tasks: string[]
  task_catalog: TaskMeta[]
  now: number
  matrix: CellRow[]
  by_agent: AgentTotals[]
  totals: Record<string, number>
  progress: {
    total: number
    done: number
    running: number
    pending: number
    stalled: number
    pass: number
    fail: number
    timeout: number
    exception: number
    mean_wall_secs: number | null
  }
}

export interface EventRow {
  ts: number
  agent: string
  task: string | null
  seq: number
  method: string
  upstream_path: string
  model?: string
  mode?: string
  stream?: boolean
  input_count?: number
  tool_calls?: number
  tool_names?: string[]
  status?: number
  resp_bytes?: number
  duration_ms?: number
  ttfb_ms?: number
  usage?: {
    input: number | null
    cached: number | null
    output: number | null
    reasoning: number | null
    total: number | null
  } | null
  finish?: string
  error_body?: string
  proxy_error?: string
}
