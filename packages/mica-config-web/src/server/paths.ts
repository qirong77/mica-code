import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function getMicaHome(): string {
  return process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : resolve(homedir(), '.mica');
}

export function getConfigWebStatePath(): string {
  return resolve(getMicaHome(), 'config-web.json');
}

export function getSkillsRootPath(): string {
  return resolve(getMicaHome(), 'skills');
}

export function getPluginsRootPath(): string {
  return resolve(getMicaHome(), 'plugins');
}

export function getPluginStatusPath(): string {
  return resolve(getMicaHome(), 'plugin-status.json');
}
