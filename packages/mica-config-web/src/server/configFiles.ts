import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { micaConfig } from '@packages/mica-config/index.js';
import { getPluginsRootPath, getSkillsRootPath } from './paths.js';
import type { ConfigWebFilePayload, ConfigWebSection } from '../shared/types.js';

export function readConfigWebFile(section: ConfigWebSection): ConfigWebFilePayload {
  if (section === 'plugins') {
    return {
      section,
      path: getPluginsRootPath(),
      content: '',
      updatedAt: new Date().toISOString(),
    };
  }

  const path = getSectionPath(section);
  ensureFile(section, path);
  if (section === 'mcp') {
    return {
      section,
      path,
      content: `${JSON.stringify(readMcpSlice(path), null, 2)}\n`,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    section,
    path,
    content: readFileSync(path, 'utf-8'),
    updatedAt: new Date().toISOString(),
  };
}

export function writeConfigWebFile(section: ConfigWebSection, content: string): ConfigWebFilePayload {
  if (section === 'plugins') throw new Error('plugins 暂不支持编辑');
  if (section === 'config' || section === 'mcp') validateJson(content);

  const path = getSectionPath(section);
  ensureParentDir(path);
  if (section === 'mcp') {
    writeMcpSlice(path, content);
    return readConfigWebFile(section);
  }
  writeFileSync(path, normalizeTrailingNewline(content), 'utf-8');
  return readConfigWebFile(section);
}

function getSectionPath(section: Exclude<ConfigWebSection, 'plugins'>): string {
  if (section === 'config' || section === 'mcp') return micaConfig.path;
  return resolve(getSkillsRootPath(), 'skills.json');
}

function ensureFile(section: Exclude<ConfigWebSection, 'plugins'>, path: string): void {
  if (existsSync(path)) return;
  ensureParentDir(path);
  if (section === 'skills') {
    writeFileSync(path, `${JSON.stringify(readSkillsIndex(), null, 2)}\n`, 'utf-8');
    return;
  }
  if (section === 'mcp') {
    const current = JSON.parse(readFileSync(micaConfig.path, 'utf-8')) as Record<string, unknown>;
    if (!current.mcpServers) current.mcpServers = {};
    writeFileSync(micaConfig.path, `${JSON.stringify(current, null, 2)}\n`, 'utf-8');
  }
}

function readSkillsIndex(): Array<Record<string, string>> {
  const root = getSkillsRootPath();
  if (!existsSync(root)) return [];
  return statSync(root).isDirectory()
    ? listSkillFiles(root).map((path) => ({ path: relative(root, path) }))
    : [];
}

function listSkillFiles(root: string): string[] {
  const entries: string[] = [];
  try {
    for (const entry of readdirSync(root)) {
      const skillFile = join(root, entry, 'SKILL.md');
      if (existsSync(skillFile)) entries.push(skillFile);
    }
  } catch {
    return entries;
  }
  return entries;
}

function validateJson(content: string): void {
  try {
    JSON.parse(content);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Invalid JSON');
  }
}

function readMcpSlice(path: string): Record<string, unknown> {
  const current = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  return { mcpServers: current.mcpServers ?? {} };
}

function writeMcpSlice(path: string, content: string): void {
  const nextMcp = JSON.parse(content) as Record<string, unknown>;
  const current = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify({ ...current, mcpServers: nextMcp.mcpServers ?? {} }, null, 2)}\n`, 'utf-8');
}

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function normalizeTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}
