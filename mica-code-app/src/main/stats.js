import { app, ipcMain } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

/**
 * mica 的对话 session 快照统计：直接扫描 ~/.mica/sessions/*.json（真实 AI 会话），
 * 聚合出与 code-by-wire 对齐的快照结构（会话数 / turns / tokens / 模型 / 活跃记录 / 每日 / 日历）。
 * 目录内容指纹（文件名+mtime+size）不变时复用内存缓存，避免每次轮询重读 200+ 个大文件。
 */

/** 会话目录：MICA_HOME 环境变量可覆盖，默认 ~/.mica/sessions */
function sessionsDir() {
  const home = process.env.MICA_HOME || app.getPath('home')
  return join(home, '.mica', 'sessions')
}

/** 目录内容指纹：每个 session 文件的 name:mtimeMs:size，按名字排序拼起来 */
function fingerprint(dir) {
  if (!existsSync(dir)) return ''
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const st = statSync(join(dir, name))
        return `${name}:${st.mtimeMs}:${st.size}`
      })
      .sort()
      .join('|')
  } catch {
    return ''
  }
}

/** 解析单个 session 文件为统计行；损坏/示例文件返回 null */
function parseSession(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const createdAtMs = Date.parse(raw.createdAt)
  const updatedAtMs = Date.parse(raw.updatedAt)
  // 跳过示例/损坏文件（v1-session.json 的 createdAt 是 1970）
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(updatedAtMs) || createdAtMs <= 0)
    return null

  const snap = raw.snapshot || {}
  const msgs = snap.messages || []
  let turns = 0
  for (const msg of msgs) {
    if (msg?.role === 'assistant') turns++
  }
  const usageHistory = Array.isArray(snap.usageHistory)
    ? snap.usageHistory.filter((usage) => usage && typeof usage === 'object')
    : []
  const modelMap = new Map()
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let totalTokens = 0
  for (const usage of usageHistory) {
    const model = usage.model || snap.model || 'Unknown'
    const row = modelMap.get(model) || {
      model,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0
    }
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    const cached = Number(usage.cachedInputTokens) || 0
    const total = Number(usage.totalTokens) || input + output
    row.requests++
    row.inputTokens += input
    row.outputTokens += output
    row.cachedInputTokens += cached
    row.totalTokens += total
    inputTokens += input
    outputTokens += output
    cachedInputTokens += cached
    totalTokens += total
    modelMap.set(model, row)
  }
  const modelUsage = [...modelMap.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests
  )
  const model = modelUsage[0]?.model || snap.model || null

  return {
    id: raw.id || null,
    title: raw.title || null,
    cwd: raw.cwd || null,
    createdAtMs,
    updatedAtMs,
    turnState: raw.turnState || 'completed',
    model,
    providerId: snap.providerId || null,
    turns,
    requests: usageHistory.length,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
    modelUsage,
    durationMs: Math.max(0, updatedAtMs - createdAtMs)
  }
}

/** 扫描并缓存；指纹未变化时直接返回缓存 */
function scan() {
  const dir = sessionsDir()
  const fp = fingerprint(dir)
  if (cache && cache.fingerprint === fp) return cache.sessions
  const sessions = []
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const row = parseSession(join(dir, name))
        if (row) sessions.push(row)
      } catch {
        // 单个文件损坏不影响整体
      }
    }
  }
  sessions.sort((a, b) => a.createdAtMs - b.createdAtMs)
  cache = { fingerprint: fp, sessions }
  return sessions
}

let cache = null

export function registerStatsIpc() {
  ipcMain.handle('stats:read', () => ({
    sessions: scan(),
    scannedAt: Date.now()
  }))
}
