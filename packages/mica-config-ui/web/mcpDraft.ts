/**
 * MCP server 列表的表单模型。
 *
 * `config.json` 的 `mcpServers` 是「名称 → 一段配置」：
 *
 *     {
 *       "sequential-thinking": { "command": "npx", "args": ["-y", "…"] },
 *       "browser": { "url": "http://127.0.0.1:${MICA_DESKTOP_PORT}/mcp/browser" }
 *     }
 *
 * 协议只有两种、字段是固定的几个，所以这一页把它摊成一列卡片：一张卡片一个 server。这份
 * 文件负责在「整份 JSON」与「卡片列表」之间来回转换，全部是纯函数，好在没有 DOM 的环境里测：
 *
 * - **只认识固定的键**：本地进程（`command` / `args` / `env` / `cwd` / `stderr`）与 HTTP
 *   （`type` / `url` / `headers`）。其余键（插件写的、将来新增的）原样留在卡片上写回去。
 * - **连接方式看有没有 `url`**（与服务端判定一致）：切换时删掉另一侧的已知键——文件里同时
 *   留着 `command` 与 `url` 的条目自己就说不清是哪种，也会让卡片显示成「不像文件里那样」。
 * - **键顺序稳定**：写入前按固定顺序排列已知键，未知键保持原顺序跟在后头，避免每次保存
 *   都把整段配置重排一遍。
 * - **空值即删键**：可选字段留空时不写 `""`，直接删掉键。
 */

export const MCP_SERVER_TYPE_VALUES = ['stdio', 'http'] as const;
export type McpServerType = (typeof MCP_SERVER_TYPE_VALUES)[number];

const STDIO_KEY_ORDER = ['command', 'args', 'env', 'cwd', 'stderr'] as const;
const HTTP_KEY_ORDER = ['type', 'url', 'headers'] as const;

/** 与服务端 `normalizeMcpName` 同一条规则：写进去之前先在页面上拦住。 */
export const MCP_SERVER_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u;

export type McpServerDraft = Record<string, unknown>;

/** 一个 server：`mcpServers` 里的键、连接方式，以及那段配置本身。 */
export type McpServerEntry = {
  name: string;
  type: McpServerType;
  raw: McpServerDraft;
};

/** 一条「名称 → 值」，用于 env / headers；数组形式才能在表单里逐行编辑。 */
export type McpKeyValue = { key: string; value: string };

export type McpServerFields = {
  type: McpServerType;
  command: string;
  args: string[];
  env: McpKeyValue[];
  cwd: string;
  stderr: string;
  url: string;
  headers: McpKeyValue[];
};

/** `key` 是 `servers.<序号>.<字段>`，页面按它定位到具体输入框。 */
export type McpDraftIssue = { key: string; message: string };

/**
 * 整份 `mcpServers` → 卡片列表。
 *
 * 也接受 `{ "mcpServers": { … } }` 这种外壳（文档里的示例、整份 config.json 的片段都长这样），
 * 只有在它确实是唯一一个键时才拆——否则 `mcpServers` 会被当成一个普通 server 的名字。
 */
export function parseMcpServersDraft(text: string): { entries: McpServerEntry[] | null; error: string | null } {
  if (!text.trim()) return { entries: [], error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { entries: null, error: error instanceof Error ? error.message : '不是有效的 JSON' };
  }
  if (!isRecord(parsed)) return { entries: null, error: 'mcpServers 必须是「名称 → 配置」的 JSON 对象' };

  const keys = Object.keys(parsed);
  const map =
    keys.length === 1 && keys[0] === 'mcpServers' && isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;

  const entries: McpServerEntry[] = [];
  for (const [name, config] of Object.entries(map)) {
    if (!isRecord(config)) return { entries: null, error: `「${name}」的配置必须是 JSON 对象` };
    entries.push({ name, type: draftTypeOf(config), raw: config });
  }
  return { entries, error: null };
}

/** 卡片列表 → 整份 JSON：名称去掉两端空白，没填名称的卡片不写进去（写盘前校验会先拦住）。 */
export function serializeMcpServersDraft(entries: readonly McpServerEntry[]): string {
  const map: Record<string, unknown> = {};
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name) continue;
    map[name] = orderKeys(entry.raw, entry.type === 'http' ? HTTP_KEY_ORDER : STDIO_KEY_ORDER);
  }
  return `${JSON.stringify(map, null, 2)}\n`;
}

/** 打开一张卡片时的连接方式：有 `url` 或显式 `type: 'http'` 就是 HTTP。 */
export function draftTypeOf(draft: McpServerDraft): McpServerType {
  return 'url' in draft || draft.type === 'http' ? 'http' : 'stdio';
}

/** 写盘前的本地校验；权威仍是服务端的解析，这里只求「按字段提示」。 */
export function validateMcpServersDraft(entries: readonly McpServerEntry[]): McpDraftIssue[] {
  const issues: McpDraftIssue[] = [];
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = `servers.${index}`;
    const name = entry.name.trim();
    if (!name) {
      issues.push({ key: `${key}.name`, message: '名称不能为空' });
    } else if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      issues.push({ key: `${key}.name`, message: '名称只能用字母、数字、点、下划线与连字符' });
    } else if (seen.has(name)) {
      issues.push({ key: `${key}.name`, message: `与第 ${(seen.get(name) ?? 0) + 1} 个 server 重名` });
    } else {
      seen.set(name, index);
    }
    issues.push(...validateConfig(entry.raw, entry.type, key));
  });
  return issues;
}

