import { resolve } from 'path'

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

function supportsModel(provider, model) {
  return (
    !Array.isArray(provider?.models) ||
    provider.models.length === 0 ||
    provider.models.includes(model)
  )
}

export function resolveDefaultChatMeta(config, storage, cwd) {
  const providers = Array.isArray(config?.providers) ? config.providers : []
  const directory = nonEmptyString(cwd)
  const normalizedDirectory = directory ? resolve(directory) : resolve(process.cwd())
  const dirMap = storage?.lastUsedByDirectory || {}
  const dirEntry = dirMap[normalizedDirectory] || dirMap[directory] || null
  const requestedProvider = nonEmptyString(dirEntry?.provider) || nonEmptyString(config?.provider)
  const provider =
    providers.find((item) => item?.id === requestedProvider) || providers.find((item) => item?.id)
  const providerId = nonEmptyString(provider?.id) || requestedProvider
  if (!providerId) return null

  const providerPrefs = dirEntry?.providerPreferences?.[providerId]
  const modelCandidates = [providerPrefs?.model, dirEntry?.model, provider?.models?.[0]]
  const model = modelCandidates
    .map(nonEmptyString)
    .find((candidate) => candidate && supportsModel(provider, candidate))
  if (!model) return null

  const requestedEffort = nonEmptyString(providerPrefs?.effort) || nonEmptyString(dirEntry?.effort)
  const effort =
    provider?.supportsEffort === false
      ? 'none'
      : isEffortLevelName(requestedEffort)
        ? requestedEffort
        : 'medium'

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
