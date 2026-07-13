#!/usr/bin/env bun

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { applyConfigDefaultsToFile } from '../buildin-plugins/validate-config.mjs';

const micaHome = process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : resolve(homedir(), '.mica');
applyConfigDefaultsToFile(resolve(micaHome, 'config.json'));

const [{ createApplication }, { reportRuntimeError }, { startConfigWebServer }, { getConfigWebWorkerToken }] =
  await Promise.all([
    import('./app/index.js'),
    import('./runtime/uiBridge.js'),
    import('@packages/mica-config-web/src/server/server.js'),
    import('@packages/mica-config-web/src/server/workerArgs.js'),
  ]);

const configWebWorkerToken = getConfigWebWorkerToken();
if (configWebWorkerToken) {
  await startConfigWebServer({ token: configWebWorkerToken });
  await new Promise(() => undefined);
}

// Keep the foreground process identifiable as Mica. Dynamic terminal titles
// are emitted from the Ink tree, matching Claude Code's title architecture.
process.title = 'mica';

process.on('uncaughtException', (error) => {
  reportRuntimeError(error, '未捕获异常');
});

process.on('unhandledRejection', (error) => {
  reportRuntimeError(error, '未处理的异步错误');
});

const app = createApplication();

const SIGNAL_EXIT_FORCE_TIMEOUT_MS = 10_000;
let signalExitStarted = false;
let signalExitTimer: ReturnType<typeof setTimeout> | null = null;
const requestSignalExit = (signal: NodeJS.Signals) => {
  const exitCode = signal === 'SIGTERM' ? 143 : signal === 'SIGHUP' ? 129 : 130;
  if (signalExitStarted) {
    process.exit(exitCode);
  }
  signalExitStarted = true;
  signalExitTimer = setTimeout(() => process.exit(exitCode), SIGNAL_EXIT_FORCE_TIMEOUT_MS);
  signalExitTimer.unref?.();
  void app
    .requestExit(exitCode)
    .catch((error) => {
      reportRuntimeError(error, '退出失败');
      process.exit(exitCode);
    })
    .finally(() => {
      if (signalExitTimer) clearTimeout(signalExitTimer);
      signalExitTimer = null;
    });
};

process.once('SIGINT', requestSignalExit);
process.once('SIGTERM', requestSignalExit);
process.once('SIGHUP', requestSignalExit);

await app.start();
await app.waitUntilExit();
await app.stop();