/** 把 issue 列表压成「字段路径 → 文案」，页面按字段取用。 */
export function mcpIssueMap(issues: readonly McpDraftIssue[]): Map<string, string> {
  return new Map(issues.map((issue) => [issue.key, issue.message]));
}

/** 新增一张空卡片：命令 / 地址留空，填上第一个必填项才会写盘。 */
export function addMcpServerEntry(entries: readonly McpServerEntry[]): McpServerEntry[] {
  return [...entries, { name: uniqueServerName(entries), type: 'stdio', raw: {} }];
}

export function removeMcpServerEntry(entries: readonly McpServerEntry[], index: number): McpServerEntry[] {
  return entries.filter((_, current) => current !== index);
}

export function replaceMcpServerEntry(
  entries: readonly McpServerEntry[],
  index: number,
  next: McpServerEntry,
): McpServerEntry[] {
  return entries.map((entry, current) => (current === index ? next : entry));
}

/**
 * 换连接方式：另一侧的已知键直接删掉。
 *
 * 留着它们只会制造「表单里看不到、文件里却有」的字段，或者在切回来时冒出一份早就作废的
 * 旧配置；不确定的东西宁可让用户重填一次。
 */
export function changeMcpServerType(entry: McpServerEntry, type: McpServerType): McpServerEntry {
  if (type === entry.type) return entry;
  const raw = { ...entry.raw };
  for (const key of type === 'http' ? STDIO_KEY_ORDER : HTTP_KEY_ORDER) delete raw[key];
  return { ...entry, type, raw };
}

export function readMcpServerFields(raw: McpServerDraft, type: McpServerType): McpServerFields {
  return {
    type,
    command: text(raw.command),
    args: Array.isArray(raw.args) ? raw.args.filter(isString) : [],
    env: recordPairs(raw.env),
    cwd: text(raw.cwd),
    stderr: text(raw.stderr),
    url: text(raw.url),
    headers: recordPairs(raw.headers),
  };
}

/** 表单写回：只写 `fields.type` 那一侧的键，未知键原样留着。 */
export function writeMcpServerFields(entry: McpServerEntry, fields: McpServerFields): McpServerEntry {
  const base = changeMcpServerType(entry, fields.type);
  const raw: McpServerDraft = { ...base.raw };

  if (fields.type === 'http') {
    setText(raw, 'url', fields.url);
    setRecord(raw, 'headers', fields.headers);
    return { ...base, raw };
  }

  setText(raw, 'command', fields.command);
  const args = fields.args.map((arg) => arg.trim()).filter(Boolean);
  if (args.length > 0) raw.args = args;
  else delete raw.args;
  setRecord(raw, 'env', fields.env);
  setText(raw, 'cwd', fields.cwd);
  setText(raw, 'stderr', fields.stderr);
  return { ...base, raw };
}

function validateConfig(raw: McpServerDraft, type: McpServerType, key: string): McpDraftIssue[] {
  const issues: McpDraftIssue[] = [];
  if (type === 'http') {
    if (!isNonEmptyText(raw.url)) issues.push({ key: `${key}.url`, message: 'HTTP 地址不能为空' });
    if (raw.type !== undefined && raw.type !== 'http') {
      issues.push({ key: `${key}.type`, message: 'HTTP 条目的 type 只能是 http' });
    }
    if (raw.headers !== undefined && !isStringRecord(raw.headers)) {
      issues.push({ key: `${key}.headers`, message: '请求头必须是「名称 → 值」的字符串对' });
    }
    return issues;
  }

  if (!isNonEmptyText(raw.command)) issues.push({ key: `${key}.command`, message: '命令不能为空' });
  if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every(isString))) {
    issues.push({ key: `${key}.args`, message: '参数必须是字符串列表' });
  }
  if (raw.env !== undefined && !isStringRecord(raw.env)) {
    issues.push({ key: `${key}.env`, message: '环境变量必须是「名称 → 值」的字符串对' });
  }
  for (const field of ['cwd', 'stderr'] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') {
      issues.push({ key: `${key}.${field}`, message: '这一项必须是字符串' });
    }
  }
  return issues;
}

function uniqueServerName(entries: readonly McpServerEntry[]): string {
  const taken = new Set(entries.map((entry) => entry.name.trim()));
  if (!taken.has('server')) return 'server';
  for (let index = 2; index < 1000; index += 1) {
    const name = `server-${index}`;
    if (!taken.has(name)) return name;
  }
  return `server-${Date.now()}`;
}

function orderKeys(record: McpServerDraft, order: readonly string[]): McpServerDraft {
  const next: McpServerDraft = {};
  for (const key of order) {
    if (key in record) next[key] = record[key];
  }
  for (const key of Object.keys(record)) {
    if (!(key in next)) next[key] = record[key];
  }
  return next;
}

function setText(target: McpServerDraft, key: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed) target[key] = trimmed;
  else delete target[key];
}

function setRecord(target: McpServerDraft, key: string, pairs: readonly McpKeyValue[]): void {
  const record = pairsToRecord(pairs);
  if (record) target[key] = record;
  else delete target[key];
}

/** 逐行编辑的列表 → 对象。名称留空的行丢弃，重名的以后一行为准。 */
function pairsToRecord(pairs: readonly McpKeyValue[]): Record<string, string> | null {
  const entries = new Map<string, string>();
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    entries.delete(key);
    entries.set(key, pair.value);
  }
  return entries.size > 0 ? Object.fromEntries(entries) : null;
}

function recordPairs(value: unknown): McpKeyValue[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([key, entry]) => ({
    key,
    value: typeof entry === 'string' ? entry : String(entry ?? ''),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
