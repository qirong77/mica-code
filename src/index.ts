#!/usr/bin/env bun

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import startConfigWebWorker from '../buildin-plugins/config-web-worker.mjs';
import setupProcessDiagnostics from '../buildin-plugins/process-diagnostics.mjs';
import { applyConfigDefaultsToFile } from '../buildin-plugins/validate-config.mjs';

const micaHome = process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : resolve(homedir(), '.mica');
applyConfigDefaultsToFile(resolve(micaHome, 'config.json'));

if (await startConfigWebWorker()) {
  await new Promise(() => undefined);
}

const [{ createApplication }, { reportRuntimeError }] = await Promise.all([
  import('./app/index.js'),
  import('./runtime/uiBridge.js'),
]);
const processDiagnostics = setupProcessDiagnostics({ reportError: reportRuntimeError });

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

try {
  await app.start();
  await app.waitUntilExit();
  await app.stop();
} finally {
  processDiagnostics.dispose();
}
