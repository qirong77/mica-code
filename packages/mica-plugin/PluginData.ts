import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';

/** Shared persistence for plugin-owned JSON; not tied to a session or a host. */
export const PLUGIN_DATA_MAX_BYTES = 256 * 1024;
/** Leave room for the RPC envelope within the mobile relay's 8 MiB limit. */
export const PLUGIN_DOCUMENT_MAX_BYTES = 6 * 1024 * 1024;
export const PLUGIN_DATA_FILE = 'data.json';

export type PluginDataReadResult<T = unknown> = { value: T | null; version: string | null };
export type PluginDataWriteOptions = { expectedVersion?: string | null };
export type PluginDataWriteResult =
  | { ok: true; version: string }
  | { ok: false; conflict: true; error: string };
/** The low-level host transport accepts unknown keys and validates before any IO. */
export type PluginDataOptions = PluginDataWriteOptions & { key?: unknown };

export type PluginDataApi = {
  read<T = unknown>(): PluginDataReadResult<T>;
  write(value: unknown, options?: PluginDataWriteOptions): PluginDataWriteResult;
  documents: {
    read<T = unknown>(key: string): PluginDataReadResult<T>;
    write(key: string, value: unknown, options?: PluginDataWriteOptions): PluginDataWriteResult;
  };
};

export function isValidPluginId(pluginId: unknown): pluginId is string {
  const id = typeof pluginId === 'string' ? pluginId.trim() : '';
  return !!id && /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes('..');
}

export function isValidPluginDocumentKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length >= 1 && key.length <= 128 &&
    /^[a-z0-9]/i.test(key) &&
    !/[^a-z0-9._-]/i.test(key) &&
    !key.includes('..')
  );
}

function hasDocumentKey(options: PluginDataOptions): boolean {
  return Object.hasOwn(options ?? {}, 'key');
}

/** Omitted key selects data.json; an explicitly invalid key never falls back to it. */
export function pluginDataPath(home: unknown, pluginId: unknown, options: PluginDataOptions = {}): string | null {
  if (!isValidPluginId(pluginId)) return null;
  const base = typeof home === 'string' ? home.trim() : '';
  if (!base) return null;
  if (hasDocumentKey(options)) {
    if (!isValidPluginDocumentKey(options.key)) return null;
    return join(base, 'plugin-data', pluginId.trim(), 'documents', `${options.key}.json`);
  }
  return join(base, 'plugin-data', pluginId.trim(), PLUGIN_DATA_FILE);
}

export function encodePluginData(
  value: unknown,
  options: PluginDataOptions = {},
): { ok: true; json: string } | { ok: false; error: string } {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    return { ok: false, error: `数据无法序列化为 JSON：${errorMessage(error)}` };
  }
  if (typeof json !== 'string') return { ok: false, error: '数据为空，无法写入' };
  const document = hasDocumentKey(options);
  const maxBytes = document ? PLUGIN_DOCUMENT_MAX_BYTES : PLUGIN_DATA_MAX_BYTES;
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    return {
      ok: false,
      error: document
        ? `插件文档超过 ${maxBytes / (1024 * 1024)} MiB 上限`
        : `插件数据超过 ${Math.round(maxBytes / 1024)} KiB 上限`,
    };
  }
  return { ok: true, json };
}

/** Broken config retains its null semantics; documents must never masquerade as absent. */
export function decodePluginData(raw: unknown, { strict = false } = {}): unknown {
  try {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('文件为空或不是 JSON 文本');
    const parsed: unknown = JSON.parse(raw);
    return parsed === undefined ? null : parsed;
  } catch (error) {
    if (strict) throw new Error(`插件文档 JSON 损坏：${errorMessage(error)}`);
    return null;
  }
}

/** MICA_HOME may itself be a user-selected symlink; descendants must not escape it. */
function assertDocumentPath(file: string): void {
  const documents = dirname(file);
  const plugin = dirname(documents);
  for (const path of [dirname(plugin), plugin, documents, file, `${file}.lock.owners`]) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('插件文档路径非法：不能使用符号链接');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }
}

function dataPath(home: unknown, pluginId: unknown, options: PluginDataOptions): string {
  if (hasDocumentKey(options) && !isValidPluginDocumentKey(options.key)) {
    throw new Error('插件文档 key 非法：须为 1–128 位字母数字与 . _ -，以字母数字开头且不能包含 .. 或路径分隔符');
  }
  const file = pluginDataPath(home, pluginId, options);
  if (!file) throw new Error('插件 id 非法：只能是小写字母、数字与 . _ -，不能带路径分隔符');
  if (hasDocumentKey(options)) assertDocumentPath(file);
  return file;
}

function readFile<T>(file: string, options: PluginDataOptions): PluginDataReadResult<T> {
  try {
    const raw = readFileSync(file, 'utf8');
    return {
      value: decodePluginData(raw, { strict: hasDocumentKey(options) }) as T | null,
      version: createHash('sha256').update(raw).digest('hex'),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { value: null, version: null };
    throw new Error(`读取插件数据失败：${errorMessage(error)}`);
  }
}

/** Versions hash raw file bytes, including the trailing newline; no schema interpretation. */
export function readPluginData<T = unknown>(
  home: unknown, pluginId: unknown, options: PluginDataOptions = {},
): PluginDataReadResult<T> {
  const file = hasDocumentKey(options) ? dataPath(home, pluginId, options) : pluginDataPath(home, pluginId);
  return file ? readFile<T>(file, options) : { value: null, version: null };
}

/** Optional CAS and atomic rename share the same cross-process lock in every host. */
export function writePluginData(
  home: unknown, pluginId: unknown, value: unknown, options: PluginDataOptions = {},
): PluginDataWriteResult {
  const file = dataPath(home, pluginId, options);
  const encoded = encodePluginData(value, options);
  if (!encoded.ok) throw new Error(encoded.error);
  const release = acquireProcessLock(`${file}.lock`);
  if (!release) return { ok: false, conflict: true, error: '插件数据正在保存，请重试' };
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Even without CAS, refuse to overwrite a corrupt document. Config semantics stay unchanged.
    const compareVersion = Object.hasOwn(options, 'expectedVersion');
    const current = hasDocumentKey(options) || compareVersion ? readFile(file, options) : null;
    if (compareVersion && current?.version !== options.expectedVersion) {
      return { ok: false, conflict: true, error: '插件数据已更新，请重新读取后保存' };
    }
    const raw = `${encoded.json}\n`;
    writeFileSync(temp, raw, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, file);
    // Return the committed version under the lock, without a second full-document transfer/read.
    return { ok: true, version: createHash('sha256').update(raw).digest('hex') };
  } catch (error) {
    throw new Error(`写入插件数据失败：${errorMessage(error)}`);
  } finally {
    try {
      rmSync(temp, { force: true });
    } finally {
      release();
    }
  }
}

/** Bind storage to one plugin; callers cannot supply another id or inject a document key. */
export function createPluginDataApi(home: string, pluginId: string): PluginDataApi {
  dataPath(home, pluginId, {});
  const writeOptions = (options: PluginDataWriteOptions = {}): PluginDataWriteOptions =>
    Object.hasOwn(options, 'expectedVersion') ? { expectedVersion: options.expectedVersion } : {};
  return {
    read: <T = unknown>() => readPluginData<T>(home, pluginId),
    write: (value, options) => writePluginData(home, pluginId, value, writeOptions(options)),
    documents: {
      read: <T = unknown>(key: string) => readPluginData<T>(home, pluginId, { key }),
      write: (key, value, options) => writePluginData(home, pluginId, value, { ...writeOptions(options), key }),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
