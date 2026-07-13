/**
 * Installs foreground-process diagnostics without coupling the startup entry to
 * a concrete UI implementation.
 */
export default function setupProcessDiagnostics(ctx) {
  const runtimeProcess = ctx?.process ?? process;
  const reportError = ctx?.reportError;

  if (typeof reportError !== 'function') {
    throw new Error('process-diagnostics requires ctx.reportError');
  }
  if (typeof runtimeProcess.on !== 'function') {
    throw new Error('process-diagnostics requires an EventEmitter-compatible process');
  }

  runtimeProcess.title = ctx?.title ?? 'mica';

  const onUncaughtException = (error) => {
    reportError(error, '未捕获异常');
  };
  const onUnhandledRejection = (error) => {
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

function removeListener(target, event, listener) {
  if (typeof target.off === 'function') {
    target.off(event, listener);
    return;
  }
  target.removeListener?.(event, listener);
}
