import type {
  EventRow,
  ResultsPayload,
  Settings,
  StatePayload,
} from './types'

// The page is served by the same python process that owns the API, so every
// call is same-origin.  In dev, vite proxies /api to it (see vite.config.ts).
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`bad response from ${path}: ${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : response.statusText
    throw new Error(message)
  }
  return body as T
}

export const api = {
  state: () => request<StatePayload>('/api/state'),

  results: (params: { tag?: string; agents?: string[]; tasks?: string[] }) => {
    const search = new URLSearchParams()
    if (params.tag) search.set('tag', params.tag)
    if (params.agents?.length) search.set('agents', params.agents.join(','))
    // An empty array is sent as `tasks=` on purpose: the backend reads a present
    // but empty value as "none selected" rather than "use the saved default".
    if (params.tasks) search.set('tasks', params.tasks.join(','))
    const qs = search.toString()
    return request<ResultsPayload>(`/api/results${qs ? `?${qs}` : ''}`)
  },

  saveSettings: (patch: Partial<Settings>) =>
    request<{ ok: boolean; settings: Settings }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),

  proxyStart: () =>
    request<{ ok: boolean; pid?: number; error?: string }>('/api/proxy/start', {
      method: 'POST',
    }),
  proxyStop: () => request<{ ok: boolean }>('/api/proxy/stop', { method: 'POST' }),

  runStart: (body: {
    tag: string
    parallelism: number
    agents: string[]
    tasks: string[]
  }) =>
    request<{ ok: boolean; tag?: string; error?: string }>('/api/run/start', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  runStop: (stopProxy = false) =>
    request<{ ok: boolean; stopped?: number }>('/api/run/stop', {
      method: 'POST',
      body: JSON.stringify({ stop_proxy: stopProxy }),
    }),

  cellStart: (agent: string, task: string, tag: string) =>
    request<{ ok: boolean; error?: string }>('/api/cell/start', {
      method: 'POST',
      body: JSON.stringify({ agent, task, tag }),
    }),
  cellStop: (key: string) =>
    request<{ ok: boolean; error?: string }>('/api/cell/stop', {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),

  log: (key: string, tail = 300) =>
    request<{ ok: boolean; path?: string; lines?: string[]; error?: string }>(
      `/api/log?key=${encodeURIComponent(key)}&tail=${tail}`,
    ),

  events: (limit = 60) => request<{ rows: EventRow[] }>(`/api/events?limit=${limit}`),
}
