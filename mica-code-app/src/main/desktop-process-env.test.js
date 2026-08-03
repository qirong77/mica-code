import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { buildDesktopPath, initializeDesktopProcessPath } from './desktop-process-env'

const temporaryDirectories = []

function makeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mica-desktop-path-'))
  temporaryDirectories.push(home)
  return home
}

function makeDirectory(directory) {
  mkdirSync(directory, { recursive: true })
  return directory
}

function makeNodeBin(directory) {
  makeDirectory(directory)
  writeFileSync(path.join(directory, 'node'), '')
  writeFileSync(path.join(directory, 'npx'), '')
  chmodSync(path.join(directory, 'node'), 0o755)
  chmodSync(path.join(directory, 'npx'), 0o755)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('desktop process PATH', () => {
  test('completes a minimal PATH with existing user tool directories and explicit homes', () => {
    const home = makeHome()
    const original = '/usr/bin:/bin'
    const localBin = makeDirectory(path.join(home, '.local', 'bin'))
    const bunBin = makeDirectory(path.join(home, 'custom-bun', 'bin'))
    const voltaBin = makeDirectory(path.join(home, 'custom-volta', 'bin'))
    const pnpmHome = makeDirectory(path.join(home, 'custom-pnpm'))
    const miseShims = makeDirectory(path.join(home, 'custom-mise', 'shims'))
    const nvmBin = makeNodeBin(path.join(home, 'current-nvm', 'bin'))

    const result = buildDesktopPath({
      env: {
        PATH: original,
        BUN_INSTALL: path.join(home, 'custom-bun'),
        VOLTA_HOME: path.join(home, 'custom-volta'),
        PNPM_HOME: pnpmHome,
        MISE_DATA_DIR: path.join(home, 'custom-mise'),
        NVM_BIN: nvmBin
      },
      homeDirectory: home,
      platform: 'linux',
      delimiter: ':',
      systemDirectories: []
    })

    expect(result.split(':')).toEqual([
      '/usr/bin',
      '/bin',
      nvmBin,
      localBin,
      bunBin,
      voltaBin,
      pnpmHome,
      miseShims
    ])
  })

  test('preserves existing order and does not append duplicate directories', () => {
    const home = makeHome()
    const localBin = makeDirectory(path.join(home, '.local', 'bin'))
    const bunBin = makeDirectory(path.join(home, '.bun', 'bin'))
    const original = `/first:${localBin}:/last`

    expect(
      buildDesktopPath({
        env: { PATH: original, BUN_INSTALL: path.join(home, '.bun') },
        homeDirectory: home,
        platform: 'linux',
        delimiter: ':',
        systemDirectories: []
      })
    ).toBe(`${original}:${bunBin}`)
  })

  test('ignores candidate directories that do not exist', () => {
    const home = makeHome()
    expect(
      buildDesktopPath({
        env: {
          PATH: '/usr/bin',
          BUN_INSTALL: path.join(home, 'missing-bun'),
          PNPM_HOME: path.join(home, 'missing-pnpm')
        },
        homeDirectory: home,
        platform: 'linux',
        delimiter: ':',
        systemDirectories: []
      })
    ).toBe('/usr/bin')
  })

  test('discovers default Volta, pnpm, mise, and asdf locations', () => {
    const home = makeHome()
    const voltaBin = makeDirectory(path.join(home, '.volta', 'bin'))
    const pnpmHome = makeDirectory(path.join(home, '.local', 'share', 'pnpm'))
    const miseShims = makeDirectory(path.join(home, '.local', 'share', 'mise', 'shims'))
    const asdfShims = makeDirectory(path.join(home, '.asdf', 'shims'))

    expect(
      buildDesktopPath({
        env: { PATH: '/bin' },
        homeDirectory: home,
        platform: 'linux',
        delimiter: ':',
        systemDirectories: []
      }).split(':')
    ).toEqual(['/bin', voltaBin, pnpmHome, miseShims, asdfShims])
  })

  test('selects the highest valid semver from NVM and FNM installations', () => {
    const home = makeHome()
    const nvmVersions = path.join(home, '.nvm', 'versions', 'node')
    makeNodeBin(path.join(nvmVersions, 'v18.20.5', 'bin'))
    const expected = makeNodeBin(path.join(nvmVersions, 'v22.11.0', 'bin'))
    const incomplete = makeDirectory(path.join(nvmVersions, 'v99.0.0', 'bin'))
    writeFileSync(path.join(incomplete, 'node'), '')
    writeFileSync(path.join(incomplete, 'npx'), '')
    makeNodeBin(
      path.join(home, '.local', 'share', 'fnm', 'node-versions', 'v21.7.3', 'installation', 'bin')
    )

    const result = buildDesktopPath({
      env: { PATH: '/bin' },
      homeDirectory: home,
      platform: 'linux',
      delimiter: ':',
      systemDirectories: []
    })

    expect(result.split(':').at(-1)).toBe(expected)
    expect(result).not.toContain('v18.20.5')
    expect(result).not.toContain('v21.7.3')
    expect(result).not.toContain('v99.0.0')
  })

  test('refreshes discovery and initializes one environment idempotently', () => {
    const home = makeHome()
    const localBin = makeDirectory(path.join(home, '.local', 'bin'))
    const env = { PATH: '/bin' }
    const options = {
      env,
      homeDirectory: home,
      platform: 'linux',
      delimiter: ':',
      systemDirectories: []
    }

    const first = initializeDesktopProcessPath(options)
    expect(first).toBe(`/bin:${localBin}`)
    rmSync(localBin, { recursive: true, force: true })
    expect(initializeDesktopProcessPath(options)).toBe(first)

    expect(buildDesktopPath({ ...options, env: { PATH: '/bin' } })).toBe('/bin')
  })

  test('uses the Windows Path key and delimiter when supplied', () => {
    const home = makeHome()
    const localBin = makeDirectory(path.join(home, '.local', 'bin'))
    const env = { Path: 'C:\\Windows\\System32' }

    initializeDesktopProcessPath({
      env,
      homeDirectory: home,
      platform: 'win32',
      delimiter: ';',
      systemDirectories: []
    })

    expect(env).toEqual({ Path: `C:\\Windows\\System32;${localBin}` })
  })
})
