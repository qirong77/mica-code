#!/usr/bin/env bun

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import startConfigWebWorker from '../buildin-plugins/config-web-worker.mjs';
import setupProcessDiagnostics from '../buildin-plugins/process-diagnostics.mjs';
import { applyConfigDefaultsToFile } from '../buildin-plugins/validate-config.mjs';
import { CLI_USAGE, parseCliArgs } from './cli/args.js';
import { VERSION } from './buildMeta.js';
import { ensureDaemonRunning } from './daemon/ensureDaemonRunning.js';

if (await startConfigWebWorker()) {
  await new Promise(() => undefined);
}

const invocation = parseCliArgs(process.argv.slice(2));
if (invocation.mode === 'error') {
  console.error(invocation.message);
  process.exit(2);
}
if (invocation.mode === 'help') {
  console.log(CLI_USAGE);
  await exitAfterStdoutFlush(0);
}
if (invocation.mode === 'version') {
  console.log(`mica-code ${VERSION}`);
  await exitAfterStdoutFlush(0);
}

if (invocation.mode === 'run' && invocation.cwd) {
  const cwd = resolve(invocation.cwd);
  try {
    process.chdir(cwd);
    invocation.cwd = cwd;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify({
        type: 'error',
        timestamp: Date.now(),
        part: { type: 'error' },
        error: { name: 'WorkingDirectoryError', data: { message } },
      })}\n`,
    );
    console.error(message);
    await exitAfterStdoutFlush(2);
  }
}

const micaHome = process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : resolve(homedir(), '.mica');
applyConfigDefaultsToFile(resolve(micaHome, 'config.json'));

if (invocation.mode === 'models') {
  const { listRuntimeModelIds } = await import('./cli/modelCatalog.js');
  const models = await listRuntimeModelIds();
  if (invocation.json) {
    const { ensureModelRule, getModelEffortOptions } = await import('@packages/mica-config/index.js');
    const { default: setupModelEffortContext } = await import(
      '../buildin-plugins/model-effort-context/index.mjs'
    );
    const disposeModelEffortContext = setupModelEffortContext();
    try {
      const entries = await Promise.all(
        models.map(async (id) => {
          let efforts: string[] = [];
          try {
            await ensureModelRule(id.split('/').at(-1) ?? id);
            efforts = getModelEffortOptions(id.split('/').at(-1) ?? id);
          } catch {
            // Best-effort: models.dev lookup may be unavailable offline.
          }
          return { id, efforts };
        }),
      );
      process.stdout.write(`${JSON.stringify(entries)}\n`);
    } finally {
      disposeModelEffortContext();
    }
    await exitAfterStdoutFlush(0);
  }
  if (models.length > 0) process.stdout.write(`${models.join('\n')}\n`);
  await exitAfterStdoutFlush(0);
}

if (invocation.mode === 'run') {
  const [{ runHeadless }, { createStdoutRunJsonWriter }] = await Promise.all([
    import('./cli/runHeadless.js'),
    import('@packages/mica-runtime/index.js'),
  ]);
  const writer = createStdoutRunJsonWriter();
  const processDiagnostics = setupProcessDiagnostics({
    reportError: (error: unknown, prefix?: string) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(prefix ? `${prefix}: ${message}` : message);
    },
  });

  const abortController = new AbortController();
  const requestAbort = () => abortController.abort();
  process.once('SIGINT', requestAbort);
  process.once('SIGTERM', requestAbort);
  process.once('SIGHUP', requestAbort);

  try {
    const result = await runHeadless({
      prompt: invocation.prompt,
      sessionId: invocation.sessionId,
      cwd: invocation.cwd,
      model: invocation.model,
      variant: invocation.variant,
      role: invocation.role,
      maxTurns: invocation.maxTurns,
      thinking: invocation.thinking,
      noSave: invocation.noSave,
      mcpConfigPath: invocation.mcpConfigPath,
      strictMcpConfig: invocation.strictMcpConfig,
      mcpInitTimeoutMs: invocation.mcpInitTimeoutMs ?? positiveIntegerEnv('MICA_MCP_INIT_TIMEOUT_MS'),
      writer,
      signal: abortController.signal,
    });
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writer.write({
      type: 'error',
      timestamp: Date.now(),
      part: { type: 'error' },
      error: { name: error instanceof Error ? error.name : 'MicaRuntimeError', data: { message } },
    });
    console.error(message);
    process.exitCode = 1;
  } finally {
    processDiagnostics.dispose();
  }
  await exitAfterStdoutFlush(process.exitCode ?? 0);
}

if (invocation.mode === 'compact') {
  const { runCompact } = await import('./cli/runCompact.js');
  const abortController = new AbortController();
  const requestAbort = () => abortController.abort();
  process.once('SIGINT', requestAbort);
  process.once('SIGTERM', requestAbort);
  process.once('SIGHUP', requestAbort);
  let exitCode = 0;
  try {
    const result = await runCompact({
      sessionId: invocation.sessionId,
      cwd: invocation.cwd,
      force: invocation.force,
      pruneOnly: invocation.pruneOnly,
      signal: abortController.signal,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok && result.code !== 'not_needed') exitCode = 1;
    if (!result.ok && result.error) console.error(result.error);
  } catch (error) {
    exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'error', error: message })}\n`);
    console.error(message);
  }
  await exitAfterStdoutFlush(exitCode);
}

if (invocation.mode === 'commit') {
  const { runCommit } = await import('./cli/runCommit.js');
  const abortController = new AbortController();
  const requestAbort = () => abortController.abort();
  process.once('SIGINT', requestAbort);
  process.once('SIGTERM', requestAbort);
  process.once('SIGHUP', requestAbort);
  let exitCode = 0;
  try {
    const result = await runCommit({
      cwd: invocation.cwd,
      signal: abortController.signal,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) exitCode = 1;
    if (!result.ok && result.error) console.error(result.error);
  } catch (error) {
    exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'error', error: message })}\n`);
    console.error(message);
  }
  await exitAfterStdoutFlush(exitCode);
}

if (invocation.mode === 'daemon') {
  const { runDaemon } = await import('./daemon/index.js');
  await runDaemon({
    server: invocation.server,
    name: invocation.name,
  });
  process.exit(0);
}

const [{ createApplication }, { reportRuntimeError }] = await Promise.all([
  import('./app/index.js'),
  import('./runtime/uiBridge.js'),
]);
const processDiagnostics = setupProcessDiagnostics({ reportError: reportRuntimeError });

const app = createApplication({ sessionId: invocation.mode === 'interactive' ? invocation.sessionId : undefined });

// Every interactive launch makes sure the sync daemon is running (only when a
// sync server is configured), so the web console sees this machine online.
// Best-effort and non-blocking; headless runs and CI can opt out with
// MICA_NO_DAEMON=1.
if (invocation.mode === 'interactive') {
  void ensureDaemonRunning();
}

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

function positiveIntegerEnv(name: string): number | undefined {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function exitAfterStdoutFlush(exitCode: number): Promise<never> {
  await new Promise<void>((done) => {
    if (process.stdout.destroyed || !process.stdout.writable) {
      done();
      return;
    }
    const finish = () => {
      process.stdout.off('error', finish);
      done();
    };
    process.stdout.once('error', finish);
    process.stdout.end(finish);
  });
  process.exit(exitCode);
}
