import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { micaAgent } from '@packages/mica-agent/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { micaSession } from '@packages/mica-session/index.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { buildConfigWebConversationDetails } from '../conversation.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { getPluginsRootPath, getPluginStatusPath, getSkillsRootPath } from './paths.js';
import type { McpServerConfig } from '@packages/mica-mcp/index.js';
import type { Skill } from '@packages/mica-skills/index.js';
import type {
  ConfigWebMcpDetails,
  ConfigWebMcpServer,
  ConfigWebPluginsDetails,
  ConfigWebRolesDetails,
  ConfigWebSessionDetails,
  ConfigWebSessionsDetails,
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

export async function writeMcpServer(name: string, content: string): Promise<ConfigWebMcpDetails> {
  const normalizedName = normalizeMcpName(name);
  const servers = await micaMcp.loadConfig();
  if (!(normalizedName in servers)) throw new Error(`MCP server not found: ${normalizedName}`);
  servers[normalizedName] = parseMcpServerConfig(content, normalizedName);
  await persistMcpServers(servers);
  return getMcpDetails();
}

export async function createMcpServer(name: string, content = ''): Promise<ConfigWebMcpDetails> {
  const normalizedName = normalizeMcpName(name);
  const servers = await micaMcp.loadConfig();
  if (normalizedName in servers) throw new Error(`MCP server already exists: ${normalizedName}`);
  const configText =
    content.trim() ||
    JSON.stringify(
      {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      },
      null,
      2,
    );
  servers[normalizedName] = parseMcpServerConfig(configText, normalizedName);
  await persistMcpServers(servers);
  return getMcpDetails();
}

export async function deleteMcpServer(name: string): Promise<ConfigWebMcpDetails> {
  const normalizedName = normalizeMcpName(name);
  const servers = await micaMcp.loadConfig();
  if (!(normalizedName in servers)) throw new Error(`MCP server not found: ${normalizedName}`);
  delete servers[normalizedName];
  await persistMcpServers(servers);
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
  micaSkills.reload();
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
  micaSkills.reload();
  return getSkillsDetails();
}

export function deleteSkill(name: string): ConfigWebSkillsDetails {
  const skill = findEditableSkill(name);
  rmSync(skill.baseDir, { recursive: true, force: true });
  micaSkills.reload();
  return getSkillsDetails();
}

export function getPluginsDetails(): ConfigWebPluginsDetails {
  const root = getPluginsRootPath();
  const statusByFile = readPluginStatusByFile();
  const plugins = existsSync(root)
    ? readdirSync(root)
        .filter(isPluginFile)
        .sort()
        .map((fileName) => {
          const file = join(root, fileName);
          const stat = statSync(file);
          const name = basename(fileName, extname(fileName));
          const status = statusByFile.get(file);
          return {
            name,
            id: `file.${name}`,
            file,
            content: readFileSync(file, 'utf-8'),
            extension: extname(fileName),
            sizeBytes: stat.size,
            updatedAt: stat.mtime.toISOString(),
            status: status?.status ?? 'unknown',
            error: status?.error,
          };
        })
    : [];

  return {
    root,
    plugins,
  };
}

export function getSessionsDetails(): ConfigWebSessionsDetails {
  return { root: micaSession.dir, sessions: listRecentSessions() };
}

export function getSessionDetails(id: string): ConfigWebSessionDetails {
  const session = micaSession.createStore().load(id);
  if (!session) throw new Error(`Session not found: ${id}`);
  const role = micaAgent.roles.get(session.snapshot.role);
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
    turnState: session.turnState,
    providerId: session.snapshot.providerId,
    model: session.snapshot.model,
    role: session.snapshot.role,
    content: JSON.stringify(session, null, 2),
    conversation: buildConfigWebConversationDetails(
      {
        providerId: session.snapshot.providerId,
        protocol: session.snapshot.protocol,
        model: session.snapshot.model,
        systemPrompt: role?.prompt ?? '',
        messages: session.snapshot.messages,
      },
      new Date(session.updatedAt),
    ),
  };
}

