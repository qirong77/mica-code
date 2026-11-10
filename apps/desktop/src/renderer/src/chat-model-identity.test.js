import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { displayedModelId, selectedModelEntry } from './chat-model-identity'

describe('status line model identity', () => {
  it('shows the provider and model for new and restored sessions', () => {
    expect(displayedModelId(undefined, 'gpt-6-sol', 'us-codexgo')).toBe('us-codexgo/gpt-6-sol')
  })

  it('keeps the selected full id instead of the session provider', () => {
    expect(displayedModelId('krill/gpt-6-sol', 'gpt-6-sol', 'us-codexgo')).toBe('krill/gpt-6-sol')
  })

  it('preserves slashes in model names, even a model starting with the provider name', () => {
    expect(displayedModelId(undefined, 'openai/gpt-6', 'gateway')).toBe('gateway/openai/gpt-6')
    expect(displayedModelId(undefined, 'gateway/gpt-6', 'gateway')).toBe('gateway/gateway/gpt-6')
  })

  it('does not invent missing metadata', () => {
    expect(displayedModelId(undefined, 'gpt-6', undefined)).toBe('gpt-6')
    expect(displayedModelId(undefined, undefined, 'gateway')).toBe('')
  })

  it('looks up the exact provider for effort options rather than the first matching suffix', () => {
    const models = [
      { id: 'krill/gpt-6-sol', efforts: ['low'] },
      { id: 'us-codexgo/gpt-6-sol', efforts: ['high'] }
    ]
    expect(selectedModelEntry(models, undefined, 'gpt-6-sol', 'us-codexgo')).toBe(models[1])
    expect(selectedModelEntry(models, 'krill/gpt-6-sol', 'gpt-6-sol', 'us-codexgo')).toBe(models[0])
    expect(selectedModelEntry(models, undefined, 'gpt-6-sol', undefined)).toBeUndefined()
  })

  it('connects the same identity to the status, selected option and effort picker', () => {
    const chat = readFileSync(new URL('./ChatView.jsx', import.meta.url), 'utf8')
    expect(chat).toContain('displayedModelId(activeOverrides.model, meta?.model, meta?.providerId)')
    expect(chat).toContain('const activeEffortKey = activeModel')
    expect(chat).toContain(': activeModel) ||')
    expect(chat.match(/selectedModelEntry\(/g)).toHaveLength(2)
    expect(chat).toContain('{activeModel}')
  })
})
