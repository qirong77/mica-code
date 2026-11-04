/**
 * 构建收尾写一份产物指纹（见 `src/host/build-stamp.js`），让运行中的实例知道自己该重载。
 *
 * 写盘放在「构建全部成功之后」，所以改到一半失败不会触发重载。目标是 `$MICA_HOME` 下的
 * `dev-build-stamp.json`：它同时也是「这台机器在开发 mica」的标记，装好的应用里没有这份
 * 文件，因此永远不会自动重载用户那一份。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const STAMP_VERSION = 1
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (process.env.MICA_DEV_RELOAD === '0') {
  console.log('dev reload disabled (MICA_DEV_RELOAD=0)')
  process.exit(0)
}

function stampPath() {
  const explicit = (process.env.MICA_DEV_BUILD_STAMP || '').trim()
  if (explicit) return explicit
  const home = (process.env.MICA_HOME || '').trim() || join(homedir(), '.mica')
  return join(home, 'dev-build-stamp.json')
}

/** 一份产物 = 路径 + 大小 + mtime。任何一个变了就说明这份产物换过了。 */
function artifact(file) {
  try {
    const stats = statSync(file)
    if (!stats.isFile()) return null
    return { path: file, size: stats.size, mtimeMs: Math.round(stats.mtimeMs) }
  } catch {
    return null
  }
}

function resolveCli() {
  const explicit = (process.env.MICA_CLI_PATH || '').trim()
  const candidates = [
    explicit,
    join(homedir(), '.local', 'lib', 'mica', 'mica'),
    join(homedir(), '.local', 'bin', 'mica'),
    join(desktopRoot, '..', '..', 'dist', 'mica')
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const found = artifact(candidate)
    if (found) return found
  }
  return null
}

const artifacts = {
  renderer: artifact(join(desktopRoot, 'out', 'renderer', 'index.html')),
  cli: resolveCli(),
  runtime: artifact(join(desktopRoot, 'out', 'server', 'index.mjs')),
  shell: artifact(join(desktopRoot, 'out', 'main', 'index.js'))
}

let revision = ''
try {
  revision = execFileSync('git', ['-C', desktopRoot, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
} catch {
  // 源码包 / 发布构建里可能没有 git，指纹本身不依赖它。
}

const stamp = {
  version: STAMP_VERSION,
  builtAt: new Date().toISOString(),
  revision,
  artifacts
}

const target = stampPath()
mkdirSync(dirname(target), { recursive: true })
const temp = `${target}.${process.pid}.tmp`
writeFileSync(temp, `${JSON.stringify(stamp, null, 2)}\n`)
renameSync(temp, target)

const missing = Object.entries(artifacts)
  .filter(([, value]) => !value)
  .map(([layer]) => layer)
console.log(`build stamp → ${target}`)
if (missing.length > 0) console.log(`  (no artifact for: ${missing.join(', ')})`)
if (!existsSync(target)) process.exit(1)
