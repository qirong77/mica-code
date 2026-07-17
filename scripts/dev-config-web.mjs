#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const preferredPort = process.env.MICA_CONFIG_WEB_PORT?.trim() || '13987';
const statePath = join(process.env.MICA_HOME ?? join(homedir(), '.mica'), 'config-web.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf-8'));
        if (state?.port) {
          const response = await fetch(
            `http://127.0.0.1:${state.port}/api/ping`,
            { signal: AbortSignal.timeout(500) },
          );
          if (response.ok) return state;
        }
      } catch {
        // retry until the worker finishes booting
      }
    }
    await sleep(100);
  }
  throw new Error('Config web dev server failed to start');
}

// Drop any stale singleton pointer so we do not confuse a production worker with this debug server.
if (existsSync(statePath)) {
  try {
    unlinkSync(statePath);
  } catch {
    // ignore
  }
}

const child = spawn(process.execPath, ['src/index.ts', '--config-web-worker'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MICA_CONFIG_WEB_DEV: '1',
    MICA_CONFIG_WEB_PORT: preferredPort,
  },
  stdio: 'inherit',
});

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!child.killed) child.kill('SIGTERM');
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
child.on('exit', (code, signal) => {
  if (shuttingDown) return;
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});

try {
  const state = await waitForReady();
  const url = `http://127.0.0.1:${state.port}`;
  console.log('');
  console.log('Config Web dev server ready (Vite HMR)');
  console.log(`  ${url}`);
  console.log('  Source: packages/mica-config-web/web');
  console.log('  Edit UI files for live reload. Ctrl+C to stop.');
  console.log('');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown(1);
}
