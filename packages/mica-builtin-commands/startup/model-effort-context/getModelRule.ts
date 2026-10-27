import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { orderEffortLevels } from '@packages/mica-config/getModelRule.js';
import type { ModelRule } from '@packages/mica-config/types.js';
import { modelsDevSeedBase64 } from './seed/models-dev.seed.js';

const MODELS_URL = 'https://models.dev/api.json';
const CACHE_VERSION = 1;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
type ModelMetadata = {
  id?: string;
  limit?: { context?: number };
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: string[] }>;
  modalities?: { input?: string[] };
};

type ProviderEntry = {
  models?: Record<string, ModelMetadata>;
};

type ModelsPayload = Record<string, ProviderEntry>;

type CacheEntry = {
  version: number;
  fetchedAt: number;
  payload: ModelsPayload;
};

type ModelMatch = { providerId: string; model: ModelMetadata };

type ResolvedRule = Omit<ModelRule, 'name' | 'modelKeysIncludes'>;

let memoryCache: CacheEntry | undefined;
let cacheReadPromise: Promise<CacheEntry | undefined> | undefined;
let refreshPromise: Promise<ModelsPayload> | undefined;
let warnedRefreshFailure = false;
let warnedSyncFallback = false;

/** The bundled models.dev snapshot, decoded once at module load. */
const seedEntry = parseSeedEntry(modelsDevSeedBase64);

/**
 * Look up a model on models.dev and turn its metadata into a mica model rule.
 *
 * A model often occurs under several gateways in api.json.  The first choice is
 * therefore the model author's provider; if that cannot be inferred, the most
 * common definition among exact-name matches is used.
 */
export async function getModelRule(modelName = '', signal?: AbortSignal): Promise<ResolvedRule> {
  const requestedName = modelName.trim();
  if (!requestedName) throw new TypeError('modelName must be a non-empty string');

  let providers = await loadModels(signal);
  let matches = findMatches(providers, requestedName);
  if (matches.length === 0 && providers !== seedEntry.payload) {
    // A disk cache may be stale or miss models that the bundled seed knows
    // about; always fall back to the seed before waiting on the network.
    matches = findMatches(seedEntry.payload, requestedName);
  }
  if (matches.length === 0 && refreshPromise) {
    try {
      providers = await refreshPromise;
    } catch (error) {
      warnSyncFallback(requestedName, error);
      throw error;
    }
    matches = findMatches(providers, requestedName);
  }
  if (matches.length === 0) {
    warnSyncFallback(requestedName);
    throw new Error(`Model not found on models.dev: ${requestedName}`);
  }

  const match = selectMatch(matches, requestedName);
  return buildRule(match, requestedName);
}

/**
 * 同步版：只用已经解码好的快照（内存缓存或随包种子）回答。
 *
 * 启动后到第一次异步解析完成之间、以及任何同步读（`/effort`、desktop 选择器、
 * 请求参数拼装）都要能拿到模型真实档位，不能因为还没 `await` 过就退化成「未知模型」。
 */
export function getSeedModelRule(modelName = '') {
  const requestedName = modelName.trim();
  if (!requestedName) return undefined;
  const providers = memoryCache?.payload ?? seedEntry.payload;
  const matches = findMatches(providers, requestedName);
  if (matches.length === 0) return undefined;
  try {
    return buildRule(selectMatch(matches, requestedName), requestedName);
  } catch {
    return undefined;
  }
}

function buildRule(match: ModelMatch, requestedName: string): ResolvedRule {
  const contextSize = match.model?.limit?.context;
  if (typeof contextSize !== 'number' || !Number.isFinite(contextSize) || contextSize <= 0) {
    throw new Error(`Model has no valid context limit on models.dev: ${requestedName}`);
  }

  const effort = resolveEffortMetadata(match.model);
  return {
    contextSize,
    defaultEffort: chooseDefaultEffort(effort.levels),
    supportsVision: modelSupportsVision(match.model),
    efforts: buildEfforts(effort),
  };
}

/**
 * models.dev annotates every model with a modalities.input list. A model that
 * lists "image" can receive image blocks; anything else is text-only. When the
 * field is missing we stay conservative and assume vision is supported so a
 * text-only model never gets silently mislabeled as capable.
 */
function modelSupportsVision(model: ModelMetadata): boolean {
  const input = model?.modalities?.input;
  return !Array.isArray(input) || input.includes('image');
}

async function loadModels(signal?: AbortSignal): Promise<ModelsPayload> {
  const cached = memoryCache ?? (await readCacheOnce()) ?? seedEntry;
  if (cached) {
    memoryCache = cached;
    if (!isFresh(cached)) {
      void refreshModels(signal).catch(() => warnRefreshFailure(cached));
    }
    return cached.payload;
  }

  return refreshModels(signal);
}

