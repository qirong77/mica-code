import { describe, expect, it } from 'bun:test'
import { makeCallerTags } from './invoke-tags.js'

const callerTags = makeCallerTags((action) => action === 'readPluginsDetails')

describe('invoke caller tags', () => {
  it('only records known config actions, never their input', () => {
    expect(
      callerTags('config-web:invoke', {
        action: 'readPluginsDetails',
        input: { secret: 'private' }
      })
    ).toEqual({ action: 'readPluginsDetails' })
    expect(callerTags('config-web:invoke', { action: 'private-value' })).toBeUndefined()
    expect(callerTags('config-web:invoke', { action: '__proto__' })).toBeUndefined()
    expect(callerTags('another-channel', { action: 'readPluginsDetails' })).toBeUndefined()
  })
})
