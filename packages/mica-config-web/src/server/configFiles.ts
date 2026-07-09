import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { micaConfig } from '@packages/mica-config/index.js';
import type { ConfigWebFilePayload } from '../shared/types.js';

export function readConfigWebFile(): ConfigWebFilePayload {
  if (!existsSync(micaConfig.path)) micaConfig.read();
  return {
    path: micaConfig.path,
    content: readFileSync(micaConfig.path, 'utf-8'),
  };
}

export function writeConfigWebFile(content: string): ConfigWebFilePayload {
  validateJson(content);
  mkdirSync(dirname(micaConfig.path), { recursive: true });
  writeFileSync(micaConfig.path, normalizeTrailingNewline(content), 'utf-8');
  return readConfigWebFile();
}

function validateJson(content: string): void {
  try {
    JSON.parse(content);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Invalid JSON');
  }
}

function normalizeTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}
