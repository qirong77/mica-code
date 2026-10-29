// 渲染层性能采样落盘：复用 host/log.js 的唯一写入器。
//
// 由 renderer 的 perf-probe.js 每 15 秒按批推送：每秒一个采样点，全量记录不筛选
// （只记"异常"会漏掉用户主观觉得卡、但没越过阈值的时刻，也拿不到卡顿前的上下文）。
//
// 落到 `~/Library/Logs/mica/perf-YYYYMMDD.jsonl`，保留 7 天，重启不丢；
// 一行一个采样点，每批带一条 batch 事件标记批次。
import { ipcMain } from 'electron'
import { logger } from './log.js'

const perfLog = logger('perf')

export function registerPerfIpc() {
  ipcMain.handle('perf:report', (_event, payload = {}) => {
    const samples = Array.isArray(payload?.samples) ? payload.samples : []
    if (samples.length === 0) return { written: 0 }
    perfLog.info('batch', {
      count: samples.length,
      dropped: payload.dropped || 0,
      mode: payload.mode || 'all'
    })
    for (const sample of samples) {
      if (!sample || typeof sample !== 'object') continue
      perfLog.info('sample', sample)
    }
    return { written: samples.length }
  })
}
