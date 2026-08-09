import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ConfigWebSyncDetails,
  ConfigWebSyncMachine,
} from '../shared/types.js';

type SyncFile = {
  serverUrl: string;
  machineId?: string;
  name?: string;
};

function syncConfigPath(): string {
  const micaHome = process.env.MICA_HOME ? process.env.MICA_HOME : join(homedir(), '.mica');
  return join(micaHome, 'sync.json');
}

function readSyncFile(): SyncFile | null {
  const path = syncConfigPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SyncFile;
    if (!parsed || typeof parsed.serverUrl !== 'string' || !parsed.serverUrl) return null;
    return {
      serverUrl: parsed.serverUrl,
      machineId: typeof parsed.machineId === 'string' ? parsed.machineId : undefined,
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
    } as SyncFile;
  } catch {
    return null;
  }
}

async function probeServer(serverUrl: string, machineId: string | null): Promise<{
  reachable: boolean;
  machineOnline: boolean;
  machines: ConfigWebSyncMachine[];
}> {
  const base = serverUrl.replace(/\/+$/, '');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${base}/api/machines`, { signal: controller.signal });
      if (!response.ok) return { reachable: false, machineOnline: false, machines: [] };
      const payload = (await response.json()) as { machines?: Array<Record<string, unknown>> };
      const selfHostname = hostname().replace(/\.local$/, '');
      const machines = (payload.machines ?? [])
        .map((machine) => ({
          id: String(machine.id ?? ''),
          name: String(machine.name ?? machine.hostname ?? 'unknown'),
          online: machine.online === true,
          activeSessionId: machine.activeSessionId ? String(machine.activeSessionId) : null,
        }))
        .filter((machine) => machine.id);
      const self = machineId
        ? machines.find((machine) => machine.id === machineId)
        : machines.find((machine) => machine.name === selfHostname);
      return {
        reachable: true,
        machineOnline: self?.online ?? false,
        machines,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { reachable: false, machineOnline: false, machines: [] };
  }
}

export async function getSyncDetails(): Promise<ConfigWebSyncDetails> {
  const config = readSyncFile();
  const path = syncConfigPath();
  if (!config) {
    return {
      configPath: path,
      configured: false,
      serverUrl: '',
      machineId: null,
      name: hostname().replace(/\.local$/, ''),
      serverReachable: false,
      machineOnline: false,
      machines: [],
    };
  }

  const probe = await probeServer(config.serverUrl, config.machineId ?? null);
  return {
    configPath: path,
    configured: true,
    serverUrl: config.serverUrl,
    machineId: config.machineId ?? null,
    name: config.name ?? hostname().replace(/\.local$/, ''),
    serverReachable: probe.reachable,
    machineOnline: probe.machineOnline,
    machines: probe.machines,
  };
}

export async function writeSyncConfig(serverUrl: string, name?: string): Promise<ConfigWebSyncDetails> {
  const normalized = serverUrl.trim().replace(/\/+$/, '');
  if (!normalized) throw new Error('serverUrl is required');
  if (!/^https?:\/\//i.test(normalized)) throw new Error('serverUrl must start with http:// or https://');

  const previous = readSyncFile();
  const next: SyncFile = {
    serverUrl: normalized,
    machineId: previous?.machineId,
    name: name?.trim() || previous?.name || hostname().replace(/\.local$/, ''),
  };
  const path = syncConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');

  // If the machine was already registered under the old URL, keep the same
  // machineId so the identity survives a server URL change.
  return getSyncDetails();
}
