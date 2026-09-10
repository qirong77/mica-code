import { spawn } from 'child_process'

// Shell run-state keys that must not leak into spawned mica processes.
const SHELL_RUNTIME_KEYS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])

// Interactive + login is required to pick up ~/.zshrc (interactive) and
// ~/.zprofile / ~/.bash_profile (login). The GUI app is launched by launchd
// without a shell, so without this the user's profile exports never reach
// the mica child processes.
const SHELL_ENV_ARGS = ['-i', '-l', '-c', 'env']

/**
 * Parse `env` output into a plain object. Values spanning multiple lines are
 * joined back onto the key that introduced them.
 */
export function parseShellEnvOutput(stdout) {
  const result = {}
  let pendingKey = null
  for (const line of stdout.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (match) {
      pendingKey = match[1]
      result[pendingKey] = match[2]
    } else if (pendingKey !== null && line.length > 0) {
      result[pendingKey] = `${result[pendingKey]}\n${line}`
    }
  }
  return result
}

function pickLoginShell(env, platform) {
  if (platform === 'win32') return null
  const configured = env.SHELL
  if (configured && (configured.includes('zsh') || configured.includes('bash'))) return configured
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

/**
 * Run a login/interactive shell once and resolve with the exported environment.
 * Resolves with null on Windows, unknown shell, timeout or spawn failure.
 */
export function captureShellEnv({
  shell,
  args = SHELL_ENV_ARGS,
  env = process.env,
  platform = process.platform,
  timeoutMs = 3000
} = {}) {
  if (platform === 'win32') return Promise.resolve(null)
  const resolvedShell = shell || pickLoginShell(env, platform)
  if (!resolvedShell) return Promise.resolve(null)
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const child = spawn(resolvedShell, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      finish(null)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.on('error', () => finish(null))
    child.on('close', () => {
      const parsed = parseShellEnvOutput(stdout)
      for (const key of SHELL_RUNTIME_KEYS) delete parsed[key]
      finish(parsed)
    })
  })
}

let cachedEnv = null
let cachedPromise = null

/** Kick off the one-time capture. Repeated calls return the same promise. */
export function warmShellEnv(options) {
  if (!cachedPromise) {
    cachedPromise = captureShellEnv(options).then((env) => {
      cachedEnv = env
      return env
    })
  }
  return cachedPromise
}

/** Synchronous snapshot of the captured environment, null before capture finishes. */
export function getShellEnvSnapshot() {
  return cachedEnv
}
