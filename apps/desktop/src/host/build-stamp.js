/**
 * 构建产物指纹：判断「这一次构建到底改了什么」，据此决定要重载到哪一层。
 *
 * `npm run build:app` 收尾时由 `scripts/build-stamp.mjs` 写一份 stamp，运行中的实例
 * 监听它。之所以不直接对产物目录做 watch：产物目录是一次构建里被整体重写的，watch 会
 * 在写到一半时就开火，而且分不清「改了界面」和「改了 CLI」——而这两者的代价差一个量级
 * （前者只是页面 reload，后者要把每个会话宿主换掉）。
 *
 * 分层的判据只有一条：**哪一份产物变了，就要换掉加载它的那个东西**。
 * - `renderer`：页面自己的包，`webContents` reload 就够，会话宿主不受影响；
 * - `cli`：`~/.local/lib/mica/mica` 这个二进制，插件与工具都在里面，要重启会话宿主；
 * - `runtime`：`out/server`，运行时自己，只能整窗重启；
 * - `shell`：`out/main`，Electron 外壳，同样只能重启应用。
 *
 * 文件放在 `$MICA_HOME` 下而不是仓库里：用户装好的应用看不到仓库，而这份文件一旦存在
 * 就意味着「这台机器上有人在开发 mica」，正是应该自动重载的那些人。
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const STAMP_VERSION = 1
export const STAMP_FILE_NAME = 'dev-build-stamp.json'
/** 轻 → 重的顺序：某一层变了，比它轻的层跟着一起换掉。 */
export const STAMP_LAYERS = ['renderer', 'cli', 'runtime', 'shell']

export function resolveStampPath({ env = process.env, homeDirectory = homedir() } = {}) {
  const explicit = (env.MICA_DEV_BUILD_STAMP || '').trim()
  if (explicit) return explicit
  const home = (env.MICA_HOME || '').trim() || join(homeDirectory, '.mica')
  return join(home, STAMP_FILE_NAME)
}

/** 读 stamp；不存在、坏掉、版本对不上都返回 null（= 这台机器上没在开发 mica）。 */
export function readBuildStamp(path) {
  if (!path || !existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.version !== STAMP_VERSION) return null
    if (!parsed.artifacts || typeof parsed.artifacts !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 比较两份 stamp，得出这次要重载到哪一层。
 *
 * 第一次见到 stamp（`previous` 为 null）只当基线：实例启动时手上那份产物就是当前这份，
 * 不该因为「文件存在」而立刻重载一次。
 */
export function classifyBuildChange(previous, next) {
  if (!next) return { level: null, changed: [] }
  if (!previous) return { level: null, changed: [] }
  const changed = STAMP_LAYERS.filter(
    (layer) => fingerprint(previous, layer) !== fingerprint(next, layer)
  )
  // 同时改了两层时按最重的那一层处理：重启外壳自然带上新的界面。
  const level = changed.length > 0 ? changed[changed.length - 1] : null
  return { level, changed }
}

export function fingerprint(stamp, layer) {
  const entry = stamp?.artifacts?.[layer]
  if (!entry || typeof entry !== 'object') return ''
  return `${entry.path || ''}:${entry.size ?? ''}:${entry.mtimeMs ?? ''}`
}

/**
 * 「运行时已经腾空了，可以重启外壳」的交接文件。
 *
 * 运行时自己换不掉 asar 里的代码（`out/main`、`out/server` 都在里面），只有外壳能
 * `app.relaunch()`。而「现在有没有一轮在跑」只有运行时知道，所以它腾空会话宿主后落一个
 * 文件，外壳看到才重启——两边各管自己知道的那一半。
 */
export function restartMarkerPath(stampPath) {
  return `${stampPath}.restart`
}

export function writeRestartMarker(stampPath, payload = {}) {
  const path = restartMarkerPath(stampPath)
  writeFileSync(`${path}.tmp`, JSON.stringify({ at: Date.now(), ...payload }), 'utf8')
  renameSync(`${path}.tmp`, path)
  return path
}

/** 读完立刻删掉：交接文件只对被唤醒的那一次有效，留着会让下一次启动又重启一遍。 */
export function consumeRestartMarker(stampPath) {
  const path = restartMarkerPath(stampPath)
  if (!existsSync(path)) return null
  let payload = {}
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    payload = {}
  }
  rmSync(path, { force: true })
  return payload
}
