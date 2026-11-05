import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type PluginData = { target?: { text: string; tone?: 'ok' | 'error' } };

export function readPluginData(dir: string): PluginData {
  try {
    const data = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')) as PluginData;
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

export function updatePluginData(dir: string, patch: PluginData): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'data.json');
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...readPluginData(dir), ...patch })}\n`, { mode: 0o600 });
  renameSync(temp, file);
}
