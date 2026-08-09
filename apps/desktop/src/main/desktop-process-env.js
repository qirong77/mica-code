import { accessSync, constants, readdirSync, statSync } from 'fs'
import os from 'os'
import path from 'path'

function isDirectory(candidate) {
  if (!candidate) return false
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function hasExecutableFile(candidate, platform) {
  if (!candidate) return false
  try {
    if (!statSync(candidate).isFile()) return false
    if (platform !== 'win32') accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function hasNodeToolchain(binDirectory, platform) {
  const nodeNames = platform === 'win32' ? ['node.exe', 'node'] : ['node']
  const npxNames = platform === 'win32' ? ['npx.cmd', 'npx.exe', 'npx'] : ['npx']
  return (
    nodeNames.some((name) => hasExecutableFile(path.join(binDirectory, name), platform)) &&
    npxNames.some((name) => hasExecutableFile(path.join(binDirectory, name), platform))
  )
}

function parseSemver(name) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(name)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  }
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1
  }

  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined || right[index] === undefined) {
      return left[index] === right[index] ? 0 : left[index] === undefined ? -1 : 1
    }
    if (left[index] === right[index]) continue
    const leftNumber = /^\d+$/.test(left[index]) ? Number(left[index]) : null
    const rightNumber = /^\d+$/.test(right[index]) ? Number(right[index]) : null
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber
    if (leftNumber !== null || rightNumber !== null) return leftNumber !== null ? -1 : 1
    return left[index].localeCompare(right[index])
  }
  return 0
}

function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

function readDirectories(parent) {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function findVersionedNodeBins(env, homeDirectory, platform) {
  const installs = []
  const addVersions = (versionsDirectory, resolveBin) => {
    for (const name of readDirectories(versionsDirectory)) {
      const version = parseSemver(name)
      if (!version) continue
      const binDirectory = resolveBin(versionsDirectory, name)
      if (hasNodeToolchain(binDirectory, platform)) installs.push({ version, binDirectory })
    }
  }

  const nvmRoots = [
    env.NVM_DIR,
    env.NVM_HOME,
    platform === 'win32' && env.APPDATA && path.join(env.APPDATA, 'nvm'),
    path.join(homeDirectory, '.nvm')
  ].filter(Boolean)
  for (const root of new Set(nvmRoots)) {
    addVersions(path.join(root, 'versions', 'node'), (parent, name) =>
      platform === 'win32' ? path.join(parent, name) : path.join(parent, name, 'bin')
    )
    if (platform === 'win32') {
      addVersions(root, (parent, name) => path.join(parent, name))
    }
  }

  const fnmRoots = [
    env.FNM_DIR,
    env.XDG_DATA_HOME && path.join(env.XDG_DATA_HOME, 'fnm'),
    platform === 'win32' && env.APPDATA && path.join(env.APPDATA, 'fnm'),
    platform === 'win32' && path.join(homeDirectory, 'AppData', 'Roaming', 'fnm'),
    path.join(homeDirectory, '.local', 'share', 'fnm'),
    platform === 'darwin' && path.join(homeDirectory, 'Library', 'Application Support', 'fnm')
  ].filter(Boolean)
  for (const root of new Set(fnmRoots)) {
    addVersions(path.join(root, 'node-versions'), (parent, name) => {
      const installation = path.join(parent, name, 'installation')
      const binDirectory = path.join(installation, 'bin')
      return hasNodeToolchain(binDirectory, platform) ? binDirectory : installation
    })
  }

  installs.sort((left, right) => compareSemver(right.version, left.version))
  return installs[0]?.binDirectory || null
}

function normalizeForComparison(candidate, platform) {
  const normalized = path.resolve(candidate).replace(/[\\/]+$/, '')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function discoverDesktopDirectories(env, homeDirectory, platform, systemDirectories) {
  const localData = env.LOCALAPPDATA || path.join(homeDirectory, 'AppData', 'Local')
  const selectedNodeBin = findVersionedNodeBins(env, homeDirectory, platform)
  const candidates = [
    env.NVM_SYMLINK && hasNodeToolchain(env.NVM_SYMLINK, platform) && env.NVM_SYMLINK,
    env.NVM_BIN && hasNodeToolchain(env.NVM_BIN, platform) && env.NVM_BIN,
    selectedNodeBin,
    path.join(homeDirectory, '.local', 'bin'),
    env.BUN_INSTALL && path.join(env.BUN_INSTALL, 'bin'),
    path.join(homeDirectory, '.bun', 'bin'),
    env.VOLTA_HOME && path.join(env.VOLTA_HOME, 'bin'),
    path.join(homeDirectory, '.volta', 'bin'),
    env.PNPM_HOME,
    path.join(homeDirectory, '.local', 'share', 'pnpm'),
    platform === 'darwin' && path.join(homeDirectory, 'Library', 'pnpm'),
    platform === 'win32' && path.join(localData, 'pnpm'),
    env.MISE_DATA_DIR && path.join(env.MISE_DATA_DIR, 'shims'),
    path.join(homeDirectory, '.local', 'share', 'mise', 'shims'),
    path.join(homeDirectory, '.asdf', 'shims'),
    ...systemDirectories
  ].filter((candidate) => candidate && isDirectory(candidate))

  const unique = []
  const seen = new Set()
  for (const candidate of candidates) {
    const normalized = normalizeForComparison(candidate, platform)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(candidate)
  }
  return unique
}

/**
 * Preserve the supplied PATH verbatim and append known desktop-tool directories that exist.
 * No shell or profile is executed.
 */
export function buildDesktopPath({
  env = process.env,
  homeDirectory = os.homedir(),
  platform = process.platform,
  delimiter = path.delimiter,
  systemDirectories = platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin']
} = {}) {
  const currentPath = env.PATH || env.Path || ''
  const seen = new Set(
    currentPath
      .split(delimiter)
      .filter(Boolean)
      .map((candidate) => normalizeForComparison(candidate, platform))
  )
  const additions = []
  for (const candidate of discoverDesktopDirectories(
    env,
    homeDirectory,
    platform,
    systemDirectories
  )) {
    const normalized = normalizeForComparison(candidate, platform)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    additions.push(candidate)
  }
  if (additions.length === 0) return currentPath
  return currentPath
    ? `${currentPath}${delimiter}${additions.join(delimiter)}`
    : additions.join(delimiter)
}

/** Update one process environment in place. Repeated calls are idempotent. */
export function initializeDesktopProcessPath(options = {}) {
  const env = options.env || process.env
  const nextPath = buildDesktopPath({ ...options, env })
  if (platformPathKey(env) === 'Path') env.Path = nextPath
  else env.PATH = nextPath
  return nextPath
}

function platformPathKey(env) {
  const hasUppercasePath = Object.prototype.hasOwnProperty.call(env, 'PATH')
  const hasWindowsPath = Object.prototype.hasOwnProperty.call(env, 'Path')
  return !hasUppercasePath && hasWindowsPath ? 'Path' : 'PATH'
}
