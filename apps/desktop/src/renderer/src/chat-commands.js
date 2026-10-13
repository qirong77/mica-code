/**
 * 分享链接（share 范围）里不可用的 chat 命令。
 *
 * 判定依据是「服务端 share 白名单里有没有它需要的那条 channel」，不是「看着像不该有」：
 * - `new` / `clear`：新建的会话不属于这个令牌，`chat:start` 会被拒（分享只授一个会话）
 * - `resume`：同理，只能打开被分享的那一个会话，等于撤销输入
 * - `config`：设置页走 `config-web:invoke`（含 API key），不在白名单
 * - `role`：角色是会话级持久化的，改它等于改分享者的会话快照
 *
 * 这里只是「不给入口」；真正的授权在 `host/access-core.js` 的 channel 白名单与
 * `SHARE_LOCKED_PARAMS`。两边要一起维护，别只改这里。
 */
export const SHARE_BLOCKED_COMMANDS = ['new', 'clear', 'resume', 'config', 'role']

export function commandBlockedInShare(name) {
  return SHARE_BLOCKED_COMMANDS.includes(String(name || '').toLowerCase())
}

export const CHAT_COMMANDS = [
  {
    name: 'help',
    description: '查看 Chat 中可用的 Mica 命令',
    availability: 'chat'
  },
  {
    name: 'status',
    description: '查看当前模型、effort、role 与会话状态',
    availability: 'chat'
  },
  {
    name: 'context',
    description: '查看 token 与上下文占用',
    availability: 'chat'
  },
  {
    name: 'rename',
    description: '重命名当前会话',
    availability: 'chat',
    argument: '<title>'
  },
  {
    name: 'new',
    description: '新建一个 Web Chat 会话',
    availability: 'chat'
  },
  {
    name: 'clear',
    description: '保留当前记录并新建空会话',
    availability: 'chat'
  },
  {
    name: 'resume',
    description: '按 ID 或完整标题打开历史会话',
    availability: 'chat',
    argument: '<session>'
  },
  {
    name: 'todo',
    description: '显示或隐藏当前运行计划',
    availability: 'chat',
    argument: '[show|hide]'
  },
  {
    name: 'config',
    description: '打开 Mica 配置',
    availability: 'chat'
  },
  {
    name: 'role',
    description: '切换系统角色',
    availability: 'chat',
    argument: '[name]'
  },
  {
    name: 'compact',
    description: '压缩当前会话上下文',
    availability: 'chat',
    argument: '[--force]'
  },
  {
    name: 'rewind',
    description: '回退对话与文件 checkpoint',
    availability: 'terminal'
  },
  {
    name: 'task',
    description: '查看 agent、subagent 与后台 shell',
    availability: 'terminal'
  },
  {
    name: 'skills',
    description: '浏览已安装的 skills',
    availability: 'terminal'
  },
  {
    name: 'mcp',
    description: '浏览或重连 MCP server',
    availability: 'terminal'
  },
  {
    name: 'diff',
    description: '查看本轮文件变化',
    availability: 'terminal'
  },
  {
    name: 'commit',
    description: '分析、提交并推送当前变化',
    availability: 'terminal'
  },
  {
    name: 'fork',
    description: '从当前上下文分叉 agent',
    availability: 'terminal'
  }
]

export function parseSlashCommand(value) {
  const text = String(value || '').trim()
  if (!text.startsWith('/')) return null
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return { name: '', args: '', raw: text }
  return {
    name: match[1].toLowerCase(),
    args: (match[2] || '').trim(),
    raw: text
  }
}

export function commandSuggestions(value, commands = CHAT_COMMANDS, { shareMode = false } = {}) {
  const text = String(value || '')
  if (!text.startsWith('/') || /\s/.test(text)) return []
  const query = text.slice(1).toLowerCase()
  const rank = (command) => {
    if (!query) return 0
    if (command.name.startsWith(query)) return 0
    if (command.name.includes(query)) return 1
    if (command.description.toLowerCase().includes(query)) return 2
    return 3
  }
  return commands
    .filter((command) => !(shareMode && commandBlockedInShare(command.name)))
    .map((command) => ({ command, rank: rank(command) }))
    .filter((entry) => entry.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.command.name.localeCompare(b.command.name))
    .slice(0, 9)
    .map((entry) => entry.command)
}

export function commandInputValue(command) {
  return `/${command.name}${command.argument ? ' ' : ''}`
}

export function findChatCommand(name) {
  return CHAT_COMMANDS.find((command) => command.name === String(name || '').toLowerCase()) || null
}
