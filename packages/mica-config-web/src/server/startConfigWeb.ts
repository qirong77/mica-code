import { spawn } from 'node:child_process';
import { createToken, probeConfigWebState, readConfigWebState } from './singleton.js';
import type { ConfigWebServerInfo } from '../shared/types.js';

export async function startConfigWeb(): Promise<ConfigWebServerInfo> {
  const current = readConfigWebState();
  if (current && (await probeConfigWebState(current))) {
    return {
      url: toUrl(current.port, current.token),
      port: current.port,
      token: current.token,
      reused: true,
    };
  }

  const token = createToken();
  const child = spawn(getExecutable(), [...getEntryArgs(), '--config-web-worker', token], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const state = await waitForServer(token);
  return {
    url: toUrl(state.port, state.token),
    port: state.port,
    token: state.token,
    reused: false,
  };
}

async function waitForServer(token: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = readConfigWebState();
    if (state?.token === token && (await probeConfigWebState(state))) return state;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('启动配置页面超时');
}

function toUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

function getExecutable(): string {
  return process.argv[0] || process.execPath;
}

function getEntryArgs(): string[] {
  const entry = process.argv[1];
  if (!entry || entry === process.argv[0]) return [];
  return [entry];
}
