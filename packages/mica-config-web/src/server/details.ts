import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { getPluginsRootPath, getPluginStatusPath, getSkillsRootPath } from './paths.js';
import type { McpServerConfig } from '@packages/mica-mcp/index.js';
import type { Skill } from '@packages/mica-skills/index.js';
import type {
  ConfigWebMcpDetails,
  ConfigWebMcpServer,
  ConfigWebPluginsDetails,
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

function readPluginStatusByFile(): Map<string, { status: 'loaded' | 'registered' | 'failed' | 'unknown'; error?: string }> {
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

function describeMcpConfig(name: string, config: McpServerConfig): Omit<ConfigWebMcpServer, 'status' | 'toolCount' | 'tools'> {
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
