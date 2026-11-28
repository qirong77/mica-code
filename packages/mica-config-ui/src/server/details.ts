import { isRecord } from '@packages/mica-common/guards.js';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { micaAgent } from '@packages/mica-agent/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { getSkillsRootPath } from './paths.js';
import type { McpServerConfig } from '@packages/mica-mcp/index.js';
import type { Skill } from '@packages/mica-skills/index.js';
import type {
  ConfigWebMcpDetails,
  ConfigWebMcpServer,
  ConfigWebRolesDetails,
  ConfigWebSkillsDetails,
} from '../shared/types.js';

let mcpInitialized = false;

export async function getMcpDetails(): Promise<ConfigWebMcpDetails> {
  if (!mcpInitialized) {
    mcpInitialized = true;
    await micaMcp.init().catch(() => undefined);
  }

  const configured = await micaMcp.loadConfig();
  const statuses = micaMcp.servers.get();
  const statusByName = new Map(statuses.map((status) => [status.name, status]));

  return {
    path: micaMcp.configPath,
    content: readMcpServersText(),
    servers: Object.entries(configured).map(([name, config]) => {
      const status = statusByName.get(name);
      return {
        ...describeMcpConfig(name, config),
        status: status?.status ?? 'configured',
        toolCount: status?.toolCount ?? 0,
        tools: (status?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description })),
        error: status?.error,
      } satisfies ConfigWebMcpServer;
    }),
  };
}

/**
 * 整份写回 `mcpServers`。
 *
 * 页面上是一列卡片，保存时一次写完整份：逐条写会把「改个名字」「删掉一个」拆成两次请求，
 * 中间那份半成品也可能被别的读者看到。名称与每段配置都过一遍与单条写回相同的解析，
 * 出错时页面按卡片提示。
 */
export async function writeMcpServers(content: string): Promise<ConfigWebMcpDetails> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'mcpServers 不是有效的 JSON');
  }
  if (!isRecord(parsed)) throw new Error('mcpServers must be a JSON object');

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(parsed)) {
    const normalizedName = normalizeMcpName(name);
    if (normalizedName in servers) throw new Error(`Duplicate MCP server: ${normalizedName}`);
    servers[normalizedName] = validateMcpServer(config, normalizedName);
  }
  persistMcpServers(servers);
  return getMcpDetails();
}

export function getSkillsDetails(): ConfigWebSkillsDetails {
  const root = getSkillsRootPath();
  const skills: Skill[] = micaSkills.reload();
  return {
    root,
    skills: skills.map((skill) => {
      const skillFile = join(skill.baseDir, 'SKILL.md');
      const content = existsSync(skillFile) ? readFileSync(skillFile, 'utf-8') : skill.content;
      return {
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        argumentHint: skill.argumentHint,
        baseDir: skill.baseDir,
        content,
        editable: isPathInside(skill.baseDir, root),
      };
    }),
  };
}

export function writeSkill(name: string, content: string): ConfigWebSkillsDetails {
  const skill = findEditableSkill(name);
  const skillFile = join(skill.baseDir, 'SKILL.md');
  writeTextFileAtomic(skillFile, content);
  return getSkillsDetails();
}

export function createSkill(name: string, content = ''): ConfigWebSkillsDetails {
  const normalizedName = normalizeSkillName(name);
  const root = getSkillsRootPath();
  mkdirSync(root, { recursive: true });
  const baseDir = join(root, normalizedName);
  if (existsSync(baseDir)) throw new Error(`Skill already exists: ${normalizedName}`);
  mkdirSync(baseDir, { recursive: true });
  const skillContent =
    content.trim() ||
    `---
name: ${normalizedName}
description: ${normalizedName}
---

# ${normalizedName}

Describe how to use this skill.
`;
  writeTextFileAtomic(join(baseDir, 'SKILL.md'), skillContent);
  return getSkillsDetails();
}

export function deleteSkill(name: string): ConfigWebSkillsDetails {
  const skill = findEditableSkill(name);
  rmSync(skill.baseDir, { recursive: true, force: true });
  return getSkillsDetails();
}

export function getRolesDetails(): ConfigWebRolesDetails {
  return {
    root: micaAgent.roles.directory(),
    roles: micaAgent.roles.list().map((role) => ({
      name: role.name,
      content: role.prompt,
      builtIn: role.builtIn,
      path: role.path,
    })),
  };
}

function editableRolePath(name: string): string {
  const normalizedName = normalizeRoleName(name);
  const role = micaAgent.roles.get(normalizedName);
  if (!role || role.builtIn || !role.path) throw new Error(`Editable role not found: ${name}`);
  if (basename(role.path) !== `${normalizedName}.md`) throw new Error('Invalid role path');
  return role.path;
}

export function writeRole(name: string, content: string): ConfigWebRolesDetails {
  writeTextFileAtomic(editableRolePath(name), content);
  return getRolesDetails();
}

