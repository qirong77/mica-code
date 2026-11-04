// 桌面运行时的诊断日志入口：实现已经抽到 `@packages/mica-diagnostics`
// （CLI / app-server 也要写同一套日志），这里只剩 Electron 相关的两个通道注册。
//
// 位置、保留策略、级别与慢操作聚合都在包里；本文件只做转发，避免出现第二份实现。
import { flushLogs, logger, snapshot, slowReport, stats } from '@packages/mica-diagnostics/index.js'

export {
  SLOW_MS,
  clearLogs,
  collectMemory,
  flushLogs,
  logger,
  readPerformanceSummary,
  setLogLevel,
  slowReport,
  snapshot,
  startMemorySampler,
  stats
} from '@packages/mica-diagnostics/index.js'

/**
 * 注册诊断查询通道：`diagnostics:snapshot` 返回内存里最近的事件与慢调用统计。
 * 由 server 启动时调用一次；排查时直接 invoke 就能拿现场，不用去翻文件。
 */
export function registerDiagnosticsIpc(ipcMain) {
  ipcMain.handle('diagnostics:snapshot', (_event, options = {}) => {
    const limit = Math.min(Number(options?.limit) || 200, 1000)
    return {
      takenAt: Date.now(),
      stats: stats(),
      slow: slowReport(Math.min(Number(options?.slowLimit) || 30, 200)),
      events: snapshot(limit),
      // 现场的内存分布：host 进程自己一份，页面可以对比 app-server 各自上报的那份
      memory: process.memoryUsage()
    }
  })

  // 渲染层把 console.error / 未捕获异常推过来，和 host 事件落在同一套日志里。
  ipcMain.handle('log:report', (_event, payload = {}) => {
    const entries = Array.isArray(payload?.entries) ? payload.entries : []
    const scope = typeof payload?.scope === 'string' && payload.scope ? payload.scope : 'renderer'
    const log = logger(scope)
    for (const entry of entries.slice(0, 200)) {
      if (!entry || typeof entry !== 'object') continue
      const level = ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info'
      // 时间/级别/来源由宿主决定，页面只补自己的字段（否则能改 `at` 伪造时间线）。
      const { event, level: entryLevel, at, scope: entryScope, ...fields } = entry
      void entryLevel
      void at
      void entryScope
      log[level](String(event || 'log').slice(0, 120), fields)
    }
    return { written: entries.length }
  })

  // 退出前把队列写完（页面关闭、应用退出时都走这一条）。
  process.on('exit', () => flushLogs())
}
