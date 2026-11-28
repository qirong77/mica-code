/**
 * 会话文件的读取层：路径约定、配置快照、历史与元信息。
 *
 * 桌面运行时（chat.js）与同端口 HTTP 服务（server/index.js）都从这里读会话，不各自拼
 * 路径或解析 JSON。这里只读，不持有 run 状态；写入、fork 与租约判定留在调用方。
 */
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { resolveDefaultChatMeta } from './chat-meta'
import { resolveModelProtocol, resolveProviderProtocol } from './chat-protocol'
import { readTopLevelCwd } from './session-file-head'

export function normalizedTurnState(value) {
  return value === 'running' || value === 'completed' || value === 'aborted' || value === 'error'
    ? value
    : 'completed'
}

export function micaHomeDir() {
  return process.env.MICA_HOME || join(homedir(), '.mica')
}

export function sessionsDir() {
  const micaHome = process.env.MICA_HOME
  return micaHome ? join(micaHome, 'sessions') : join(homedir(), '.mica', 'sessions')
}

export function sessionFile(sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null
  return join(sessionsDir(), `${sessionId}.json`)
}

/**
 * 会话文件是否存在。分享链接的有效性用它判定（链接就是凭据，指向的会话不在就当没这条
 * 链接），所以这里只认「文件名合法 + 文件在」：id 里的 `/`、`..` 一律不成立。
 */
export function sessionExists(sessionId) {
  const id = String(sessionId ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return false
  return existsSync(join(sessionsDir(), `${id}.json`))
}

export function readMicaConfig() {
  try {
    const file = join(micaHomeDir(), 'config.json')
    if (!existsSync(file)) return { providers: [], defaultModel: null }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return {
      providers: Array.isArray(raw?.providers) ? raw.providers : [],
      defaultModel: raw?.defaultModel || null
    }
  } catch {
    return { providers: [], defaultModel: null }
  }
}

export function readDefaultMeta() {
  return resolveDefaultChatMeta(readMicaConfig())
}

export function protocolForProviderId(providerId) {
  const { providers } = readMicaConfig()
  return resolveProviderProtocol(providers, providerId)
}

export function protocolForModelId(modelId) {
  const { providers } = readMicaConfig()
  return resolveModelProtocol(providers, modelId)
}

export function messageText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block?.type === 'text') return block.text
        if (block?.type === 'image') return '[图片]'
        return ''
      })
      .join('')
  }
  return ''
}

/** 读取会话文件里的 UI 层对话消息，转成 renderer 友好的轻量结构 */
export function readHistory(sessionId) {
  const file = sessionFile(sessionId)
  if (!file || !existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const messages = raw?.snapshot?.conversationMessages
    if (!Array.isArray(messages)) return []
    return messages.map((message) => ({
      role: message.role,
      text: messageText(message.displayContent ?? message.content),
      ...(message.role === 'notice' && message.displayContent != null && messageText(message.displayContent) !== messageText(message.content)
        ? { fullText: messageText(message.content) }
        : {}),
      variant: message.variant ?? null,
      command: message.command ?? null,
      status: message.status ?? null,
      usage: message.usage ?? null,
      stop_reason: message.stop_reason ?? null
    }))
  } catch {
    return []
  }
}

export function readSessionMeta(sessionId) {
  const file = sessionFile(sessionId)
  if (!file || !existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const snapshot = raw?.snapshot
    if (!snapshot || typeof snapshot !== 'object') return null
    const usageHistory = Array.isArray(snapshot.usageHistory) ? snapshot.usageHistory : []
    const inputTokens = usageHistory.reduce(
      (sum, usage) => sum + Math.max(0, Number(usage?.inputTokens) || 0),
      0
    )
    const cachedInputTokens = usageHistory.reduce(
      (sum, usage) => sum + Math.max(0, Number(usage?.cachedInputTokens) || 0),
      0
    )
    const lastUsage = snapshot.lastUsage || usageHistory.at(-1) || null
    // compact 之后磁盘上的 lastUsage 仍是压缩前那次真实请求（Stats 对账口径），
    // 上下文徽标要显示压缩后的占用，直到下一次真实请求替换它。
    const displayTokens = Number(snapshot.displayUsage?.totalTokens) || 0
    return {
      providerId: snapshot.providerId || null,
      model: snapshot.model || null,
      effort: snapshot.effort || null,
      role: snapshot.role || 'default',
      cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
      protocol: protocolForProviderId(snapshot.providerId),
      contextWindowSize: Number(snapshot.contextWindowSize) || null,
      lastUsage:
        displayTokens > 0
          ? {
              // 与 ChatView 的 applyCompactMeta 保持同一种形状：只描述上下文占用
              totalTokens: displayTokens,
              inputTokens: displayTokens,
              outputTokens: 0,
              cachedInputTokens: 0
            }
          : lastUsage,
      cachedRate: inputTokens > 0 ? cachedInputTokens / inputTokens : 0,
      turnState: normalizedTurnState(raw.turnState),
      updatedAt: raw.updatedAt || null
    }
  } catch {
    return null
  }
}

/** 只取 cwd 时先读文件头，读不到才退回整份解析。 */
export function readSessionCwd(sessionId) {
  const file = sessionFile(sessionId)
  if (!file || !existsSync(file)) return null
  return readTopLevelCwd(file) ?? readSessionMeta(sessionId)?.cwd ?? null
}
