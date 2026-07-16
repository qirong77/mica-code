import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { micaAgent } from '@packages/mica-agent/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { micaSession } from '@packages/mica-session/index.js';
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

export function getSkillsDetails(): ConfigWebSkillsDetails {
  const root = getSkillsRootPath();
  const skills: Skill[] = existsSync(root) ? micaSkills.reload() : micaSkills.getLoaded();
  return {
    root,
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      argumentHint: skill.argumentHint,
      baseDir: skill.baseDir,
      contentPreview: skill.content.trim().slice(0, 800),
    })),
  };
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

function isPluginFile(fileName: string): boolean {
  return fileName.endsWith('.mjs') || fileName.endsWith('.js');
}
