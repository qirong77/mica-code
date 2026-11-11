import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const prune = spawnSync(process.execPath, [join(desktop, '../../scripts/prune-test-temp.mjs')], {
  stdio: 'inherit'
})
if (prune.status !== 0) process.exit(prune.status ?? 1)

// Bun's parallel workers keep the parent's initial child-process environment.
// Preload-time process.env changes alone do not isolate their Git children.
const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull }
let shimDir
try {
  if (existsSync('/usr/bin/git')) {
    shimDir = mkdtempSync(join(tmpdir(), 'mica-test-git-'))
    symlinkSync('/usr/bin/git', join(shimDir, 'git'))
    env.PATH = `${shimDir}:${env.PATH ?? ''}`
  }
  const filters = process.argv.slice(2)
  const result = spawnSync(
    'bun',
    [
      'test',
      '--parallel=4',
      '--timeout=20000',
      ...(filters.length ? filters : ['src/host', 'src/renderer/src', 'src/main'])
    ],
    { cwd: desktop, env, stdio: 'inherit' }
  )
  if (result.error) console.error(result.error.message)
  process.exitCode = result.status ?? 1
} finally {
  if (shimDir) rmSync(shimDir, { recursive: true, force: true })
}
