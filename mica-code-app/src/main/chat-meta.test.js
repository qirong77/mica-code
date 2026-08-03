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

describe('resolveDefaultChatMeta', () => {
  it('restores the model and effort last used in the new session directory', () => {
    const cwd = '/tmp/mica-project'
    const meta = resolveDefaultChatMeta(
      { providers },
      {
        lastUsedByDirectory: {
          [cwd]: {
            provider: 'primary',
            model: 'primary/default',
            effort: 'low',
            providerPreferences: {
              primary: { model: 'primary/other', effort: 'high' }
            }
          }
        }
      },
      cwd
    )

    expect(meta).toMatchObject({
      providerId: 'primary',
      model: 'primary/other',
      effort: 'high',
      protocol: 'openai_responses'
    })
  })

  it('falls back to the first configured provider and model', () => {
    expect(resolveDefaultChatMeta({ providers }, { version: 1 }, '/tmp/new-project')).toMatchObject(
      {
        providerId: 'primary',
        model: 'primary/default',
        effort: 'medium'
      }
    )
  })

  it('ignores stale selections and disables effort for unsupported providers', () => {
    const cwd = '/tmp/plain-project'
    const meta = resolveDefaultChatMeta(
      { providers, provider: 'plain' },
      {
        lastUsedByDirectory: {
          [cwd]: { provider: 'plain', model: 'missing/model', effort: 'xhigh' }
        }
      },
      cwd
    )

    expect(meta).toMatchObject({ providerId: 'plain', model: 'plain/model', effort: 'none' })
  })
})
