import { spawn } from 'node:child_process';
import { probeConfigWebState, readConfigWebState } from './singleton.js';
import type { ConfigWebConversationDetails, ConfigWebServerInfo } from '../shared/types.js';

export async function startConfigWeb(conversation?: ConfigWebConversationDetails): Promise<ConfigWebServerInfo> {
  const current = readConfigWebState();
  if (current && (await probeConfigWebState(current))) {
    const supportsConversation =
      !conversation || (await tryUpdateConversation(current.port, conversation));
    if (supportsConversation) {
      return {
        url: toUrl(current.port),
        port: current.port,
        reused: true,
      };
    }
  }

  const workerCommand = resolveConfigWebWorkerCommand();
  const child = spawn(workerCommand.executable, [...workerCommand.entryArgs, '--config-web-worker'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const state = await waitForServer();
  if (conversation) await updateConfigWebConversation(state.port, conversation);
  return {
    url: toUrl(state.port),
    port: state.port,
    reused: false,
  };
}

async function tryUpdateConversation(
  port: number,
  conversation: ConfigWebConversationDetails,
): Promise<boolean> {
  try {
    await updateConfigWebConversation(port, conversation);
    return true;
  } catch {
    return false;
  }
}

export async function updateConfigWebConversation(
  port: number,
  conversation: ConfigWebConversationDetails,
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/details/conversation`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(conversation),
    signal: AbortSignal.timeout(2_000),
  });
  if (response.ok) return;
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(payload?.error ?? `同步 Conversation 失败: ${response.status}`);
}

async function waitForServer() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = readConfigWebState();
    if (state && (await probeConfigWebState(state))) return state;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('启动配置页面超时');
}

function toUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
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
