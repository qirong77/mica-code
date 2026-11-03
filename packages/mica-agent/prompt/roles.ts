import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import DEFAULT_SYSTEM_PROMPT from './system.md' with { type: 'text' };
import { applyBrandTemplate } from './brandTemplate.js';

export const DEFAULT_ROLE_NAME = 'default';

/**
 * 插件发布的角色索引：`$MICA_HOME/plugin-roles/<pluginId>.json`（写入方在 `mica-plugin`）。
 *
 * 这里只读那一份格式，不依赖插件的代码：输入框的 `/role` 列表在会话进程之外也要能用。
 * 版本对不上就当没有——索引用插件下次加载时会重写。
 */
const PLUGIN_ROLES_DIR = 'plugin-roles';
const PLUGIN_ROLES_VERSION = 1;

export type AgentRole = {
  name: string;
  prompt: string;
  builtIn: boolean;
  path?: string;
  /**
   * 这一段是**追加**在通用系统提示词后面（`<role>` 段），而不是替换 `<system>`。
   * 插件角色都是这种：它们只说自己额外要遵守什么，不必把通用规则再抄一遍。
   */
  append?: boolean;
  /** 来自哪个插件（`user.demand-dev` 这类）；磁盘角色没有这个字段。 */
  pluginId?: string;
};

export function getRolesDirectory(): string {
  const micaHome = resolveMicaHome();
  return join(micaHome, 'role');
}

export function listAgentRoles(): AgentRole[] {
  const roles: AgentRole[] = [defaultRole()];
  const directory = getRolesDirectory();
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [...roles, ...pluginRoles()];

  try {
    const customRoles = readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          extname(entry.name) === '.md' &&
          basename(entry.name, extname(entry.name)) !== DEFAULT_ROLE_NAME,
      )
      .flatMap((entry) => {
        const path = join(directory, entry.name);
        try {
          return [
            {
              name: basename(entry.name, extname(entry.name)),
              prompt: readFileSync(path, 'utf-8'),
              builtIn: false,
              path,
            } satisfies AgentRole,
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    roles.push(...customRoles);
  } catch {
    // Keep the built-in role available when the user role directory cannot be read.
  }

  // 磁盘角色优先：同名的插件角色被遮蔽（用户抄一份出来改，就是以他改的为准）。
  const taken = new Set(roles.map((role) => role.name));
  roles.push(...pluginRoles().filter((role) => !taken.has(role.name)));
  return roles;
}

export function getAgentRole(name: string): AgentRole | undefined {
  const normalizedName = name.trim().replace(/\.md$/i, '');
  if (!normalizedName) return undefined;
  return listAgentRoles().find((role) => role.name === normalizedName);
}

function defaultRole(): AgentRole {
  return {
    name: DEFAULT_ROLE_NAME,
    prompt: applyBrandTemplate(DEFAULT_SYSTEM_PROMPT),
    builtIn: true,
  };
}

/** 插件发布的角色：正文还在插件目录里，索引只给名字与路径。 */
function pluginRoles(): AgentRole[] {
  const directory = join(resolveMicaHome(), PLUGIN_ROLES_DIR);
  if (!existsSync(directory)) return [];

  const roles: AgentRole[] = [];
  const seen = new Set<string>();
  let files: string[] = [];
  try {
    files = readdirSync(directory);
  } catch {
    return [];
  }

  for (const file of files.sort()) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(directory, file), 'utf-8'));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.version !== PLUGIN_ROLES_VERSION || !Array.isArray(parsed.roles)) {
      continue;
    }
    const pluginId = typeof parsed.pluginId === 'string' ? parsed.pluginId.trim() : '';
    for (const entry of parsed.roles) {
      if (!isRecord(entry)) continue;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const path = typeof entry.path === 'string' ? entry.path : '';
      if (!name || name === DEFAULT_ROLE_NAME || !path || seen.has(name)) continue;
      try {
        if (!statSync(path).isFile()) continue;
        roles.push({ name, prompt: readFileSync(path, 'utf-8'), builtIn: false, path, append: true, pluginId });
        seen.add(name);
      } catch {
        // 正文被删掉就跳过：列出来也切不过去。
      }
    }
  }
  return roles;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