function listRecentSessions(): ConfigWebSessionsDetails['sessions'] {
  if (!existsSync(micaSession.dir)) return [];
  return readdirSync(micaSession.dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .flatMap((entry) => {
      const id = basename(entry.name, '.json');
      const path = join(micaSession.dir, entry.name);
      try {
        return [{ id, title: readSessionTitle(path) ?? id, updatedAt: statSync(path).mtime.toISOString() }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function readSessionTitle(path: string): string | undefined {
  const handle = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(4096);
    const length = readSync(handle, buffer, 0, buffer.length, 0);
    const match = buffer.toString('utf-8', 0, length).match(/"title"\s*:\s*("(?:\\.|[^"\\])*")/);
    return match ? (JSON.parse(match[1]) as string) : undefined;
  } finally {
    closeSync(handle);
  }
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

export function writeRole(name: string, content: string): ConfigWebRolesDetails {
  const role = micaAgent.roles.get(name);
  if (!role || role.builtIn || !role.path) throw new Error(`Editable role not found: ${name}`);
  if (basename(role.path) !== `${name}.md`) throw new Error('Invalid role path');

  const temporaryPath = `${role.path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, content, 'utf-8');
  renameSync(temporaryPath, role.path);
  return getRolesDetails();
}

export function createRole(name: string, content = ''): ConfigWebRolesDetails {
  const normalizedName = normalizeRoleName(name);
  if (normalizedName === 'default') throw new Error('The default role is built in');

  const directory = micaAgent.roles.directory();
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${normalizedName}.md`);
  writeFileSync(path, content, { encoding: 'utf-8', flag: 'wx' });
  return getRolesDetails();
}

export function deleteRole(name: string): ConfigWebRolesDetails {
  const role = micaAgent.roles.get(name);
  if (!role || role.builtIn || !role.path) throw new Error(`Editable role not found: ${name}`);
  if (basename(role.path) !== `${name}.md`) throw new Error('Invalid role path');
  rmSync(role.path, { force: true });
  return getRolesDetails();
}

function normalizeRoleName(name: string): string {
  const trimmed = name.trim().replace(/\.md$/i, '');
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(trimmed)) {
    throw new Error('Role name may only contain letters, numbers, dots, underscores, and hyphens');
  }
  return trimmed;
}

function readPluginStatusByFile(): Map<
  string,
  { status: 'loaded' | 'registered' | 'failed' | 'unknown'; error?: string }
> {
  const path = getPluginStatusPath();
  if (!existsSync(path)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      plugins?: Array<{ file?: string; status?: string; error?: string }>;
      loadFailed?: Array<{ file?: string; status?: string; error?: string }>;
    };
    return new Map(
      [...(parsed.plugins ?? []), ...(parsed.loadFailed ?? [])]
        .filter((item): item is { file: string; status?: string; error?: string } => typeof item.file === 'string')
        .map((item) => [item.file, { status: normalizePluginStatus(item.status), error: item.error }]),
    );
  } catch {
    return new Map();
  }
}

function normalizePluginStatus(value: string | undefined): 'loaded' | 'registered' | 'failed' | 'unknown' {
  return value === 'loaded' || value === 'registered' || value === 'failed' ? value : 'unknown';
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
      config: JSON.stringify(config, null, 2),
      envKeys: config.headers ? Object.keys(config.headers) : [],
    };
  }

  return {
    name,
    type: 'stdio',
    target: `${config.command} ${(config.args ?? []).join(' ')}`.trim(),
    configPath: micaMcp.configPath,
    config: JSON.stringify(config, null, 2),
    cwd: config.cwd,
    envKeys: config.env ? Object.keys(config.env) : [],
  };
}

async function persistMcpServers(servers: Record<string, McpServerConfig>): Promise<void> {
  const path = micaConfig.path;
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('Invalid config file');
  }
  const next = { ...(current as Record<string, unknown>), mcpServers: servers };
  writeTextFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
}

function parseMcpServerConfig(content: string, name: string): McpServerConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Invalid MCP server JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`MCP server "${name}" must be a JSON object`);
  }
  const server = parsed as Record<string, unknown>;
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
  const skill = micaSkills.reload().find((item) => item.name === normalizedName || basename(item.baseDir) === normalizedName);
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
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string')
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPluginFile(fileName: string): boolean {
  return fileName.endsWith('.mjs') || fileName.endsWith('.js');
}
