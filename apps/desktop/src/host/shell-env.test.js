import { describe, expect, it } from 'bun:test'
import {
  captureShellEnv,
  getShellEnvSnapshot,
  parseShellEnvOutput,
  warmShellEnv
} from './shell-env'

describe('parseShellEnvOutput', () => {
  it('parses plain KEY=VALUE lines', () => {
    const parsed = parseShellEnvOutput('FOO=bar\nBAZ=1\n\n')
    expect(parsed).toEqual({ FOO: 'bar', BAZ: '1' })
  })

  it('joins continuation lines back onto multi-line values', () => {
    const parsed = parseShellEnvOutput('FOO=a\nb\nc\nBAR=1\n')
    expect(parsed).toEqual({ FOO: 'a\nb\nc', BAR: '1' })
  })

  it('handles empty values and ignores stray garbage lines', () => {
    const parsed = parseShellEnvOutput('not-an-env-line\nEMPTY=\nLAST=1\n')
    expect(parsed).toEqual({ EMPTY: '', LAST: '1' })
  })
})

describe('captureShellEnv', () => {
  it('returns null on Windows regardless of the requested shell', async () => {
    const env = await captureShellEnv({ shell: '/bin/zsh', platform: 'win32' })
    expect(env).toBeNull()
  })

  it('captures exports from the spawned shell', async () => {
    const env = await captureShellEnv({
      shell: '/bin/sh',
      args: ['-c', 'export TEST_CAPTURED_VAR=hello; env']
    })
    expect(env).not.toBeNull()
    expect(env.TEST_CAPTURED_VAR).toBe('hello')
  })

  it('strips shell run-state keys from the result', async () => {
    const env = await captureShellEnv({
      shell: '/bin/sh',
      args: ['-c', 'env']
    })
    expect(env).not.toBeNull()
    expect('PWD' in env).toBe(false)
    expect('SHLVL' in env).toBe(false)
    expect('_' in env).toBe(false)
  })

  it('resolves null when the shell does not exist', async () => {
    const env = await captureShellEnv({ shell: '/no/such/shell', timeoutMs: 500 })
    expect(env).toBeNull()
  })

  it('resolves null on timeout', async () => {
    const env = await captureShellEnv({
      shell: '/bin/sh',
      args: ['-c', 'sleep 30; env'],
      timeoutMs: 150
    })
    expect(env).toBeNull()
  })
})

describe('warmShellEnv / getShellEnvSnapshot', () => {
  it('caches the captured environment once ready', async () => {
    warmShellEnv({ shell: '/bin/sh', args: ['-c', 'export TEST_WARM_VAR=1; env'] })
    expect(getShellEnvSnapshot()).toBeNull()
    const env = await warmShellEnv()
    expect(env.TEST_WARM_VAR).toBe('1')
    expect(getShellEnvSnapshot()).toBe(env)
  })
})
