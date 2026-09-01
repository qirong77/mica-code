import { basename } from 'node:path';
import type { EventEmitter } from 'node:events';
import { RUNTIME_NAME } from '@packages/mica-config/brand.js';

type DiagnosticsProcess = EventEmitter & { title: string };

type ProcessDiagnosticsContext = {
  process?: DiagnosticsProcess;
  reportError?: (error: unknown, prefix?: string) => void;
  title?: string;
};

/** Branded process title with the current working directory base, e.g. `mica/vs-go`. */
export function defaultProcessTitle(cwd: string = process.cwd()): string {
  const base = basename(cwd);
  return base ? `${RUNTIME_NAME}/${base}` : RUNTIME_NAME;
}

/**
 * Installs foreground-process diagnostics without coupling the startup entry to
 * a concrete UI implementation.
 */
export default function setupProcessDiagnostics(ctx: ProcessDiagnosticsContext): { dispose(): void } {
  const runtimeProcess = ctx?.process ?? process;
  const reportError = ctx?.reportError;

  if (typeof reportError !== 'function') {
    throw new Error('process-diagnostics requires ctx.reportError');
  }
  if (typeof runtimeProcess.on !== 'function') {
    throw new Error('process-diagnostics requires an EventEmitter-compatible process');
  }

  runtimeProcess.title = ctx?.title ?? defaultProcessTitle();

  const onUncaughtException = (error: unknown) => {
    reportError(error, '未捕获异常');
  };
  const onUnhandledRejection = (error: unknown) => {
    reportError(error, '未处理的异步错误');
  };

  runtimeProcess.on('uncaughtException', onUncaughtException);
  runtimeProcess.on('unhandledRejection', onUnhandledRejection);

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      removeListener(runtimeProcess, 'uncaughtException', onUncaughtException);
      removeListener(runtimeProcess, 'unhandledRejection', onUnhandledRejection);
    },
  };
}

function removeListener(
  target: DiagnosticsProcess,
  event: string,
  listener: (error: unknown) => void,
): void {
  if (typeof target.off === 'function') {
    target.off(event, listener);
    return;
  }
  target.removeListener?.(event, listener);
}
