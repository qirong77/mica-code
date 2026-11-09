export const PERIOD = {
  start: '2026-10-06',
  end: '2026-11-04',
  label: '2026.10.06 — 2026.11.04',
  calendarStart: '2025-11-05'
}

export const TOTALS = {
  sessions: 24,
  requests: 1286,
  tokens: 48_600_000,
  cacheRate: 91.4,
  cached: 42_000_000,
  uncached: 3_950_000,
  output: 2_650_000,
  topModel: 'gpt-6.1'
}

export const METRICS = [
  { key: 'sessions', label: '活跃会话', value: TOTALS.sessions, note: '有模型用量的会话' },
  { key: 'requests', label: '模型请求', value: TOTALS.requests, note: '包含主对话与后台请求' },
  { key: 'tokens', label: '处理 Tokens', value: 48.6, precision: 1, suffix: 'M', note: '输入与输出合计' },
  { key: 'cacheRate', label: '缓存命中率', value: TOTALS.cacheRate, precision: 1, suffix: '%', note: '缓存输入 / 全部输入' },
  { key: 'cached', label: '缓存输入', value: 42, suffix: 'M' },
  { key: 'uncached', label: '未缓存输入', value: 3.95, precision: 2, suffix: 'M' },
  { key: 'output', label: '输出 Tokens', value: 2.65, precision: 2, suffix: 'M' },
  { key: 'topModel', label: '主要模型', value: TOTALS.topModel }
]

export const MODELS = [
  { id: 'gpt-6.1', label: 'gpt-6.1', provider: 'openai', tokens: 31_800_000, requests: 812 },
  { id: 'claude-sonnet-4.6', label: 'claude-sonnet-4.6', provider: 'anthropic', tokens: 11_400_000, requests: 322 },
  { id: 'gemini-3.1-pro', label: 'gemini-3.1-pro', provider: 'google', tokens: 5_400_000, requests: 152 }
]

export const SOURCES = [
  { id: 'main', label: '主对话', type: '对话', kind: 'main', tokens: 32_700_000, requests: 875 },
  { id: 'subagent', label: 'subagent', type: '插件', kind: 'delegation', tokens: 11_200_000, requests: 302 },
  { id: 'btw', label: 'By The Way', type: '插件', kind: 'plugin', tokens: 3_600_000, requests: 82 },
  { id: 'kernel', label: '内核', type: '内核', kind: 'helper', tokens: 1_100_000, requests: 27 }
]

export const PROJECTS = [
  { id: 'mica-code', label: 'mica-code', sessions: 8, tokens: 27_400_000, requests: 772, parts: [18_200_000, 7_300_000, 1_400_000, 500_000] },
  { id: 'web-console', label: 'web-console', sessions: 5, tokens: 10_000_000, requests: 258, parts: [7_000_000, 2_000_000, 700_000, 300_000] },
  { id: 'agent-lab', label: 'agent-lab', sessions: 5, tokens: 7_000_000, requests: 162, parts: [4_700_000, 1_100_000, 1_000_000, 200_000] },
  { id: 'sandbox', label: 'sandbox', sessions: 6, tokens: 4_200_000, requests: 94, parts: [2_800_000, 800_000, 500_000, 100_000] }
]

export const SPEED = {
  responseWait: [
    { provider: 'google', model: 'gemini-3.1-pro', value: 0.78, samples: 126 },
    { provider: 'openai', model: 'gpt-6.1', value: 1.12, samples: 726 },
    { provider: 'anthropic', model: 'claude-sonnet-4.6', value: 1.46, samples: 284 }
  ],
  generation: [
    { provider: 'openai', model: 'gpt-6.1', value: 82.4, samples: 416 },
    { provider: 'google', model: 'gemini-3.1-pro', value: 68.1, samples: 92 },
    { provider: 'anthropic', model: 'claude-sonnet-4.6', value: 57.6, samples: 198 }
  ]
}

const titles = [
  'Stats 卡片对照', '设置控件适配', '输入区交互检查', '会话列表整理',
  '工具栏排版', '主题样式核对', '快捷动作预览', '统计图表检查',
  '工作台筛选', '详情页表格', '导航结构讨论', '权限状态展示', '搜索空态',
  '请求队列研究', '模型输出检查', '上下文策略', '重试行为分析', '耗时记录',
  '表单验证练习', '布局试验', '代码片段整理', '样式变量检查', '文档草稿', '测试用例补充'
]
const sessionTokenUnits = [64, 53, 42, 35, 28, 22, 17, 13, 30, 24, 20, 15, 11, 22, 17, 13, 10, 8, 12, 9, 7, 6, 5, 3]
const sessionRequests = [143, 122, 110, 94, 85, 76, 74, 68, 62, 55, 52, 46, 43, 39, 36, 32, 29, 26, 23, 20, 16, 12, 8, 15]

export const SESSIONS = titles.map((label, index) => ({
  id: `example-session-${index + 1}`,
  label,
  project: PROJECTS[index < 8 ? 0 : index < 13 ? 1 : index < 18 ? 2 : 3].label,
  model: MODELS[index % MODELS.length].label,
  requests: sessionRequests[index],
  tokens: sessionTokenUnits[index] * 100_000,
  updated: `2026-11-${String(4 - Math.floor(index / 6)).padStart(2, '0')} ${String(18 - (index % 6)).padStart(2, '0')}:24`
}))

const periodTokenUnits = [12, 18, 0, 15, 22, 14, 20, 11, 17, 0, 25, 19, 13, 21, 16, 18, 23, 0, 15, 14, 20, 24, 13, 19, 16, 21, 0, 18, 20, 42]
const historyPattern = [4, 2, 0, 3, 5, 1, 0, 2, 4, 3, 1, 0, 5, 2, 3, 1, 0, 4]

export const ACTIVITY = Array.from({ length: 365 }, (_, index) => {
  const day = new Date(Date.UTC(2025, 10, 5 + index)).toISOString().slice(0, 10)
  const periodIndex = index - 335
  const units = periodIndex >= 0 ? periodTokenUnits[periodIndex] : historyPattern[index % historyPattern.length]
  return {
    day,
    tokens: units * 100_000,
    requests: units > 0 ? (periodIndex >= 0 ? units * 2 + 12 + (periodIndex === 0 ? 2 : 0) : units * 3 + 4) : 0,
    sessions: units > 0 ? Math.min(12, Math.ceil(units / 3)) : 0
  }
})
