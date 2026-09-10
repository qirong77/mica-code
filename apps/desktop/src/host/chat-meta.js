import { resolve } from 'path'

const DEFAULT_PROTOCOL = 'openai_chat_completions'
const EFFORT_OPTIONS = new Set(['none', 'low', 'medium', 'high', 'xhigh'])

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
      : EFFORT_OPTIONS.has(requestedEffort)
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
