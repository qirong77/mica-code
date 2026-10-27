/**
 * config.json 的表单模型。
 *
 * 配置页不再是「一个 JSON 编辑器」，而是按字段编辑；这份文件负责把 JSON 与表单之间来回
 * 转换，并且只用纯函数实现，好在没有 DOM 的环境里测：
 *
 * - **不丢字段**：表单只认识 providers 这类已知字段，其余键（mcpServers、
 *   capabilityDefaults，以及任何我们还不认识的字段）原样留在 draft 上写回去。provider 项里
 *   的未知字段同样保留，只覆盖表单管得着的那几个。
 * - **键顺序稳定**：写入前按固定顺序排列已知键，未知键保持原顺序跟在后面，避免每次保存都
 *   把文件重排一遍。
 * - **空值即删键**：可选字段留空时不写 `""`，直接删掉键，保证文件干净、校验也不会因为
 *   空数组报错（`models: []` 不合法）。
 */

export const PROVIDER_PROTOCOL_VALUES = ['openai_chat_completions', 'openai_responses'] as const;
export type ProviderProtocolValue = (typeof PROVIDER_PROTOCOL_VALUES)[number];
export const DEFAULT_PROVIDER_PROTOCOL: ProviderProtocolValue = 'openai_chat_completions';

/** 表单已知的顶层字段，其余一律当「高级字段」原样保留。 */
export const KNOWN_CONFIG_KEYS = ['providers', 'mcpServers', 'capabilityDefaults'] as const;
const CONFIG_KEY_ORDER: readonly string[] = KNOWN_CONFIG_KEYS;
const PROVIDER_KEY_ORDER = [
  'id',
  'name',
  'api_base',
  'api_key',
  'protocol',
  'models',
  'get_model_url',
  // 表单不再编辑这一项（effort 是否发送由模型规则按模型名判定），但保留排序位置，
  // 免得旧配置里已有的值被挪到文件末尾。
  'supportsEffort',
];

export type ConfigDraft = Record<string, unknown>;

export type ProviderDraft = {
  id: string;
  name: string;
  apiBase: string;
  apiKey: string;
  protocol: ProviderProtocolValue;
  models: string[];
  getModelUrl: string;
};

/** `key` 是点分路径（`providers.0.id`），页面按它定位到具体输入框。 */
export type ConfigDraftIssue = { key: string; message: string };

export function parseConfigDraft(text: string): { draft: ConfigDraft | null; error: string | null } {
  if (!text.trim()) return { draft: {}, error: null };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return { draft: null, error: '配置文件的根节点必须是对象' };
    return { draft: parsed, error: null };
  } catch (error) {
    return { draft: null, error: error instanceof Error ? error.message : '不是有效的 JSON' };
  }
}

/** 按固定顺序序列化：已知键在前，其余保持原顺序。 */
export function serializeConfigDraft(draft: ConfigDraft): string {
  return `${JSON.stringify(orderKeys(draft, CONFIG_KEY_ORDER), null, 2)}\n`;
}

export function providerEntries(draft: ConfigDraft): unknown[] {
  return Array.isArray(draft.providers) ? draft.providers : [];
}

export function readProviderDraft(raw: unknown): ProviderDraft {
  const record = isRecord(raw) ? raw : {};
  return {
    id: text(record.id),
    name: text(record.name),
    apiBase: text(record.api_base),
    apiKey: text(record.api_key),
    protocol: isProtocol(record.protocol) ? record.protocol : DEFAULT_PROVIDER_PROTOCOL,
    models: Array.isArray(record.models) ? record.models.filter(isNonEmptyText) : [],
    getModelUrl: text(record.get_model_url),
  };
}

export function writeProviderDraft(draft: ConfigDraft, index: number, fields: ProviderDraft): ConfigDraft {
  const providers = [...providerEntries(draft)];
  providers[index] = buildProviderRecord(providers[index], fields);
  return { ...draft, providers };
}

export function addProviderDraft(draft: ConfigDraft): ConfigDraft {
  const providers = [...providerEntries(draft)];
  providers.push(
    buildProviderRecord(undefined, {
      id: uniqueProviderId(providerEntries(draft)),
      name: '',
      apiBase: '',
      apiKey: '',
      protocol: DEFAULT_PROVIDER_PROTOCOL,
      models: [],
      getModelUrl: '',
    }),
  );
  return { ...draft, providers };
}

export function removeProviderDraft(draft: ConfigDraft, index: number): ConfigDraft {
  return { ...draft, providers: providerEntries(draft).filter((_, current) => current !== index) };
}

/** 表单不管、但文件里存在的顶层键（在「高级字段」里列出来，免得悄悄看不见）。 */
export function extraConfigKeys(draft: ConfigDraft): string[] {
  return Object.keys(draft).filter((key) => !CONFIG_KEY_ORDER.includes(key));
}

export function mcpServerCount(draft: ConfigDraft): number {
  return isRecord(draft.mcpServers) ? Object.keys(draft.mcpServers).length : 0;
}

