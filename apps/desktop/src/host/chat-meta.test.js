import { describe, expect, it } from 'vitest'
import { resolveDefaultChatMeta } from './chat-meta'

const providers = [
  {
    id: 'primary',
    protocol: 'openai_responses',
    models: ['primary/default', 'primary/other']
  },
  {
    id: 'plain',
    protocol: 'openai_chat_completions',
    models: ['plain/model'],
    supportsEffort: false
  }
]

const legacyStorage = {
  lastUsedByDirectory: {
    '/tmp/mica-project': {
      provider: 'plain',
      model: 'plain/model',
      effort: 'low',
      providerPreferences: {
        primary: { model: 'primary/other', effort: 'high' }
      }
    }
  }
}

describe('resolveDefaultChatMeta', () => {
  it('uses the configured default model and effort instead of directory or runtime state', () => {
    expect(
      resolveDefaultChatMeta(
        {
          providers,
          defaultModel: { provider: 'primary', model: 'primary/other', effort: 'xhigh' },
          provider: 'plain',
          model: 'plain/model',
          effort: 'low'
        },
        legacyStorage,
        '/tmp/mica-project'
      )
    ).toMatchObject({
      providerId: 'primary',
      model: 'primary/other',
      effort: 'xhigh',
      protocol: 'openai_responses'
    })
  })

  it('uses the first provider and model, ignoring all legacy selection sources', () => {
    expect(
      resolveDefaultChatMeta(
        { providers, provider: 'plain', model: 'plain/model', effort: 'high' },
        legacyStorage,
        '/tmp/mica-project'
      )
    ).toMatchObject({ providerId: 'primary', model: 'primary/default', effort: null })
  })

  it('leaves omitted effort to the selected model default', () => {
    expect(
      resolveDefaultChatMeta({
        providers,
        defaultModel: { provider: 'primary', model: 'primary/other' }
      })
    ).toMatchObject({ providerId: 'primary', model: 'primary/other', effort: null })
  })

  it('disables effort for unsupported providers', () => {
    expect(
      resolveDefaultChatMeta({
        providers,
        defaultModel: { provider: 'plain', model: 'plain/model', effort: 'xhigh' }
      })
    ).toMatchObject({ providerId: 'plain', model: 'plain/model', effort: 'none' })
  })

  it('does not invent a medium effort for malformed effort values', () => {
    expect(
      resolveDefaultChatMeta({
        providers,
        defaultModel: { provider: 'primary', model: 'primary/other', effort: 'BAD EFFORT' }
      })
    ).toMatchObject({ effort: null })
  })

  it('leaves dynamic first-model resolution to the CLI without choosing a later provider', () => {
    expect(resolveDefaultChatMeta({ providers: [{ id: 'dynamic' }, ...providers] })).toBeNull()
    expect(
      resolveDefaultChatMeta({ providers: [{ id: 'dynamic', models: [] }, ...providers] })
    ).toBeNull()
  })

  it('previews an explicit default for a provider with a dynamic model list', () => {
    expect(
      resolveDefaultChatMeta({
        providers: [{ id: 'dynamic', protocol: 'openai_responses' }],
        defaultModel: { provider: 'dynamic', model: 'dynamic-model', effort: 'max' }
      })
    ).toMatchObject({ providerId: 'dynamic', model: 'dynamic-model', effort: 'max' })
  })

  it('does not substitute another model for an invalid default configuration', () => {
    expect(
      resolveDefaultChatMeta({ providers, defaultModel: { provider: 'missing', model: 'model' } })
    ).toBeNull()
    expect(
      resolveDefaultChatMeta({ providers, defaultModel: { provider: 'primary', model: '' } })
    ).toBeNull()
    expect(resolveDefaultChatMeta({ providers: [] })).toBeNull()
  })
})
