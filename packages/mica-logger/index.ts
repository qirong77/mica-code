import { clearRuntimeLogs, formatLogEntry, logRuntime, runtimeLogs } from './runtimeLogger.js';

export const micaLogger = {
  logs: runtimeLogs,
  logRuntime,
  clearRuntimeLogs,
  formatLogEntry,
};

export type { RuntimeLogEntry, RuntimeLogLevel } from './runtimeLogger.js';
