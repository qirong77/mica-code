const DEFAULT_PROTOCOL = 'openai_chat_completions'

/**
 * 档位名随模型而变（`max`、`minimal`、`on` …），这里只做语法检查，不做白名单：
 * 具体某档是否被当前模型支持由 agent 侧 normalizeModelEffort 收敛。
 */
function isEffortLevelName(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

export function resolveDefaultChatMeta(config) {
  const providers = Array.isArray(config?.providers) ? config.providers : []
  const defaults = config?.defaultModel
  const provider = defaults
    ? providers.find((item) => item?.id === nonEmptyString(defaults.provider))
    : providers[0]
  const providerId = nonEmptyString(provider?.id)
  if (!providerId) return null

  // 动态模型列表由 CLI 拉取；预览不能跳到其他 provider 或复用上次会话。
  const model = nonEmptyString(defaults ? defaults.model : provider?.models?.[0])
  if (!model) return null

  const requestedEffort = nonEmptyString(defaults?.effort)
  const effort =
    provider?.supportsEffort === false
      ? 'none'
      : isEffortLevelName(requestedEffort)
        ? requestedEffort
        : null

  return {
    providerId,
    model,
    effort,
    role: 'default',
    protocol: provider?.protocol || DEFAULT_PROTOCOL,
    contextWindowSize: null,
    lastUsage: null,
    cachedRate: 0,
    turnState: 'idle',
    updatedAt: null
  }
}
