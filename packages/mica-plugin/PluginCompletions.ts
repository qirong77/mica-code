/**
 * 插件在输入框 `/` 列表里挂的条目。
 *
 * `/` 只做一件事：往输入框里插一段文本，不执行任何动作。所以插件能声明的也只是「插什么」——
 * 名称、一行说明、插入的正文。它适合放「这个插件带来的几个入口」：认领副本、记一条经验、
 * 看台账……用户不必记住工具名，敲 `/` 就能翻到。
 *
 * 为什么放在清单里而不是运行期注册：补全候选要在**没有会话宿主**的时候也能列出来（刚打开
 * 应用、还没跑过任何一轮）。清单是磁盘上的静态文件，扫一遍就够了，不用为了列几个名字去启动
 * 插件进程。
 */

/** 名称是 `/` 后面那段；光标前的查询按空白截断，所以名字里不能有空白。 */
const MAX_NAME = 40;
const MAX_DESCRIPTION = 200;
const MAX_INSERT = 4000;

export type PluginCompletion = {
  /** `/` 后面显示与匹配的名字，不含 `/`，不能有空白。 */
  name: string;
  /** 说明列：一行讲清它插进来的是干什么的。 */
  description: string;
  /** 选中后插进输入框的正文。 */
  insert: string;
  /** 只在这些角色下出现；空数组表示所有角色。 */
  roles: string[];
};

export type PluginCompletionParseResult =
  | { ok: true; value: PluginCompletion[] }
  | { ok: false; error: string };

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

/**
 * 解析清单的 `completions`。
 *
 * 一条坏条目整份拒绝，而不是悄悄丢掉：少了 `insert`、名字带空格时，用户看到的是「我在 `/`
 * 里找不到它」，插件作者看不到任何提示——清单里的错误必须当场说出来。
 */
export function readPluginCompletions(input: unknown): PluginCompletionParseResult {
  if (input === undefined) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'completions 必须是数组' };

  const completions: PluginCompletion[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < input.length; index += 1) {
    const entry = input[index];
    const where = `completions[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `${where} 必须是对象` };
    }
    const source = entry as Record<string, unknown>;

    const name = readText(source.name);
    if (!name) return { ok: false, error: `${where}.name 不能为空` };
    if (/\s/.test(name)) return { ok: false, error: `${where}.name 里不能有空白：${name}` };
    if (name.length > MAX_NAME) {
      return { ok: false, error: `${where}.name 太长（最多 ${MAX_NAME} 字）` };
    }
    if (seen.has(name)) return { ok: false, error: `completions 里有两个同名的 ${name}` };
    seen.add(name);

    const insert = typeof source.insert === 'string' ? source.insert : '';
    if (!insert.trim()) return { ok: false, error: `${where}.insert 不能为空` };
    if (insert.length > MAX_INSERT) {
      return { ok: false, error: `${where}.insert 太长（最多 ${MAX_INSERT} 字）` };
    }

    const description = readText(source.description);
    if (description.length > MAX_DESCRIPTION) {
      return { ok: false, error: `${where}.description 太长（最多 ${MAX_DESCRIPTION} 字）` };
    }

    const roles = readRoles(source.roles);
    if (!roles.ok) return { ok: false, error: `${where}.${roles.error}` };

    completions.push({ name, description, insert, roles: roles.value });
  }

  return { ok: true, value: completions };
}

/**
 * 这些条目对当前角色是否可见。
 *
 * 与面板、插件 skill 同一条规则：空数组表示所有角色；声明了角色的，只有角色的会话看得到。
 */
export function completionVisibleToRole(completion: PluginCompletion, role: string): boolean {
  if (!Array.isArray(completion.roles) || completion.roles.length === 0) return true;
  const current = readText(role);
  return Boolean(current) && completion.roles.includes(current);
}
