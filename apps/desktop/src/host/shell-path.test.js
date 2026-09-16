import { describe, expect, it } from 'bun:test'
import { resolveDefaultShell } from './shell-path'

const everythingExists = () => true
const onlyLinuxShells = (candidate) => candidate !== '/bin/zsh'

describe('resolveDefaultShell', () => {
  it('uses COMSPEC on Windows and never a POSIX path', () => {
    expect(resolveDefaultShell({ platform: 'win32', env: { COMSPEC: 'C:\\cmd.exe' } })).toBe(
      'C:\\cmd.exe'
    )
    expect(resolveDefaultShell({ platform: 'win32', env: {} })).toBe('powershell.exe')
  })

  it('honours an existing SHELL', () => {
    expect(
      resolveDefaultShell({
        platform: 'linux',
        env: { SHELL: '/usr/bin/fish' },
        exists: everythingExists
      })
    ).toBe('/usr/bin/fish')
  })

  it('ignores a SHELL that is not on disk', () => {
    expect(
      resolveDefaultShell({
        platform: 'linux',
        env: { SHELL: '/bin/zsh' },
        exists: onlyLinuxShells
      })
    ).toBe('/bin/bash')
  })

  it('falls back to a shell that exists when SHELL is unset', () => {
    // Linux 容器/服务里没有 SHELL 是常态，不能回落成 macOS 的 zsh
    expect(resolveDefaultShell({ platform: 'linux', env: {}, exists: onlyLinuxShells })).toBe(
      '/bin/bash'
    )
    expect(resolveDefaultShell({ platform: 'darwin', env: {}, exists: everythingExists })).toBe(
      '/bin/zsh'
    )
  })

  it('keeps dropping candidates until one exists', () => {
    expect(resolveDefaultShell({ platform: 'linux', env: {}, exists: () => false })).toBe('/bin/sh')
    expect(
      resolveDefaultShell({ platform: 'darwin', env: {}, exists: (p) => p === '/bin/sh' })
    ).toBe('/bin/sh')
  })

  it('treats a blank SHELL as unset', () => {
    expect(
      resolveDefaultShell({ platform: 'linux', env: { SHELL: '   ' }, exists: onlyLinuxShells })
    ).toBe('/bin/bash')
  })
})
