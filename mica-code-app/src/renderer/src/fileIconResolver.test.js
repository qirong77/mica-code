import { describe, expect, it } from 'bun:test'
import { resolveFileIconName, resolveFolderIconName } from './fileIconResolver'

describe('file icon resolver', () => {
  it.each([
    ['bun.lock', 'bun'],
    ['.bun.lock', 'bun'],
    ['.npmrc', 'npm'],
    ['.env', 'dotenv'],
    ['vite.config.ts', 'vite'],
    ['types.d.ts', 'typescriptdef'],
    ['component.blade.php', 'blade']
  ])('resolves %s from the generated vscode-icons manifest', (filename, expectedIcon) => {
    expect(resolveFileIconName(filename)).toBe(expectedIcon)
  })

  it('falls back to the default file icon', () => {
    expect(resolveFileIconName('file.with-an-unknown-extension')).toBe('file')
  })

  it('resolves a specialized folder icon', () => {
    expect(resolveFolderIconName('node_modules')).toBe('node')
  })
})
