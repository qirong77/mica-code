import { hostname } from 'node:os';
import { loadKnownMachines, loadRelayRegistration, remoteStateDir } from '@packages/mica-remote-protocol/localState.js';
import type { RemoteCliInvocation } from '../cli/args.js';
import { RemoteController, type RemoteMachineView } from './controller.js';
import { normalizeRelayUrl } from './relayUrl.js';
import { startRemoteWorker } from './worker.js';

export async function runRemote(invocation: RemoteCliInvocation): Promise<number> {
  try {
    switch (invocation.command) {
      case 'serve':
        return await runServe(invocation);
      case 'pair':
        return await runPair(invocation);
      case 'list':
        return await runList(invocation);
      case 'history':
        return await runHistory(invocation);
      case 'status':
        return await runStatus(invocation);
      case 'revoke':
        return await runRevoke(invocation);
      default:
        console.error('unknown remote command');
        return 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}

async function runServe(invocation: RemoteCliInvocation): Promise<number> {
  if (!invocation.relay) throw new Error('serve 缺少 --relay <url>');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const worker = await startRemoteWorker({
      relay: invocation.relay,
      invite: invocation.invite,
      name: invocation.name,
      workspaces: invocation.workspaces,
      signal: controller.signal,
    });
    await new Promise<void>((resolvePromise) => {
      if (controller.signal.aborted) resolvePromise();
      else controller.signal.addEventListener('abort', () => resolvePromise(), { once: true });
    });
    worker.stop();
    process.stdout.write('已停止远程服务\n');
    return 0;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function runPair(invocation: RemoteCliInvocation): Promise<number> {
  if (!invocation.code) throw new Error('pair 缺少配对码');
  const relay = requireRelay(invocation);
  const controller = await RemoteController.open({
    relay,
    invite: invocation.invite,
    name: invocation.name ?? hostname(),
  });
  try {
    const machine = await controller.pair(invocation.code);
    if (invocation.json) {
      process.stdout.write(`${JSON.stringify(machine, null, 2)}\n`);
    } else {
      process.stdout.write(`已配对执行机 ${machine.alias}\n`);
      process.stdout.write(`  id: ${machine.machineId}\n`);
      process.stdout.write(`  指纹: ${machine.fingerprint}\n`);
      process.stdout.write(`  授权: ${machine.permissions.join(', ')}\n`);
    }
    return 0;
  } finally {
    controller.close();
  }
}

async function runList(invocation: RemoteCliInvocation): Promise<number> {
  const relay = requireRelay(invocation);
  const controller = await RemoteController.open({
    relay,
    invite: invocation.invite,
    name: invocation.name ?? hostname(),
  });
  try {
    const machines = await controller.list();
    if (invocation.json) {
      process.stdout.write(`${JSON.stringify({ deviceId: controller.deviceId, machines }, null, 2)}\n`);
      return 0;
    }
    if (machines.length === 0) {
      process.stdout.write(
        '还没有配对任何执行机。请在执行机上运行 `mica remote serve`，再用配对码执行 `mica remote pair`。\n',
      );
      return 0;
    }
    process.stdout.write(`本机控制端: ${controller.deviceId}\n\n`);
    for (const machine of machines) {
      process.stdout.write(formatMachine(machine));
    }
    return 0;
  } finally {
    controller.close();
  }
}

async function runHistory(invocation: RemoteCliInvocation): Promise<number> {
  if (!invocation.sessionRef) throw new Error('history 缺少 sessionRef');
  const relay = requireRelay(invocation);
  const known = loadKnownMachines();
  const machineId = invocation.machine ?? (known.length === 1 ? known[0]!.machineId : undefined);
  if (!machineId) {
    throw new Error(
      known.length === 0
        ? '还没有配对任何执行机'
        : `请用 --machine <id> 指定执行机: ${known.map((item) => item.machineId).join(', ')}`,
    );
  }
  const controller = await RemoteController.open({
    relay,
    invite: invocation.invite,
    name: invocation.name ?? hostname(),
  });
  try {
    const page = await controller.history(machineId, invocation.sessionRef, {
      ...(invocation.cursor !== undefined ? { cursor: invocation.cursor } : {}),
      ...(invocation.limit !== undefined ? { limit: invocation.limit } : {}),
    });
    if (invocation.json) {
      process.stdout.write(`${JSON.stringify(page, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`会话 ${page.sessionRef} · ${page.asOf}\n`);
    if (page.messages.length === 0) {
      process.stdout.write('（这一页没有可显示的消息）\n');
    }
    for (const message of page.messages) {
      const label = message.role === 'user' ? '你' : 'Mica';
      process.stdout.write(`\n[${label}]\n${message.text}\n`);
      if (message.truncated) process.stdout.write('（本条已截断）\n');
    }
    if (page.nextCursor) {
      process.stdout.write(`\n更早的消息: --cursor ${page.nextCursor}\n`);
    }
    return 0;
  } finally {
    controller.close();
  }
}

async function runRevoke(invocation: RemoteCliInvocation): Promise<number> {
  if (!invocation.machine) throw new Error('revoke 缺少 machineId');
  const relay = requireRelay(invocation);
  const controller = await RemoteController.open({
    relay,
    invite: invocation.invite,
    name: invocation.name ?? hostname(),
  });
  try {
    await controller.revoke(invocation.machine);
    if (invocation.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, machineId: invocation.machine }, null, 2)}\n`);
    } else {
      process.stdout.write(`已撤销对 ${invocation.machine} 的授权\n`);
    }
    return 0;
  } finally {
    controller.close();
  }
}

async function runStatus(invocation: RemoteCliInvocation): Promise<number> {
  const stored = loadRelayRegistration();
  const relay = invocation.relay ?? stored?.url;
  if (!relay) throw new Error('还没有配置中转机：先执行 `mica remote pair` 或 `mica remote serve`');
  const { httpUrl } = normalizeRelayUrl(relay);
  const response = await fetch(`${httpUrl}/api/health`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`中转机健康检查失败: ${response.status}`);
  const health = (await response.json()) as {
    ok: boolean;
    online: number;
    devices: number;
    pairings: number;
    version: string;
  };
  const known = loadKnownMachines();
  if (invocation.json) {
    process.stdout.write(
      `${JSON.stringify({ relay: httpUrl, deviceId: stored?.deviceId ?? null, health, machines: known }, null, 2)}\n`,
    );
    return 0;
  }
  process.stdout.write(`中转机: ${httpUrl}\n`);
  process.stdout.write(
    `状态: ${health.ok ? '可达' : '异常'} · ${health.devices} 台设备 · ${health.online} 在线 · ${health.pairings} 组授权\n`,
  );
  process.stdout.write(`本机设备: ${stored?.deviceId ?? '未注册'}\n`);
  if (known.length === 0) {
    process.stdout.write('已配对执行机: 无\n');
  } else {
    process.stdout.write(`已配对执行机: ${known.map((item) => `${item.alias} (${item.machineId})`).join(', ')}\n`);
  }
  process.stdout.write(`本地状态目录: ${remoteStateDir()}\n`);
  return 0;
}

function requireRelay(invocation: RemoteCliInvocation): string {
  const relay = invocation.relay ?? loadRelayRegistration()?.url;
  if (!relay) throw new Error('缺少 --relay <url>，且本机还没有注册过中转机');
  return relay;
}

function formatMachine(machine: RemoteMachineView): string {
  const lines: string[] = [];
  const state = machine.online ? '在线' : '离线';
  const suffix = machine.asOf
    ? `最后同步 ${formatAge(machine.asOf)}${machine.cached ? '（缓存）' : ''}`
    : '尚未发布目录';
  lines.push(`${machine.alias}  ${machine.machineId}  [${state} · ${suffix}]`);
  if (machine.workspaces.length === 0) {
    lines.push('  （没有可用的工作区）');
  }
  for (const workspace of machine.workspaces) {
    lines.push(`  ${workspace.alias}  ${workspace.workspaceRef}`);
    if (workspace.sessions.length === 0) {
      lines.push('    （没有会话）');
    }
    for (const session of workspace.sessions) {
      const alias = session.alias ?? '（未命名会话）';
      lines.push(`    ${session.sessionRef}  ${alias}  · ${session.turnState} · ${formatAge(session.updatedAt)}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function formatAge(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86_400)} 天前`;
}
