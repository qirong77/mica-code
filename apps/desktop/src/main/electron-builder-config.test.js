import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import config from '../../electron-builder.config.cjs'

const require = createRequire(import.meta.url)
const electronDir = dirname(require.resolve('electron/package.json'))
const { version } = require('electron/package.json')
const target = { platformName: 'darwin', arch: process.arch, version, appOutDir: '/unused' }
let nativeElectronInstalled = false
if (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) {
  try {
    const dist = join(electronDir, 'dist')
    const arch = execFileSync(
      '/usr/bin/lipo',
      ['-archs', join(dist, 'Electron.app/Contents/MacOS/Electron')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    nativeElectronInstalled =
      arch === (process.arch === 'x64' ? 'x86_64' : process.arch) &&
      readFileSync(join(dist, 'version'), 'utf8').trim() === version
  } catch {
    // A cross-build may not have a matching unpacked Electron installation.
  }
}

describe('local Electron distribution reuse', () => {
  it('falls back for other platforms, versions, universal builds and custom locales', () => {
    expect(config.electronDist({ ...target, platformName: 'linux' })).toBeNull()
    expect(config.electronDist({ ...target, version: '0.0.0' })).toBeNull()
    expect(config.electronDist({ ...target, arch: 'universal' })).toBeNull()
    expect(
      config.electronDist({
        ...target,
        packager: { platformSpecificBuildOptions: { electronLanguages: ['en'] } }
      })
    ).toBeNull()
  })

  const macOnly = nativeElectronInstalled ? it : it.skip
  macOnly('preserves locale directories and removes the default app before signing', () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'mica-electron-reuse-'))
    try {
      const resources = join(appOutDir, 'test.app/Contents/Resources')
      mkdirSync(resources, { recursive: true })
      const defaultApp = join(resources, 'default_app.asar')
      const infoPlist = join(appOutDir, 'test.app/Contents/Info.plist')
      writeFileSync(defaultApp, 'default')
      writeFileSync(
        infoPlist,
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>ElectronAsarIntegrity</key><dict>
<key>Resources/app.asar</key><dict><key>hash</key><string>app-hash</string></dict>
<key>Resources/default_app.asar</key><dict><key>hash</key><string>default-hash</string></dict>
</dict></dict></plist>`
      )
      const packager = { appInfo: { productFilename: 'test' } }
      const context = { appOutDir, packager }

      config.afterPack(context)
      expect(existsSync(defaultApp)).toBe(true) // No reuse: do not touch a custom distribution.
      expect(config.electronDist({ ...target, appOutDir })).toBe(join(electronDir, 'dist'))
      config.afterPack(context)
      expect(existsSync(defaultApp)).toBe(false)
      const appHash = execFileSync(
        '/usr/libexec/PlistBuddy',
        ['-c', 'Print :ElectronAsarIntegrity:Resources/app.asar:hash', infoPlist],
        { encoding: 'utf8' }
      ).trim()
      expect(appHash).toBe('app-hash')
      expect(readFileSync(infoPlist, 'utf8')).not.toContain('Resources/default_app.asar')

      const locales = readdirSync(join(electronDir, 'dist/Electron.app/Contents/Resources'), {
        withFileTypes: true
      }).filter((entry) => entry.isDirectory() && entry.name.endsWith('.lproj'))
      expect(locales.length).toBeGreaterThan(0)
      for (const locale of locales) expect(existsSync(join(resources, locale.name))).toBe(true)
    } finally {
      rmSync(appOutDir, { recursive: true, force: true })
    }
  })
})
