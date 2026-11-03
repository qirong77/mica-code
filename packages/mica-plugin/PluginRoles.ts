import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import { PLUGIN_STATE_FILE, readDisabledPluginIds } from './PluginState.js';

/**
 * 插件自带的「角色」（清单 `roles`）。
 *
 * 角色提示词以前只有 `$MICA_HOME/role/<名字>.md` 一处来源，插件要带自己的角色就得让用户
 * 手工抄一份进去。现在插件在清单里声明 `roles: ["roles"]`（相对插件目录），正文留在插件
 * 里——**编辑插件目录里的文件就是编辑角色**，和 skills 一个待遇。
 *
 * 与角色文件的区别只有一条：插件角色是**追加**在通用系统提示词后面（`<role>` 段），而不是
 * 整段替换 `<system>`。插件角色只该说「这个角色额外要遵守什么」，不必把通用规则再抄一遍。
 *
 * 索引落在 `$MICA_HOME/plugin-roles/<pluginId>.json`：输入框的角色切换与 CLI 的 `/role`
 * 都只扫描索引，不 setup 插件。
 */

export const PLUGIN_ROLES_DIR = 'plugin-roles';

const INDEX_VERSION = 1;
const MAX_ROLES = 40;

export type PublishedPluginRole = {
  pluginId: string;
  name: string;
  /** 角色正文的绝对路径；切换角色只用到名字，打开/编辑用的是它。 */
  path: string;
};

type PluginRolesOptions = {
  configDir?: string;
};

/** 清单里声明的路径 → `{ name, path }`。读不到的一律跳过并给出原因。 */
export function loadManifestRoles(
  root: string,
  dirs: readonly string[],
): { roles: { name: string; path: string }[]; problems: string[] } {
  const roles: { name: string; path: string }[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  const push = (path: string) => {
    const name = roleNameOf(path);
    if (!name || seen.has(name) || roles.length >= MAX_ROLES) return;
    seen.add(name);
    roles.push({ name, path });
  };

  for (const declared of dirs) {
    const target = join(root, declared);
    if (!existsSync(target)) {
      problems.push(`${declared}：路径不存在`);
      continue;
    }
    if (target.toLowerCase().endsWith('.md')) {
      push(target);
      continue;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(target, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .map((entry) => join(target, entry.name));
    } catch {
      problems.push(`${declared}：读不到目录内容`);
      continue;
    }
    if (entries.length === 0) problems.push(`${declared}：下面没有 .md 角色文件`);
    for (const entry of entries.sort()) push(entry);
  }

  return { roles, problems };
}

/** 清单里声明的路径只允许相对插件目录：绝对路径与 `..` 一律拒绝。 */
export function validateRolePaths(value: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'roles 必须是数组' };
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, error: 'roles 里的每一项都必须是非空字符串' };
    }
    const trimmed = item.trim();
    if (isAbsolute(trimmed)) {
      return { ok: false, error: `roles 不能是绝对路径：${trimmed}` };
    }
    const normalized = relative('.', trimmed).replace(/\\/g, '/');
    if (normalized.startsWith('..')) {
      return { ok: false, error: `roles 不能指向插件目录之外：${trimmed}` };
    }
    paths.push(trimmed);
  }
  return { ok: true, value: paths };
}

export function resolvePluginRolesDir(options: PluginRolesOptions = {}): string {
  return join(options.configDir || resolveMicaHome(), PLUGIN_ROLES_DIR);
}

/** 整份重写：插件把某个角色删掉之后，索引里也不该还留着它。传空列表等于删除。 */
export function publishPluginRoles(
  pluginId: string,
  roles: readonly { name: string; path: string }[],
  options: PluginRolesOptions = {},
): string | null {
  const fileName = indexFileName(pluginId);
  if (!fileName) return null;
  const dir = resolvePluginRolesDir(options);
  const path = join(dir, fileName);

  const unique = new Map<string, string>();
  for (const role of roles) {
    const name = String(role?.name ?? '').trim();
    const file = String(role?.path ?? '');
    if (!name || !file || unique.has(name) || !existsSync(file)) continue;
    unique.set(name, file);
  }

  if (unique.size === 0) {
    rmSync(path, { force: true });
    return null;
  }

  mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify(
      {
        version: INDEX_VERSION,
        pluginId,
        roles: [...unique].map(([name, file]) => ({ name, path: file })),
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  renameSync(temporary, path);
  return path;
}

/** 扫描全部插件发布的角色；停用的插件与正文已消失的条目不参与。 */
export function readPublishedPluginRoles(options: PluginRolesOptions = {}): PublishedPluginRole[] {
  const dir = resolvePluginRolesDir(options);
  if (!existsSync(dir)) return [];

  const configDir = options.configDir || resolveMicaHome();
  const disabled = readDisabledPluginIds({ path: join(configDir, PLUGIN_STATE_FILE) });
  const roles: PublishedPluginRole[] = [];
  const seen = new Set<string>();

  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }

  for (const file of files.sort()) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.version !== INDEX_VERSION || !Array.isArray(parsed.roles)) continue;
    const pluginId = typeof parsed.pluginId === 'string' ? parsed.pluginId.trim() : '';
    if (!pluginId || disabled.has(pluginId)) continue;
    for (const entry of parsed.roles) {
      if (!isRecord(entry)) continue;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const path = typeof entry.path === 'string' ? entry.path : '';
      if (!name || !path || seen.has(name) || !existsSync(path)) continue;
      seen.add(name);
      roles.push({ pluginId, name, path });
    }
  }

  return roles;
}

function roleNameOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  return base.toLowerCase().endsWith('.md') ? base.slice(0, -3).trim() : '';
}

function indexFileName(pluginId: string): string {
  const safe = pluginId
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '');
  return safe ? `${safe}.json` : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export const pluginRoleInternals = { roleNameOf, indexFileName, dirname };
