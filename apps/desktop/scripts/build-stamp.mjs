/**
 * 构建收尾写一份产物指纹（见 `src/host/build-stamp.js`），让运行中的实例知道自己该重载。
 *
 * 写盘放在「构建全部成功之后」，所以改到一半失败不会触发重载。目标是 `$MICA_HOME` 下的
 * `dev-build-stamp.json`：它同时也是「这台机器在开发 mica」的标记，装好的应用里没有这份
 * 文件，因此永远不会自动重载用户那一份。
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const STAMP_VERSION = 1
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = join(desktopRoot, 'out')

/**
 * 打包版页面不是从仓库 `out/renderer` 提供的，而是从 .app 里解包出来的那一份
 * （`publishableRendererDir()` 优先选它，因为 asar 索引在进程启动时就固定了）。
 * 只重建界面时那一份还是旧的，重载后拿到的就是旧界面——所以这里先同步过去。
 *
 * 整目录换 inode，不逐文件覆盖：倒计时结束时页面会重载，逐文件覆盖的中间态可能让
 * 新 index.html 引用到还没拷完的 assets。换成先拷到 `.staging-<pid>` 再 rename，
 * 页面要么读到旧的完整一份，要么读到新的完整一份。
 */
function replaceDir(source, target) {
  const staging = `${target}.staging-${process.pid}`
  const backup = `${target}.backup-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  rmSync(backup, { recursive: true, force: true })
  cpSync(source, staging, { recursive: true })
  renameSync(target, backup)
  try {
    renameSync(staging, target)
  } catch (error) {
    renameSync(backup, target)
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  rmSync(backup, { recursive: true, force: true })
}

function syncRendererIntoBundles() {
  const source = join(outRoot, 'renderer')
  if (!existsSync(join(source, 'index.html'))) return []
  const distRoot = join(desktopRoot, 'dist')
  if (!existsSync(distRoot)) return []
  const synced = []
  for (const entry of readdirSync(distRoot)) {
    const target = join(
      distRoot,
      entry,
      'mica-code-app.app',
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'out',
      'renderer'
    )
    if (!existsSync(join(target, 'index.html'))) continue
    replaceDir(source, target)
    synced.push(target)
  }
  return synced
}

const syncedBundles = syncRendererIntoBundles()

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
for (const dir of syncedBundles) console.log(`  renderer synced → ${dir}`)
if (missing.length > 0) console.log(`  (no artifact for: ${missing.join(', ')})`)
if (!existsSync(target)) process.exit(1)
