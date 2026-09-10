import { describe, expect, it } from 'bun:test'
import { resolveModelProtocol, resolveProviderProtocol } from './chat-protocol'

// providers 结构对应 ~/.mica/config.json 的 providers 数组子集。
const providers = [
  { id: 'krill', protocol: 'openai_responses' },
  { id: 'krill-prod', protocol: 'openai_chat_completions' },
  { id: 'openai', protocol: 'openai_responses' },
  { id: 'legacy', models: ['legacy/plain'] } // 无 protocol 字段
]

describe('resolveProviderProtocol', () => {
  it('returns the protocol of a configured provider', () => {
    expect(resolveProviderProtocol(providers, 'krill')).toBe('openai_responses')
    expect(resolveProviderProtocol(providers, 'openai')).toBe('openai_responses')
    expect(resolveProviderProtocol(providers, 'krill-prod')).toBe('openai_chat_completions')
  })

  it('falls back to the default protocol when the provider is not configured', () => {
    expect(resolveProviderProtocol(providers, 'removed-provider')).toBe('openai_chat_completions')
  })

  it('falls back to the default protocol for empty / missing provider id', () => {
    expect(resolveProviderProtocol(providers, '')).toBe('openai_chat_completions')
    expect(resolveProviderProtocol(providers, null)).toBe('openai_chat_completions')
    expect(resolveProviderProtocol(providers, undefined)).toBe('openai_chat_completions')
  })

  it('falls back to the default protocol when the provider has no protocol field', () => {
    expect(resolveProviderProtocol(providers, 'legacy')).toBe('openai_chat_completions')
  })

  it('handles an empty or missing providers list', () => {
    expect(resolveProviderProtocol([], 'krill')).toBe('openai_chat_completions')
    expect(resolveProviderProtocol(undefined, 'krill')).toBe('openai_chat_completions')
  })
})

describe('resolveModelProtocol', () => {
  it('resolves the protocol from the model id prefix', () => {
    expect(resolveModelProtocol(providers, 'krill/gpt-5')).toBe('openai_responses')
    expect(resolveModelProtocol(providers, 'openai/gpt-5')).toBe('openai_responses')
    expect(resolveModelProtocol(providers, 'krill-prod/gpt-5')).toBe('openai_chat_completions')
  })

  it('prefers the longest matching provider id prefix', () => {
    // krill-prod 必须优先于 krill，否则 krill-prod 的模型会被误判协议
    expect(resolveModelProtocol(providers, 'krill-prod/gpt-5')).toBe('openai_chat_completions')
    expect(resolveModelProtocol(providers, 'krill/gpt-5')).toBe('openai_responses')
  })

  it('falls back to the default protocol for bare model names without a prefix', () => {
    expect(resolveModelProtocol(providers, 'gpt-5')).toBe('openai_chat_completions')
  })

  it('falls back to the default protocol for unknown provider prefixes', () => {
    expect(resolveModelProtocol(providers, 'unknown/model')).toBe('openai_chat_completions')
  })

  it('falls back to the default protocol for empty / missing model id', () => {
    expect(resolveModelProtocol(providers, '')).toBe('openai_chat_completions')
    expect(resolveModelProtocol(providers, null)).toBe('openai_chat_completions')
  })

  it('handles provider ids that themselves contain a slash', () => {
    const nested = [{ id: 'openai/prod', protocol: 'openai_chat_completions' }]
    expect(resolveModelProtocol(nested, 'openai/prod/gpt-5')).toBe('openai_chat_completions')
  })

  it('handles an empty or missing providers list', () => {
    expect(resolveModelProtocol([], 'krill/gpt-5')).toBe('openai_chat_completions')
    expect(resolveModelProtocol(undefined, 'krill/gpt-5')).toBe('openai_chat_completions')
  })

  it('does not treat a provider id as a prefix match without the trailing slash', () => {
    // 'krill-x'.startsWith('krill/') 必须为 false，否则纯前缀误匹配
    const single = [{ id: 'krill', protocol: 'openai_responses' }]
    expect(resolveModelProtocol(single, 'krill-x/model')).toBe('openai_chat_completions')
  })

  it('does not mutate the providers input when sorting', () => {
    const input = [...providers]
    const before = input.map((item) => item.id)
    resolveModelProtocol(input, 'krill/gpt-5')
    expect(input.map((item) => item.id)).toEqual(before)
  })
})
