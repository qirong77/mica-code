import { statSync } from 'fs'
import os from 'os'
import path from 'path'

// Windows has no executable bit — every regular file reports mode 0o100666 — so the
// POSIX permission test would reject the .exe/.cmd launchers there. On Windows,
// existence is the whole check: the native loader decides what is runnable.
function isExecutable(file, platform = process.platform) {
  try {
    const stats = statSync(file)
    if (!stats.isFile()) return false
    return platform === 'win32' || (stats.mode & 0o111) !== 0
  } catch {
    return false
  }
}

// `mica.exe` first: spawning a `.cmd` would require a shell (Node refuses since 20.12).
function candidateNames(platform) {
  return platform === 'win32' ? ['mica.exe', 'mica.cmd', 'mica.bat', 'mica'] : ['mica']
}

// The POSIX install puts one launcher in `~/.local/bin`; on Windows the real binary
// lives in `~/.local/lib/mica` next to that launcher's `mica.cmd` shim.
function candidateDirs(platform, homeDirectory) {
  const bin = path.join(homeDirectory, '.local', 'bin')
  return platform === 'win32' ? [bin, path.join(homeDirectory, '.local', 'lib', 'mica')] : [bin]
}

export function resolveMicaExecutable({
  env = process.env,
  homeDirectory = os.homedir(),
  platform = process.platform
} = {}) {
  const explicit = (env.MICA_CLI_PATH || '').trim()
  if (explicit && isExecutable(explicit, platform)) return explicit
  // Names outer: a `mica.exe` anywhere beats a `mica.cmd` shim in another directory.
  for (const name of candidateNames(platform)) {
    for (const dir of candidateDirs(platform, homeDirectory)) {
      const candidate = path.join(dir, name)
      if (isExecutable(candidate, platform)) return candidate
    }
  }
  return null
}

/** 归一化初始命令：`mica` 用绝对路径替换（Dock 启动的应用 PATH 精简） */
export function normalizeMicaCommand(value, mica = resolveMicaExecutable()) {
  if (typeof value !== 'string') return null
  const command = value.trim()
  if (!command) return null
  if (/^mica(?:\s|$)/.test(command) && mica) {
    return command.length === 4 ? `'${mica}'` : `'${mica}' ${command.slice(4).trim()}`
  }
  return command
}
