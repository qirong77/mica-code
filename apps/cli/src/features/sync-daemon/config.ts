import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONFIG_DIR_NAME } from '@packages/mica-config/brand.js';

export type DaemonConfig = {
  serverUrl: string;
  machineId?: string;
  name?: string;
};

export function daemonConfigPath(): string {
  const micaHome = process.env.MICA_HOME ? resolveHome(process.env.MICA_HOME) : join(homedir(), CONFIG_DIR_NAME);
  return join(micaHome, 'sync.json');
}

function resolveHome(value: string): string {
  return value === '~' ? join(homedir(), CONFIG_DIR_NAME) : value;
}

export function loadDaemonConfig(): DaemonConfig | null {
  const path = daemonConfigPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<DaemonConfig>;
    if (!parsed.serverUrl) return null;
    return {
      serverUrl: parsed.serverUrl,
      machineId: parsed.machineId,
      name: parsed.name,
    };
  } catch {
    return null;
  }
}

export function saveDaemonConfig(config: DaemonConfig): void {
  const path = daemonConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}