export function createRole(name: string, content = ''): ConfigWebRolesDetails {
  const normalizedName = normalizeRoleName(name);

  const directory = micaAgent.roles.directory();
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${normalizedName}.md`);
  writeFileSync(path, content, { encoding: 'utf-8', flag: 'wx' });
  return getRolesDetails();
}

export function deleteRole(name: string): ConfigWebRolesDetails {
  rmSync(editableRolePath(name), { force: true });
  return getRolesDetails();
}

function normalizeRoleName(name: string): string {
  const trimmed = name.trim().replace(/\.md$/i, '');
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(trimmed)) {
    throw new Error('Role name may only contain letters, numbers, dots, underscores, and hyphens');
  }
  if (/^default(?:\.md)*$/i.test(trimmed)) throw new Error('The default system prompt is read-only');
  return trimmed;
}

function describeMcpConfig(
  name: string,
  config: McpServerConfig,
): Omit<ConfigWebMcpServer, 'status' | 'toolCount' | 'tools'> {
  if ('url' in config) {
    return {
      name,
      type: 'http',
      target: config.url,
      configPath: micaMcp.configPath,
      envKeys: config.headers ? Object.keys(config.headers) : [],
    };
  }

  return {
    name,
    type: 'stdio',
    target: `${config.command} ${(config.args ?? []).join(' ')}`.trim(),
    configPath: micaMcp.configPath,
    cwd: config.cwd,
    envKeys: config.env ? Object.keys(config.env) : [],
  };
}

/**
 * 文件里的 `mcpServers` 原文。
 *
 * 不能用 `micaMcp.loadConfig()` 拼：它在读取时会把 url / headers 里的 `${VAR}` 展开成当前
 * 运行时端口，页面照着它写回去就把占位符永久换成了这一台机器的端口。
 */
function readMcpServersText(): string {
  try {
    const current: unknown = JSON.parse(readFileSync(micaConfig.path, 'utf-8'));
    const servers = isRecord(current) ? current.mcpServers : undefined;
    if (!isRecord(servers)) return '{}\n';
    return `${JSON.stringify(servers, null, 2)}\n`;
  } catch {
    return '{}\n';
  }
}

function persistMcpServers(servers: Record<string, McpServerConfig>): void {
  const path = micaConfig.path;
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
  if (!isRecord(current)) throw new Error('Invalid config file');
  const next = { ...current, mcpServers: servers };
  writeTextFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
}

function validateMcpServer(server: unknown, name: string): McpServerConfig {
  if (!isRecord(server)) throw new Error(`MCP server "${name}" must be a JSON object`);
  if ('url' in server) {
    if (typeof server.url !== 'string' || !server.url.trim()) {
      throw new Error(`MCP server "${name}" url must be a non-empty string`);
    }
    if (server.type !== undefined && server.type !== 'http') {
      throw new Error(`MCP server "${name}" type must be http`);
    }
    if (server.headers !== undefined && !isStringRecord(server.headers)) {
      throw new Error(`MCP server "${name}" headers must be a string record`);
    }
    return server as unknown as McpServerConfig;
  }
  if (typeof server.command !== 'string' || !server.command.trim()) {
    throw new Error(`MCP server "${name}" command must be a non-empty string`);
  }
  if (server.args !== undefined && !isStringArray(server.args)) {
    throw new Error(`MCP server "${name}" args must be a string array`);
  }
  if (server.env !== undefined && !isStringRecord(server.env)) {
    throw new Error(`MCP server "${name}" env must be a string record`);
  }
  for (const field of ['stderr', 'cwd'] as const) {
    if (server[field] !== undefined && typeof server[field] !== 'string') {
      throw new Error(`MCP server "${name}" ${field} must be a string`);
    }
  }
  return server as unknown as McpServerConfig;
}

function findEditableSkill(name: string): Skill {
  const normalizedName = normalizeSkillName(name);
  const root = getSkillsRootPath();
  const skill = micaSkills
    .reload()
    .find((item) => item.name === normalizedName || basename(item.baseDir) === normalizedName);
  if (!skill) throw new Error(`Skill not found: ${normalizedName}`);
  if (!isPathInside(skill.baseDir, root)) throw new Error(`Skill is not editable: ${normalizedName}`);
  return skill;
}

function normalizeMcpName(name: string): string {
  const trimmed = name.trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(trimmed)) {
    throw new Error('MCP name may only contain letters, numbers, dots, underscores, and hyphens');
  }
  return trimmed;
}

function normalizeSkillName(name: string): string {
  const trimmed = name.trim().replace(/\/+$/, '');
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(trimmed)) {
    throw new Error('Skill name may only contain letters, numbers, dots, underscores, and hyphens');
  }
  return trimmed;
}

function writeTextFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, content, 'utf-8');
  renameSync(temporaryPath, path);
}

function isPathInside(target: string, root: string): boolean {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${sep}`);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

