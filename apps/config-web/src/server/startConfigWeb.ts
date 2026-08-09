import { spawn } from 'node:child_process';
import { probeConfigWebState, readConfigWebState } from './singleton.js';
import { resolveConfigWebAdvertisedUrl, resolveConfigWebBindHost } from './publicUrl.js';
import type { ConfigWebServerInfo } from '../shared/types.js';

export async function startConfigWeb(
  options: { persistent?: boolean } = {},
): Promise<ConfigWebServerInfo> {
  const current = readConfigWebState();
  if (current && (await probeConfigWebState(current))) {
    const expectedHost = resolveWorkerBindHost(options.persistent === true);
    const compatible =
      current.host === expectedHost && (!options.persistent || current.persistent === true);
    if (compatible) {
      return {
        url: toUrl(current.port),
        port: current.port,
        reused: true,
      };
    }
    await stopIncompatibleConfigWeb(current.pid, current.port);
  }

  const workerCommand = resolveConfigWebWorkerCommand();
  const child = spawn(workerCommand.executable, [...workerCommand.entryArgs, '--config-web-worker'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...(options.persistent
        ? { MICA_CONFIG_WEB_PERSIST: '1', MICA_CONFIG_WEB_HOST: '0.0.0.0' }
        : {}),
    },
  });
  child.unref();

  const expectedHost = resolveWorkerBindHost(options.persistent === true);
  const state = await waitForServer(current?.pid, options.persistent === true, expectedHost);
  return {
    url: toUrl(state.port),
    port: state.port,
    reused: false,
  };
}

function resolveWorkerBindHost(persistent: boolean): string {
  if (persistent) return '0.0.0.0';
  return resolveConfigWebBindHost();
}

async function waitForServer(previousPid?: number, persistent = false, expectedHost?: string) {
  const host = expectedHost ?? resolveConfigWebBindHost();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = readConfigWebState();
    if (
      state &&
      state.pid !== previousPid &&
      state.host === host &&
      (!persistent || state.persistent === true) &&
      (await probeConfigWebState(state))
    ) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('启动配置页面超时');
}

async function stopIncompatibleConfigWeb(pid: number, port: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!(await probeConfigWebState({ pid, port }))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The worker exited between the final probe and the signal.
  }
}

function toUrl(port: number): string {
  return resolveConfigWebAdvertisedUrl(port);
}

export function resolveConfigWebWorkerCommand(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): { executable: string; entryArgs: string[] } {
  const executable = execPath;
  const entry = argv[1];
  if (!entry || entry === argv[0] || isBunCompiledVirtualEntry(entry, executable, argv[0])) {
    return { executable, entryArgs: [] };
  }
  return { executable, entryArgs: [entry] };
}

function isBunCompiledVirtualEntry(entry: string, executable: string, argv0: string | undefined): boolean {
  return entry.startsWith('/$bunfs/root/') && executable !== argv0;
}