function refreshModels(signal?: AbortSignal): Promise<ModelsPayload> {
  if (refreshPromise) return refreshPromise;

  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const request = fetch(MODELS_URL, { signal: requestSignal }).then(async (response) => {
    if (!response.ok) throw new Error(`models.dev request failed: ${response.status} ${response.statusText}`);
    const payload = (await response.json()) as ModelsPayload;
    if (!isModelsPayload(payload)) throw new Error('models.dev returned an invalid payload');

    const entry: CacheEntry = { version: CACHE_VERSION, fetchedAt: Date.now(), payload };
    memoryCache = entry;
    await writeCacheAtomically(entry).catch(() => undefined);
    return payload;
  });
  refreshPromise = request;

  const clear = () => {
    if (refreshPromise === request) refreshPromise = undefined;
  };
  request.then(clear, clear);
  return request;
}

function readCacheOnce(): Promise<CacheEntry | undefined> {
  cacheReadPromise ??= readCache();
  return cacheReadPromise;
}

async function readCache(): Promise<CacheEntry | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), 'utf8')) as unknown;
    return isCacheEntry(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeCacheAtomically(entry: CacheEntry): Promise<void> {
  const path = cachePath();
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function cachePath(): string {
  const micaHome = resolveMicaHome();
  return resolve(micaHome, 'cache', 'models-dev.json');
}

function isFresh(entry: CacheEntry): boolean {
  const age = Date.now() - entry.fetchedAt;
  return age >= 0 && age < CACHE_TTL_MS;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as CacheEntry).version === CACHE_VERSION &&
    Number.isFinite((value as CacheEntry).fetchedAt) &&
    (value as CacheEntry).fetchedAt > 0 &&
    isModelsPayload((value as CacheEntry).payload)
  );
}

function parseSeedEntry(encoded: string): CacheEntry {
  const entry = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8')) as unknown;
  if (!isCacheEntry(entry)) throw new Error('invalid bundled models.dev seed');
  return entry;
}

function isModelsPayload(value: unknown): value is ModelsPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as ModelsPayload).some(
    (provider) =>
      Boolean(provider) && typeof provider === 'object' && provider.models && typeof provider.models === 'object',
  );
}

/** Test-only reset for the module-level disk/read/refresh state. */
export function __resetModelsCacheForTests(): void {
  memoryCache = undefined;
  cacheReadPromise = undefined;
  refreshPromise = undefined;
  warnedRefreshFailure = false;
  warnedSyncFallback = false;
}

/**
 * Background refresh failed while a stale disk cache or the bundled seed was in
 * use. The request keeps running on stale data; warn once per process so the
 * degraded state is visible instead of silent.
 */
function warnRefreshFailure(cached: CacheEntry): void {
  if (warnedRefreshFailure) return;
  warnedRefreshFailure = true;
  const source = cached === seedEntry ? 'bundled seed' : 'cached';
  console.error(
    `mica: could not refresh model metadata from ${MODELS_URL}; using ${source} data. ` +
      'Model metadata may be stale until models.dev is reachable again.',
  );
}

/**
 * The requested model is in neither the cache nor the seed and the online
 * refresh failed. The caller falls back to a generic rule; warn so the missing
 * metadata (context size, effort options) is not silently assumed.
 */
function warnSyncFallback(modelName: string, error?: unknown): void {
  if (warnedSyncFallback) return;
  warnedSyncFallback = true;
  console.error(
    `mica: model "${modelName}" was not found in the bundled seed or cached models.dev data, ` +
      `and it could not be resolved online (${error instanceof Error ? error.message : String(error)}). ` +
      'Using a generic rule (context 1M, default effort).',
  );
}

function findMatches(providers: ModelsPayload, requestedName: string): ModelMatch[] {
  const basename = requestedName.split('/').at(-1)?.toLowerCase() ?? '';
  const exact: ModelMatch[] = [];
  const basenameMatches: ModelMatch[] = [];

  for (const [providerId, provider] of Object.entries(providers ?? {})) {
    for (const [key, model] of Object.entries(provider?.models ?? {})) {
      const ids = [key, model?.id].filter((value): value is string => typeof value === 'string');
      const candidate = { providerId, model };
      if (ids.some((id) => id.toLowerCase() === requestedName.toLowerCase())) exact.push(candidate);
      if (ids.some((id) => id.split('/').at(-1)?.toLowerCase() === basename)) basenameMatches.push(candidate);
    }
  }

  return exact.length > 0 ? exact : basenameMatches;
}

function selectMatch(matches: ModelMatch[], modelName: string): ModelMatch {
  const owner = inferOwner(modelName);
  const original = owner && matches.find((match) => match.providerId === owner);
  if (original) return original;

  const signatureCounts = new Map<string, number>();
  for (const match of matches) {
    const signature = JSON.stringify({
      context: match.model?.limit?.context,
      reasoning: match.model?.reasoning,
      options: normalizeOptionSignature(match.model?.reasoning_options),
    });
    signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
  }
  return matches.reduce((best, match) =>
    signatureCount(match, signatureCounts) > signatureCount(best, signatureCounts) ? match : best,
  );
}