export function capabilityDefaultsSummary(draft: ConfigDraft): string {
  const defaults = draft.capabilityDefaults;
  if (!isRecord(defaults)) return '全部启用';
  const disabled = ['disabledSkills', 'disabledTools', 'disabledMcpServers'].reduce(
    (sum, key) => sum + (Array.isArray(defaults[key]) ? defaults[key].length : 0),
    0,
  );
  return disabled === 0 ? '全部启用' : `默认关闭 ${disabled} 项`;
}

/**
 * 写盘前的本地校验，`key` 与 `ConfigDraftIssue` 一致。
 *
 * 真正的权威仍是服务端的 `validate-config`（`writeConfigFile` 会跑一遍并把错误抛回来），
 * 这里只求「按字段提示」，不必逐条对齐措辞。
 */
export function validateConfigDraft(draft: ConfigDraft): ConfigDraftIssue[] {
  const issues: ConfigDraftIssue[] = [];
  const providers = draft.providers;

  if (!Array.isArray(providers) || providers.length === 0) {
    issues.push({ key: 'providers', message: '至少需要一个服务商，否则无法发送消息' });
  } else {
    const seen = new Map<string, number>();
    providers.forEach((raw, index) => {
      const base = `providers.${index}`;
      if (!isRecord(raw)) {
        issues.push({ key: base, message: '这一项必须是对象' });
        return;
      }
      const id = text(raw.id).trim();
      if (!id) {
        issues.push({ key: `${base}.id`, message: '标识不能为空' });
      } else if (seen.has(id)) {
        issues.push({ key: `${base}.id`, message: `标识与第 ${(seen.get(id) ?? 0) + 1} 个服务商重复` });
      } else {
        seen.set(id, index);
      }
      if (!isNonEmptyText(raw.api_base)) {
        issues.push({ key: `${base}.api_base`, message: 'API Base 不能为空' });
      }
      if (!isProtocol(raw.protocol)) {
        issues.push({ key: `${base}.protocol`, message: '协议只能是 Chat Completions 或 Responses' });
      }
      if (raw.models !== undefined && !(Array.isArray(raw.models) && raw.models.every(isNonEmptyText))) {
        issues.push({ key: `${base}.models`, message: '模型列表必须是非空字符串' });
      }
      if (raw.get_model_url !== undefined && !isNonEmptyText(raw.get_model_url)) {
        issues.push({ key: `${base}.get_model_url`, message: '必须是地址字符串，或留空' });
      }
      if (raw.supportsEffort !== undefined && typeof raw.supportsEffort !== 'boolean') {
        issues.push({ key: `${base}.supportsEffort`, message: '只能是开或关' });
      }
      if (raw.api_key !== undefined && typeof raw.api_key !== 'string') {
        issues.push({ key: `${base}.api_key`, message: '必须是字符串' });
      }
    });
  }

  return issues;
}

/** 把 issue 列表压成「点分路径 → 文案」，页面按字段取用。 */
export function issueMap(draft: ConfigDraft): Map<string, string> {
  return new Map(validateConfigDraft(draft).map((issue) => [issue.key, issue.message]));
}

function buildProviderRecord(raw: unknown, fields: ProviderDraft): ConfigDraft {
  const next: ConfigDraft = { ...(isRecord(raw) ? raw : {}) };
  const id = fields.id.trim();
  const name = fields.name.trim();
  const apiBase = fields.apiBase.trim();
  const getModelUrl = fields.getModelUrl.trim();

  if (id) next.id = id;
  else delete next.id;
  if (name) next.name = name;
  else delete next.name;
  if (apiBase) next.api_base = apiBase;
  else delete next.api_base;
  // api_key：原本有键就保留（空串表示「显式清空」），原本没有、现在也没填就不写。
  if (fields.apiKey || 'api_key' in next) next.api_key = fields.apiKey;
  next.protocol = fields.protocol;
  // 空数组在 validate-config 里是错误，所以留空就删键。
  if (fields.models.length > 0) next.models = [...fields.models];
  else delete next.models;
  if (getModelUrl) next.get_model_url = getModelUrl;
  else delete next.get_model_url;

  return orderKeys(next, PROVIDER_KEY_ORDER);
}

function uniqueProviderId(providers: unknown[]): string {
  const taken = new Set(providers.map((raw) => (isRecord(raw) ? text(raw.id) : '')));
  if (!taken.has('provider')) return 'provider';
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `provider-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `provider-${Date.now()}`;
}

function orderKeys(record: ConfigDraft, order: readonly string[]): ConfigDraft {
  const ordered: ConfigDraft = {};
  for (const key of order) {
    if (key in record) ordered[key] = record[key];
  }
  for (const [key, value] of Object.entries(record)) {
    if (!order.includes(key)) ordered[key] = value;
  }
  return ordered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isProtocol(value: unknown): value is ProviderProtocolValue {
  return typeof value === 'string' && (PROVIDER_PROTOCOL_VALUES as readonly string[]).includes(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
