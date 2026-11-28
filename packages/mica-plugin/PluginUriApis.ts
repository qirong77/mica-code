/**
 * 插件提供给输入框「API 文档」列表的 URI 文档。
 *
 * 这类条目不把工具或整段提示词注入当前 agent；用户选中后，宿主只把 URI
 * 插入草稿，agent 需要时再按文档调用它。
 */

const MAX_NAME = 40;
const MAX_DESCRIPTION = 200;
const MAX_URI = 4096;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

export type PluginUriApi = {
  /** 列表里显示与匹配的名字，不能带空白。 */
  name: string;
  /** 一行说明这份文档提供什么能力。 */
  description: string;
  /** 绝对 URI，或当前运行时同源的根路径（例如 `/plugin/schedule/api`）。 */
  uri: string;
  /** 只在这些角色下出现；空数组表示所有角色。 */
  roles: string[];
};

export type PluginUriApisParseResult = { ok: true; value: PluginUriApi[] } | { ok: false; error: string };

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readRoles(value: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: 'roles 必须是数组' };
  const roles: string[] = [];
  for (const entry of value) {
    const role = readText(entry);
    if (!role) return { ok: false, error: 'roles 里只能放角色名' };
    if (!roles.includes(role)) roles.push(role);
  }
  return { ok: true, value: roles };
}

function isAllowedUri(uri: string): boolean {
  // 同源根路径只认单个前导斜杠：`//host/path` 是协议相对的绝对地址，会被解析到别人的主机上，
  // 不在「本机运行时」这个约定里。
  if (uri.startsWith('/')) return !uri.startsWith('//');
  try {
    const parsed = new URL(uri);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

/** 解析清单的 `uriApis`；坏条目整份拒绝，避免列表里出现点不开的假链接。 */
export function readPluginUriApis(input: unknown): PluginUriApisParseResult {
  if (input === undefined) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'uriApis 必须是数组' };

  const entries: PluginUriApi[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const entry = input[index];
    const where = `uriApis[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `${where} 必须是对象` };
    }
    const source = entry as Record<string, unknown>;
    const name = readText(source.name);
    if (!name) return { ok: false, error: `${where}.name 不能为空` };
    if (/\s/.test(name)) return { ok: false, error: `${where}.name 里不能有空白：${name}` };
    if (name.length > MAX_NAME) return { ok: false, error: `${where}.name 太长（最多 ${MAX_NAME} 字）` };
    if (seen.has(name)) return { ok: false, error: `uriApis 里有两个同名的 ${name}` };
    seen.add(name);

    const uri = readText(source.uri);
    if (!uri) return { ok: false, error: `${where}.uri 不能为空` };
    if (uri.length > MAX_URI) return { ok: false, error: `${where}.uri 太长（最多 ${MAX_URI} 字符）` };
    if (!isAllowedUri(uri)) {
      return { ok: false, error: `${where}.uri 只能是 http(s)、file URI 或同源根路径：${uri}` };
    }

    const description = readText(source.description);
    if (description.length > MAX_DESCRIPTION) {
      return { ok: false, error: `${where}.description 太长（最多 ${MAX_DESCRIPTION} 字）` };
    }
    const roles = readRoles(source.roles);
    if (!roles.ok) return { ok: false, error: `${where}.${roles.error}` };
    entries.push({ name, description, uri, roles: roles.value });
  }
  return { ok: true, value: entries };
}

export function uriApiVisibleToRole(entry: PluginUriApi, role: string): boolean {
  if (!Array.isArray(entry.roles) || entry.roles.length === 0) return true;
  const current = readText(role);
  return Boolean(current) && entry.roles.includes(current);
}