function inferOwner(modelName: string): string | undefined {
  const name = modelName.toLowerCase();
  if (/(^|\/)gpt-|(^|\/)o[134](?:-|$)/.test(name)) return 'openai';
  if (/(^|\/)grok-/.test(name)) return 'xai';
  if (/(^|\/)(kimi-|moonshot)/.test(name)) return 'moonshotai';
  if (/(^|\/)deepseek-/.test(name)) return 'deepseek';
  if (/(^|\/)claude-/.test(name)) return 'anthropic';
  if (/(^|\/)gemini-/.test(name)) return 'google';
  return undefined;
}

function normalizeOptionSignature(
  options: ModelMetadata['reasoning_options'],
): Array<{ type?: string; values?: string[] }> {
  return (Array.isArray(options) ? options : []).map((option) => ({
    type: option?.type,
    values: Array.isArray(option?.values) ? option.values.map(String).sort() : undefined,
  }));
}

function signatureCount(match: ModelMatch, counts: Map<string, number>): number {
  return (
    counts.get(
      JSON.stringify({
        context: match.model?.limit?.context,
        reasoning: match.model?.reasoning,
        options: normalizeOptionSignature(match.model?.reasoning_options),
      }),
    ) ?? 0
  );
}

type EffortMetadata = {
  /** 模型真实可选的档位名，原样保留 models.dev 的写法。 */
  levels: string[];
  /** models.dev 明确声明为 effort 取值的档位；`none` 可能只是为了开关补上的。 */
  declaredLevels: string[];
  hasEffort: boolean;
  hasToggle: boolean;
};

/**
 * models.dev 的 reasoning 元数据 → 这个模型真实的档位集合。
 *
 * 档位名一律照抄，不做归一化：`max` 就是 `max`，`minimal` 就是 `minimal`。把它们折算
 * 成统一的「五档」等于替模型编造别名，发出去的值未必被服务接受，用户选的也不是那一档。
 *
 * - 声明了 effort 取值：那些就是档位；
 * - 同时声明了 toggle：再补一个 `none`（关掉推理），因为开关本来就能关；
 * - 只有 toggle：这是布尔开关，档位是 `none`（关）与 `on`（开）；
 * - 只有 `reasoning: true` 没给任何控制参数，或不支持推理：没有档位，不发推理参数。
 */
function resolveEffortMetadata(model: ModelMetadata): EffortMetadata {
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
  const effortOption = options.find((option) => option?.type === 'effort');
  const declared = (Array.isArray(effortOption?.values) ? effortOption.values : [])
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
  const hasToggle = options.some((option) => option?.type === 'toggle');
  const hasEffort = Boolean(effortOption) && declared.length > 0;

  if (!hasEffort && !hasToggle) {
    return { levels: [], declaredLevels: [], hasEffort: false, hasToggle: false };
  }

  if (!hasEffort) return { levels: ['none', 'on'], declaredLevels: [], hasEffort: false, hasToggle: true };
  const levels = new Set(declared);
  if (hasToggle) levels.add('none');
  return { levels: orderEffortLevels(levels), declaredLevels: declared, hasEffort: true, hasToggle };
}

/**
 * 每个档位同时为两种协议生成补丁，且只取决于模型自己怎么说。
 *
 * 不能按 models.dev 的 providerId 猜协议、把补丁只挂在那一个协议上：用户完全可能把
 * 同一个模型挂在另一种协议下（例如把 DeepSeek 挂在 `openai_responses`），那样最高档
 * 就会以错误的字段名发出去，该关掉的 thinking 也关不掉。
 */
function buildEfforts(meta: EffortMetadata): ModelRule['efforts'] {
  const efforts: ModelRule['efforts'] = {};
  const declared = new Set(meta.declaredLevels);
  for (const level of meta.levels) {
    const rule: NonNullable<ModelRule['efforts'][string]> = {};
    if (declared.has(level)) {
      rule.openai_responses = { reasoning: { effort: level } };
      rule.openai_chat_completions = {
        ...(meta.hasToggle ? { thinking: { type: level === 'none' ? 'disabled' : 'enabled' } } : {}),
        reasoning_effort: level,
      };
    } else if (meta.hasToggle) {
      // 开关补出来的 `none` / `on` 不是模型声明的 effort 取值：只发开关，不发 effort 字段。
      // 布尔开关在 Responses 协议下没有等价参数，该协议就没有这一档（列出来也发不出去）。
      rule.openai_chat_completions = { thinking: { type: level === 'none' ? 'disabled' : 'enabled' } };
    }
    efforts[level] = rule;
  }
  return efforts;
}

/**
 * 默认档位：开关模型默认开着（服务端本来就在推理），其余优先中等、其次高档。
 *
 * 两档都没有时取声明里最省的一档，而不是最强的一档——换到只声明 `xhigh` / `max` 的模型
 * 时，代价最大的那个档不该成为默认值。
 */
function chooseDefaultEffort(levels: string[]): ModelRule['defaultEffort'] {
  if (levels.includes('on')) return 'on';
  if (levels.includes('medium')) return 'medium';
  if (levels.includes('high')) return 'high';
  return levels[0] ?? 'none';
}
