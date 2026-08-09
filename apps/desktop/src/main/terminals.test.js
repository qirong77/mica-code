import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { normalizeMicaCommand, resolveMicaExecutable } from './mica-cli'

const temporaryDirectories = []

function makeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mica-cli-resolution-'))
  temporaryDirectories.push(home)
  return home
}

function makeMica(home, relativePath = '.local/bin/mica', executable = true) {
  const file = path.join(home, relativePath)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '#!/bin/sh\n')
  if (executable) chmodSync(file, 0o755)
  return file
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('mica CLI resolution', () => {
  it('prefers a valid explicit MICA_CLI_PATH over the default install', () => {
    const home = makeHome()
    const defaultMica = makeMica(home)
    const explicitMica = makeMica(home, 'tools/mica')

    expect(
      resolveMicaExecutable({
        env: { MICA_CLI_PATH: `  ${explicitMica}  ` },
        homeDirectory: home
      })
    ).toBe(explicitMica)
    expect(defaultMica).not.toBe(explicitMica)
  })

  it('falls back to ~/.local/bin/mica and rejects a non-executable file', () => {
    const home = makeHome()
    const defaultMica = makeMica(home)
    const nonExecutable = makeMica(home, 'tools/not-executable', false)

    expect(resolveMicaExecutable({ env: {}, homeDirectory: home })).toBe(defaultMica)
    expect(
      resolveMicaExecutable({ env: { MICA_CLI_PATH: nonExecutable }, homeDirectory: home })
    ).toBe(defaultMica)
  })

  it('returns null when neither the explicit nor default CLI is executable', () => {
    const home = makeHome()

    expect(
      resolveMicaExecutable({
        env: { MICA_CLI_PATH: path.join(home, 'missing-mica') },
        homeDirectory: home
      })
    ).toBeNull()
  })
})

describe('mica CLI terminal command', () => {
  it('replaces mica with the resolved absolute executable and preserves arguments', () => {
    const mica = '/tmp/Mica Code/.local/bin/mica'

    expect(normalizeMicaCommand(' mica   --version ', mica)).toBe(`'${mica}' --version`)
    expect(normalizeMicaCommand('mica', mica)).toBe(`'${mica}'`)
  })

  it('leaves non-mica commands unchanged and ignores empty input', () => {
    expect(normalizeMicaCommand('node script.js', '/tmp/mica')).toBe('node script.js')
    expect(normalizeMicaCommand('   ', '/tmp/mica')).toBeNull()
    expect(normalizeMicaCommand(null, '/tmp/mica')).toBeNull()
  })
})
