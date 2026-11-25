/**
 * 插件改名（2026-11）：`sidecar` → `subagent`，同时把旧的进程内委派插件 `subagent` 改成
 * `subagent-legacy`。两个名字是**同时**换的，所以映射表一次查到位；按顺序套两次会把
 * `sidecar` 的旧数据一路改成 `subagent-legacy`。
 *
 * 会话快照（`../migrations.ts`）与 `$MICA_HOME` 下的插件数据（`./subagent-rename.ts`）
 * 都认这一份表：改名只需要改这里。
 */
const RENAMED_PLUGINS: Record<string, string> = {
  'subagent': 'subagent-legacy',
  'sidecar': 'subagent',
};

/**
 * 旧工具名 → 现在的名字。
 *
 * 不能按前缀换：改名同时把工具面从 11 个收到 4 个（同一件事的不同力度用参数表达），
 * 所以 `sidecar_spawn` / `sidecar_attach` / `sidecar_send` 都落到 `subagent_drive`，
 * `sidecar_status` / `collect` / `turns` / `grep` / `transcript` 都落到 `subagent_inspect`，
 * `sidecar_abort` / `sidecar_close` 都落到 `subagent_stop`。
 */
const RENAMED_TOOLS: Record<string, string> = {
  'sidecar_spawn': 'subagent_drive',
  'sidecar_attach': 'subagent_drive',
  'sidecar_send': 'subagent_drive',
  'sidecar_status': 'subagent_inspect',
  'sidecar_collect': 'subagent_inspect',
  'sidecar_turns': 'subagent_inspect',
  'sidecar_grep': 'subagent_inspect',
  'sidecar_transcript': 'subagent_inspect',
  'sidecar_wait': 'subagent_wait',
  'sidecar_abort': 'subagent_stop',
  'sidecar_close': 'subagent_stop',
  // 改名过程中出现过、但没进过版本的中间名：本机可能在改到一半时写过盘。按名字查表是幂等的，
  // 把它们留在这张表里，任何一处残留都会在下次迁移时收敛到现在的名字。
  'subagent_open': 'subagent_drive',
  'subagent_send': 'subagent_drive',
  'subagent_status': 'subagent_inspect',
  'subagent_collect': 'subagent_inspect',
  'subagent_read': 'subagent_inspect',
};

/** 改名后已不存在的工具：用户的停用选择没有意义了，直接从名单里去掉。 */
const RETIRED_TOOLS = new Set(['session-control']);

/** 插件 id 的新名字；不在改名表里原样返回。 */
export function renamePluginId(id: string): string {
  return RENAMED_PLUGINS[id] ?? id;
}

/** 提示词段键（`plugin:<id>/<sectionId>`）跟着插件 id 走，段名不变。 */
export function renameSectionId(key: string): string {
  const match = /^plugin:([^/]+)\/(.+)$/.exec(key);
  if (!match) return key;
  const previous = match[1]!;
  const next = renamePluginId(previous);
  return next === previous ? key : `plugin:${next}/${match[2]}`;
}

/** 旧工具名换成现在的名字；不在表里原样返回（旧委派插件的 `agent` 就不改）。 */
export function renameToolName(name: string): string {
  return RENAMED_TOOLS[name] ?? name;
}

/**
 * 就地改名一组插件 id（启停名单、`promptControls.disabledPlugins`）。
 *
 * 返回改动的条数。改名后可能撞上名单里已有的 id，去重后写回。
 */
export function renamePluginIdList(list: unknown[]): number {
  const seen = new Set<string>();
  const next: unknown[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const renamed = renamePluginId(item.trim());
    if (!renamed || seen.has(renamed)) continue;
    seen.add(renamed);
    next.push(renamed);
  }
  if (JSON.stringify(next) === JSON.stringify(list)) return 0;
  list.length = 0;
  list.push(...next);
  return 1;
}

/** 就地改名一组工具名，顺便去掉已撤下的工具。返回改动的条数。 */
export function renameToolNameList(list: unknown[]): number {
  const next = [
    ...new Set(
      list
        .map((item) => (typeof item === 'string' ? renameToolName(item.trim()) : item))
        .filter((item) => !(typeof item === 'string' && RETIRED_TOOLS.has(item))),
    ),
  ];
  if (JSON.stringify(next) === JSON.stringify(list)) return 0;
  list.length = 0;
  list.push(...next);
  return 1;
}

/** 就地改名一组技能名：插件随包 skill `sidecar` → `subagent`。返回改动的条数。 */
export function renameSkillNameList(list: unknown[]): number {
  let changed = 0;
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (item !== 'sidecar') continue;
    list[index] = 'subagent';
    changed += 1;
  }
  return changed;
}
