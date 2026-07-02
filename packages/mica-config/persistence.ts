import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import defaultConfig from './default.json';
import type { PersistedMicaConfig } from './types.js';

export function readPersistedConfig(configPath: string): PersistedMicaConfig {
  ensureConfigFile(configPath);
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as PersistedMicaConfig;
  } catch {
    backupInvalidConfig(configPath);
    writeDefaultConfig(configPath);
    return defaultConfig as PersistedMicaConfig;
  }
}

export function writePersistedConfig(configPath: string, config: PersistedMicaConfig) {
  ensureConfigDir(configPath);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
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

function backupInvalidConfig(configPath: string) {
  try {
    if (!existsSync(configPath)) return;
    renameSync(configPath, `${configPath}.invalid-${Date.now()}`);
  } catch {
    // If the backup fails, still try to restore a usable default config.
  }
}
