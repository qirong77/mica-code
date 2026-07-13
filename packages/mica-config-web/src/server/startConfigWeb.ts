import { spawn } from 'node:child_process';
import { createToken, probeConfigWebState, readConfigWebState } from './singleton.js';
import type { ConfigWebConversationDetails, ConfigWebServerInfo } from '../shared/types.js';

export async function startConfigWeb(conversation?: ConfigWebConversationDetails): Promise<ConfigWebServerInfo> {
  const current = readConfigWebState();
  if (current && (await probeConfigWebState(current))) {
    const supportsConversation =
      !conversation || (await tryUpdateConversation(current.port, current.token, conversation));
    if (supportsConversation) {
      return {
        url: toUrl(current.port, current.token),
        port: current.port,
        token: current.token,
        reused: true,
      };
    }
  }

  const token = createToken();
  const workerCommand = resolveConfigWebWorkerCommand();
  const child = spawn(workerCommand.executable, [...workerCommand.entryArgs, '--config-web-worker', token], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const state = await waitForServer(token);
  if (conversation) await updateConfigWebConversation(state.port, state.token, conversation);
  return {
    url: toUrl(state.port, state.token),
    port: state.port,
    token: state.token,
    reused: false,
  };
}

async function tryUpdateConversation(
  port: number,
  token: string,
  conversation: ConfigWebConversationDetails,
): Promise<boolean> {
  try {
    await updateConfigWebConversation(port, token, conversation);
    return true;
  } catch {
    return false;
  }
}

export async function updateConfigWebConversation(
  port: number,
  token: string,
  conversation: ConfigWebConversationDetails,
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/details/conversation?token=${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(conversation),
    signal: AbortSignal.timeout(2_000),
  });
  if (response.ok) return;
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(payload?.error ?? `同步 Conversation 失败: ${response.status}`);
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
