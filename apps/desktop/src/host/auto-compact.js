import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  applyAutoCompactStatus,
  clearAutoCompactCounters as clearAllCounters,
  emptyAutoCompactState,
  normalizeAutoCompactSettings,
  normalizeAutoCompactState,
  readAutoCompactTurnParams as turnParamsFor,
  resetAutoCompactCounters as dropCounters
} from './auto-compact-state'

/**
 * 自动压缩的宿主：磁盘上的 `userData/auto-compact.json` 与进程内缓存。
 *
 * 与定时循环（loops.js）同一套边界：设置与按会话计的运行次数活在运行时进程里，两个读写的
 * 地方都只认这一份缓存 —— chat.js 每次 `turn/start` 同步取参数（同步是必须的：它就在发请求
 * 的那一行），配置页的 Auto Compact 一节（host/configWebData.js）读写整份设置与计数。
 * app-server 压完一次回推 `mica/autoCompact/updated`，计数记回这里；写设置的是配置页，
 * 所以设置页是它唯一的编辑入口（见 AGENT.md 的「apps/desktop 的架构」）。
 *
 * 数据模型与校验在 auto-compact-state.js：这里只管落盘与缓存。
 */

const FILE_NAME = 'auto-compact.json'

let cache = null

/** 设置页用它把「数据存在哪」显示出来。 */
export function autoCompactFilePath() {
  return join(app.getPath('userData'), FILE_NAME)
}

function load() {
  if (cache) return cache
  try {
    const raw = existsSync(autoCompactFilePath())
      ? JSON.parse(readFileSync(autoCompactFilePath(), 'utf8'))
      : null
    cache = normalizeAutoCompactState(raw)
  } catch {
    // 文件损坏时退回空状态：下一次写入会覆盖成合法内容，而不是让运行时起不来。
    cache = emptyAutoCompactState()
  }
  return cache
}

function persist(next) {
  const normalized = normalizeAutoCompactState(next)
  const changed = JSON.stringify(normalized) !== JSON.stringify(cache)
  cache = normalized
  // 只有真的变了才写盘：计数每压一次推一次，值没变时不该白写一遍文件。
  if (changed) {
    try {
      const target = autoCompactFilePath()
      mkdirSync(dirname(target), { recursive: true })
      // 先写临时文件再改名：进程被强杀时不会留下半截 JSON 让设置与计数凭空消失。
      const temporary = `${target}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
      renameSync(temporary, target)
    } catch (error) {
      console.error('[mica-desktop] 保存自动压缩设置失败:', error)
    }
  }
  return normalized
}

export function getAutoCompactSnapshot() {
  const state = load()
  return { path: autoCompactFilePath(), settings: state.settings, counters: state.counters }
}

/** `turn/start` 的扩展参数：chat.js 在发请求前同步取一次（草稿会话还没有 sessionId 时给全零）。 */
export function readAutoCompactTurnParams(sessionId) {
  return turnParamsFor(load(), sessionId)
}

/**
 * 配置页保存整份设置（越界值由 normalizeAutoCompactSettings 钳制）。
 * 返回落盘后的设置，调用方据此回显而不是回显自己刚提交的那份。
 */
export function saveAutoCompactSettings(settings) {
  return persist({ ...load(), settings: normalizeAutoCompactSettings(settings) }).settings
}

/** 清掉某个会话的计数；不带 sessionId 表示清空整张表。 */
export function resetAutoCompactCounters(sessionId) {
  const before = load()
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  const after = id ? dropCounters(before, id) : clearAllCounters(before)
  return persist(after).counters
}

/**
 * app-server 回推一次压缩结果：计数整块按 host 的说法落盘。压缩的执行者与计数的主人都是
 * host 自己（它按 provider 迭代边界决策），这里照单全收而不是本地累加，两边才不会各算一份。
 */
export function recordAutoCompactStatus(sessionId, status) {
  if (!sessionId) return
  const before = load()
  const after = applyAutoCompactStatus(before, sessionId, status)
  if (after !== before) persist(after)
}
