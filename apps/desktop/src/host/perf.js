// 渲染层性能埋点落盘。
//
// 只由带 `?perf=1` 的页面按批调用（见 renderer 的 perf-probe.js）。目的不是做遥测，
// 而是让「下次卡顿」能拿到当时的现场数据：事件循环延迟、long task、堆大小、DOM 节点数。
// 数据写在 userData/perf/renderer-YYYYMMDD.jsonl，一行一个采样点，直接 tail 就能看。
import { app, ipcMain } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

const MAX_BYTES = 8 * 1024 * 1024
const KEEP_DAYS = 7

function perfDir() {
  // 用 userData 而不是 home/Library/Logs：shim 的 getPath 只保证 userData 在各平台都成立。
  const dir = join(app.getPath('userData'), 'perf')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function dayStamp(now) {
  const d = new Date(now)
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('')
}

function prune(dir, now) {
  const cutoff = now - KEEP_DAYS * 24 * 60 * 60 * 1000
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!/^renderer-.*\.jsonl$/.test(name)) continue
    const path = join(dir, name)
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
    } catch {
      // 单个文件删不掉不影响本次写入
    }
  }
}

function targetFile(dir, now) {
  const base = join(dir, `renderer-${dayStamp(now)}.jsonl`)
  if (!existsSync(base) || statSync(base).size <= MAX_BYTES) return base
  // 忙一天写满就按时间戳分片，不覆盖当天已有的数据
  return join(dir, `renderer-${dayStamp(now)}-${now}.jsonl`)
}

export function registerPerfIpc() {
  ipcMain.handle('perf:report', (_event, payload = {}) => {
    const samples = Array.isArray(payload?.samples) ? payload.samples : []
    if (samples.length === 0) return { written: 0, file: null }
    const now = Date.now()
    const dir = perfDir()
    const file = targetFile(dir, now)
    const body = samples
      .filter((sample) => sample && typeof sample === 'object')
      .map((sample) => JSON.stringify({ at: now, ...sample }))
      .join('\n')
    if (!body) return { written: 0, file: null }
    try {
      appendFileSync(file, `${body}\n`)
    } catch (error) {
      return { written: 0, file: null, error: String(error?.message || error) }
    }
    prune(dir, now)
    return { written: samples.length, file }
  })
}
