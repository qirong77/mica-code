/**
 * 按会话持久化的插件状态。
 *
 * 在「插件各自往快照里加字段」和「插件没有持久化」之间，这里给第三种选择：快照里有
 * 一个 `pluginState` 映射，键是插件 id，值是插件自己的 JSON。会话笔记是最典型的
 * 用法的——它必须留在对话历史之外，压缩改不到、resume 带得回来，而内核完全不必
 * 知道笔记长什么样。
 *
 * 三条约束，都是为了让插件不能反过来坑内核：
 *
 * 1. 值必须是可 JSON 序列化的普通数据（函数、Map、循环引用一律拒绝）——快照要写盘；
 * 2. 每个插件有独立配额（`MAX_PLUGIN_STATE_BYTES`），单个插件存不下整段对话历史；
 * 3. 内核只做读写与清洗，不对内容做任何解释，字段语义归插件所有。
 */

/** 每个插件在单条会话里的状态上限（序列化后字节数）。 */
export const MAX_PLUGIN_STATE_BYTES = 64 * 1024;

/** 状态映射：插件 id → 插件自己的 JSON 值。 */
export type PluginStateRecord = Record<string, unknown>;

/**
 * 插件看到的状态接口。`pluginId` 在绑定阶段就固定了，插件无法读写别人的状态。
 */
export type PluginSessionStateApi = {
  /** 当前会话里本插件的状态；没写过返回 undefined。 */
  get<T = unknown>(): T | undefined;
  /** 覆盖本插件的状态。超出配额直接抛错，让插件自己知道写不进去。 */
  set(value: unknown): void;
  clear(): void;
};

/**
 * 清洗从磁盘读回来的状态映射。
 *
 * 不做类型纠正：非普通对象、非法值、超配额都当作「这条插件状态不可信」整条丢弃。
 * 插件的状态永远可以重建（笔记丢了就是没写过），但把脏数据塞进 prompt 会一直坏。
 */
export function normalizePluginStateRecord(input: unknown): PluginStateRecord {
  if (!isPlainRecord(input)) return {};
  const result: PluginStateRecord = {};
  for (const [pluginId, value] of Object.entries(input)) {
    if (!pluginId.trim()) continue;
    if (value === undefined) continue;
    if (validatePluginStateValue(value) !== null) continue;
    result[pluginId] = value;
  }
  return result;
}

/** 校验单个值：可序列化且不超配额。返回错误信息，合法时返回 null。 */
export function validatePluginStateValue(value: unknown): string | null {
  if (value === undefined) return null;
  const serialized = serializeState(value);
  if (serialized === null) return 'plugin state must be plain JSON data';
  if (byteLength(serialized) > MAX_PLUGIN_STATE_BYTES) {
    return `plugin state exceeds ${MAX_PLUGIN_STATE_BYTES} bytes`;
  }
  return null;
}

function serializeState(value: unknown): string | null {
  if (!isJsonValue(value, 0)) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 20) return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value as number);
  if (Array.isArray(value)) return value.every((item) => item === undefined || isJsonValue(item, depth + 1));
  if (isPlainRecord(value)) return Object.values(value).every((item) => item === undefined || isJsonValue(item, depth + 1));
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
