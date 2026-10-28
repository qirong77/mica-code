import { createRoot } from 'react-dom/client'
import '../src/renderer/assets/app.css'
import { SessionSettingsDialog } from '../src/renderer/src/SessionSettingsDialog'

/**
 * 临时探针：真实组件 + 假 host。
 * 只为了看「会话设置 → 插件」这一节的版式，跑完即删。
 */
const AUTO_COMPACT_FIELDS = [
  {
    key: 'enabled',
    label: '启用自动压缩',
    type: 'switch',
    description: '关掉之后只在手动 /compact 时压缩。'
  },
  {
    key: 'quickThresholdK',
    label: '快速压缩阈值',
    type: 'number',
    unit: 'k tokens',
    description: '上下文超过这个量就先做本地清理（把工具结果与参数正文换成占位符），不调用模型。'
  },
  {
    key: 'quickLimit',
    label: '快速压缩次数',
    type: 'number',
    unit: '次',
    description: '一条会话最多做几次快速压缩，0 表示不做这一类。'
  },
  {
    key: 'modelThresholdK',
    label: '模型压缩阈值',
    type: 'number',
    unit: 'k tokens',
    description: '本地清理之后仍超过这个量，才花一次模型请求做摘要。'
  },
  {
    key: 'modelLimit',
    label: '模型压缩次数',
    type: 'number',
    unit: '次',
    description: '一条会话最多做几次模型压缩，0 表示不做这一类。'
  },
  {
    key: 'minIntervalMinutes',
    label: '两次压缩的最小间隔',
    type: 'number',
    unit: '分钟',
    description: '免得同一段上下文被反复触发；0 表示不限制。'
  }
]

const MEMORY_FIELDS = [
  {
    key: 'autoCapture',
    label: '自动整理',
    type: 'switch',
    description: '每轮成功结束后把对话收敛成记忆操作。'
  },
  {
    key: 'curatorMode',
    label: '整理方式',
    type: 'select',
    options: [
      { value: 'subagent', label: '复用主对话的子代理' },
      { value: 'direct', label: '独立接口（用下面的模型接口）' }
    ],
    description: '子代理复用当前主对话的模型配置；独立接口可以换成更便宜的模型。'
  }
]

const PLUGINS = [
  {
    id: 'auto-compact',
    name: 'Auto Compact',
    description: '每次模型请求前检查上下文占用，超过阈值先做本地清理，仍超阈值再做模型摘要。',
    fields: AUTO_COMPACT_FIELDS,
    values: {
      enabled: 'true',
      quickThresholdK: '300',
      quickLimit: '999',
      modelThresholdK: '200',
      modelLimit: '999',
      minIntervalMinutes: '30'
    },
    overrides: {}
  },
  {
    id: 'memory',
    name: 'Memory',
    description: '跨会话记忆：自动把对话收敛成记忆条目，下一轮带进 system prompt。',
    fields: MEMORY_FIELDS,
    values: { autoCapture: 'true', curatorMode: 'subagent' },
    overrides: { autoCapture: 'false' }
  }
]

const TOOLS = ['read_file', 'write_file', 'run_shell', 'grep_search'].map((name) => ({
  name,
  description: '示例工具',
  readOnly: name !== 'write_file'
}))

window.mica = {
  chat: {
    capabilities: async () => ({
      ok: true,
      tools: TOOLS,
      skills: [],
      mcpServers: [],
      selection: { version: 1, disabledTools: [], disabledSkills: [], disabledMcpServers: [] }
    }),
    setCapabilities: async (_nodeId, next) => ({ ok: true, selection: next }),
    pluginSettings: async () => ({ ok: true, plugins: PLUGINS }),
    setPluginSettings: async (_nodeId, params) => {
      const plugin = PLUGINS.find((entry) => entry.id === params.pluginId)
      for (const [key, value] of Object.entries(params.values || {})) {
        if (value === null) delete plugin.overrides[key]
        else plugin.overrides[key] = value
      }
      return { ok: true, plugins: PLUGINS }
    }
  }
}

createRoot(document.getElementById('root')).render(
  <SessionSettingsDialog
    nodeId="node-1"
    sessionId="session-1"
    cwd="/tmp"
    running={false}
    section="plugins"
    onClose={() => {}}
  />
)
