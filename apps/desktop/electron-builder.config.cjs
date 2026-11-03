const { execFileSync, spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } = require('node:fs')
const { dirname, join } = require('node:path')

// electron-builder normally extracts the cached Electron zip on every build.
// The electron package already contains the same unpacked distribution. Only
// reuse it when both version and architecture match the target; cross-builds,
// missing installations and custom Electron versions use the normal download.
const reusedElectronDirs = new Map()

module.exports = {
  extends: './electron-builder.yml',
  electronDist({ platformName, arch, version, appOutDir, packager }) {
    if (platformName !== 'darwin' || !['arm64', 'x64'].includes(arch)) return null
    // Language pruning runs before afterPack. Let the default extractor handle
    // custom locale lists rather than restoring directories that were pruned.
    if (
      packager?.platformSpecificBuildOptions?.electronLanguages ||
      packager?.config?.electronLanguages
    )
      return null

    try {
      const electronDir = dirname(require.resolve('electron/package.json'))
      const distDir = join(electronDir, 'dist')
      const installedVersion = readFileSync(join(distDir, 'version'), 'utf8').trim()
      if (installedVersion !== version) return null

      const executable = join(distDir, 'Electron.app', 'Contents', 'MacOS', 'Electron')
      const architectures = execFileSync('/usr/bin/lipo', ['-archs', executable], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
        .trim()
        .split(/\s+/)
      const machoArch = arch === 'x64' ? 'x86_64' : arch
      if (architectures.length !== 1 || architectures[0] !== machoArch) return null

      reusedElectronDirs.set(appOutDir, distDir)
      return distDir
    } catch {
      return null
    }
  },
  afterPack({ appOutDir, packager }) {
    const distDir = reusedElectronDirs.get(appOutDir)
    if (!distDir) return
    reusedElectronDirs.delete(appOutDir)
    const contents = join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents')
    const resources = join(contents, 'Resources')
    // Match electron-builder's normal extraction cleanup before signing.
    rmSync(join(resources, 'default_app.asar'), { force: true })
    // The builder calculated ASAR integrity before this hook, so its plist may
    // still refer to the removed archive. Keep the real app.asar hash intact.
    const infoPlist = join(contents, 'Info.plist')
    if (!existsSync(infoPlist)) throw new Error(`Missing Electron Info.plist: ${infoPlist}`)
    const result = spawnSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Delete :ElectronAsarIntegrity:Resources/default_app.asar', infoPlist],
      { encoding: 'utf8' }
    )
    if (result.error) throw result.error
    if (result.status !== 0 && !result.stderr.includes('Does Not Exist')) {
      throw new Error(`Could not update Electron ASAR integrity: ${result.stderr}`)
    }
    // builder's custom-distribution copier skips empty directories, including
    // Electron's .lproj markers used by macOS localization. Zip extraction
    // retains them, so recreate them before signing.
    const sourceResources = join(distDir, 'Electron.app', 'Contents', 'Resources')
    for (const entry of readdirSync(sourceResources, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.lproj')) continue
      const mode = statSync(join(sourceResources, entry.name)).mode & 0o777
      mkdirSync(join(resources, entry.name), { recursive: true, mode })
    }
  }
}
