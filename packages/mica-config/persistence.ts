import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import defaultConfig from './default.json';
import type { PersistedMicaConfig } from './types.js';
import { writeTextFileAtomic } from './atomicWrite.js';

export function readPersistedConfig(configPath: string): PersistedMicaConfig {
  ensureConfigFile(configPath);
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as PersistedMicaConfig;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read config ${configPath}: ${detail}`);
  }
}

export function writePersistedConfig(configPath: string, config: PersistedMicaConfig) {
  writeTextFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function ensureConfigFile(configPath: string) {
  if (existsSync(configPath)) return;
  ensureConfigDir(configPath);
  writeDefaultConfig(configPath);
}

function ensureConfigDir(configPath: string) {
  mkdirSync(dirname(configPath), { recursive: true });
}

function writeDefaultConfig(configPath: string) {
  writePersistedConfig(configPath, defaultConfig as PersistedMicaConfig);
}
