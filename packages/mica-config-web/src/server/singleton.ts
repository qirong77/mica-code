import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfigWebStatePath } from './paths.js';

export type ConfigWebState = {
  pid: number;
  port: number;
};

export function readConfigWebState(): ConfigWebState | null {
  const path = getConfigWebStatePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ConfigWebState;
    if (!parsed.pid || !parsed.port) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeConfigWebState(state: ConfigWebState): void {
  const path = getConfigWebStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

export async function probeConfigWebState(state: ConfigWebState): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/api/ping`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}
