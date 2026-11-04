import { flushLogs, logger, setLogLevel, startMemorySampler } from '@packages/mica-diagnostics/index.js';
import { VERSION_LABEL } from '@packages/mica-config/brand.js';

/**
 * CLI 侧诊断入口：把 TUI / `mica exec` / `mica app-server` 的现场写进和桌面端同一套
 * JSONL（`~/Library/Logs/mica`，保留 7 天）。
 *
 * 这里只做三件事，业务代码不用到处埋点：
 * - 落盘级别：常驻宿主留 info（内存采样要落盘），一次性命令默认只留 warn 以上——
 *   `mica exec` 每次调用都建一个文件并不划算，但真出错时必须留得下原因；
 * - 周期内存采样（常驻宿主）：非主请求也要能回答「这个 1GB 是谁」；
 * - boot / shutdown / 未捕获异常各一条，配合上面的采样定位「什么时候开始涨」。
 */
export interface DiagnosticsHandle {
  /** 进程身份，写进每条内存采样的 `host` 字段。 */
  host: 'app-server' | 'tui' | 'exec';
  log: ReturnType<typeof logger>;
  /** 退出前调用：记一条 shutdown、停采样、把队列刷下去。 */
  stop: (reason?: string) => void;
}

export interface DiagnosticsOptions {
  host: DiagnosticsHandle['host'];
  /** 常驻宿主默认开；一次性命令不用开。 */
  memory?: boolean;
  /** 采样时补充的现场（会话 id、当前轮次…）。抛错不影响采样。 */
  describe?: () => Record<string, unknown> | null | undefined;
  intervalMs?: number;
}

const RESIDENT: DiagnosticsHandle['host'][] = ['app-server', 'tui'];

export function startDiagnostics(options: DiagnosticsOptions): DiagnosticsHandle {
  const resident = RESIDENT.includes(options.host);
  if (!process.env.MICA_LOG_LEVEL) setLogLevel(resident ? 'info' : 'warn');

  const log = logger(options.host);
  log.info('boot', {
    pid: process.pid,
    version: VERSION_LABEL,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    argv: process.argv.slice(2, 6).join(' ').slice(0, 200),
  });

  const stopSampler = options.memory === false ? () => {} : startMemorySampler({
    host: options.host,
    intervalMs: options.intervalMs,
    describe: options.describe,
  });

  let stopped = false;
  return {
    host: options.host,
    log,
    stop: (reason = 'exit') => {
      if (stopped) return;
      stopped = true;
      stopSampler();
      log.info('shutdown', { reason, pid: process.pid });
      flushLogs();
    },
  };
}
