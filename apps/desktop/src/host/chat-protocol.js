// 模型/provider 的协议推断（纯函数，无 Electron 依赖）。
// 这是 ChatView 模型切换跨协议拦截的数据源：protocolForProviderId /
// protocolForModelId（chat.js）都基于这里的结果决定会话/模型的协议，
// 判断错误会直接导致同协议切换被误拦或跨协议切换被放行。

const DEFAULT_PROTOCOL = 'openai_chat_completions'

// 按 provider id 精确匹配协议；provider 不在配置中时回退默认协议。
export function resolveProviderProtocol(providers, providerId) {
  if (!providerId) return DEFAULT_PROTOCOL
  const provider = (Array.isArray(providers) ? providers : []).find(
    (item) => item?.id === providerId
  )
  return provider?.protocol || DEFAULT_PROTOCOL
}

// 按 "providerId/model" 前缀推断模型所属 provider 的协议。
// 前缀按 id 长度降序匹配，避免短 id 抢走长 id 的模型（如 krill 与 krill-prod）。
// 无法匹配（纯模型名、providers 缺失、id 不含 '/'）时回退默认协议。
export function resolveModelProtocol(providers, modelId) {
  if (!modelId) return DEFAULT_PROTOCOL
  const list = Array.isArray(providers) ? providers : []
  const matched = [...list]
    .sort((a, b) => (b?.id?.length || 0) - (a?.id?.length || 0))
    .find((provider) => modelId.startsWith(`${provider?.id}/`))
  return matched?.protocol || DEFAULT_PROTOCOL
}
