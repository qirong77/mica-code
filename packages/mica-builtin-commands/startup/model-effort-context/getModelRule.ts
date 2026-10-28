import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { clearResolvedModelRules, orderEffortLevels } from '@packages/mica-config/getModelRule.js';
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
  api?: string;
  models?: Record<string, ModelMetadata>;
};

type ModelsPayload = Record<string, ProviderEntry>;

type CacheEntry = {
  version: number;
  fetchedAt: number;
  payload: ModelsPayload;
};

type ModelMatch = { providerId: string; modelId: string; model: ModelMetadata };

/**
 * 这条元数据是不是聚合网关收录的：网关给外部模型加厂商前缀（`z-ai/glm-4.6`），
 * 厂商自己的条目就是裸模型名（`deepseek-flash`）。带前缀说明请求走的是第三方转发，
 * 推理开关要用厂商无关的 `reasoning`，而不是某个厂商私有的 `thinking`。
 */
function isGatewayEntry(match: ModelMatch): boolean {
  return match.modelId.includes('/');
}

/** 完全同名 vs 只按 basename 同名：调用方只有在两者都空时才算「没找到」。 */
type MatchSet = { exact: ModelMatch[]; loose: ModelMatch[] };

/**
 * 请求实际会走哪个服务商：用来在 models.dev 里优先挑「这个网关自己」的条目。
 *
 * 同一个模型在不同网关下的档位可以不一样（OpenRouter 的 kimi-k3 多一个 `none`，
 * 原生 Moonshot 没有），所以档位集合必须跟着「谁在服务这次请求」走，而不是只看模型厂商。
 */
export type ModelProviderHint = {
  id?: string;
  apiBase?: string;
};

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
export async function getModelRule(
  modelName = '',
  signal?: AbortSignal,
  provider?: ModelProviderHint,
): Promise<ResolvedRule> {
  const requestedName = modelName.trim();
  if (!requestedName) throw new TypeError('modelName must be a non-empty string');

  let providers = await loadModels(signal);
  let matches = findMatches(providers, requestedName);
  if (isEmptyMatch(matches) && providers !== seedEntry.payload) {
    // A disk cache may be stale or miss models that the bundled seed knows
    // about; always fall back to the seed before waiting on the network.
    matches = findMatches(seedEntry.payload, requestedName);
  }
  if (isEmptyMatch(matches) && refreshPromise) {
    try {
      providers = await refreshPromise;
    } catch (error) {
      warnSyncFallback(requestedName, error);
      throw error;
    }
    matches = findMatches(providers, requestedName);
  }
  if (isEmptyMatch(matches)) {
    warnSyncFallback(requestedName);
    throw new Error(`Model not found on models.dev: ${requestedName}`);
  }

  const match = selectMatch(matches, requestedName, providers, provider);
  return buildRule(match, requestedName);
}

/**
 * 同步版：只用已经解码好的快照（内存缓存或随包种子）回答。
 *
 * 启动后到第一次异步解析完成之间、以及任何同步读（`/effort`、desktop 选择器、
 * 请求参数拼装）都要能拿到模型真实档位，不能因为还没 `await` 过就退化成「未知模型」。
 */
export function getSeedModelRule(modelName = '', provider?: ModelProviderHint) {
  const requestedName = modelName.trim();
  if (!requestedName) return undefined;
  const providers = memoryCache?.payload ?? seedEntry.payload;
  const matches = findMatches(providers, requestedName);
  if (isEmptyMatch(matches)) return undefined;
  try {
    return buildRule(selectMatch(matches, requestedName, providers, provider), requestedName);
  } catch {
    return undefined;
  }
}

function buildRule(match: ModelMatch, requestedName: string): ResolvedRule {
  const contextSize = match.model?.limit?.context;
  if (typeof contextSize !== 'number' || !Number.isFinite(contextSize) || contextSize <= 0) {
    throw new Error(`Model has no valid context limit on models.dev: ${requestedName}`);
  }

  const effort = resolveEffortMetadata(match.model, isGatewayEntry(match));
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
    // 刷新前按旧载荷（往往是随包种子）解析出来的规则要作废，否则整个进程寿命内都
    // 沿用旧档位：种子不认识的模型一直显示「没有档位」，种子认识的模型少一档 `none`。
    clearResolvedModelRules();
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

function findMatches(providers: ModelsPayload, requestedName: string): MatchSet {
  const basename = requestedName.split('/').at(-1)?.toLowerCase() ?? '';
  const exact: ModelMatch[] = [];
  const basenameMatches: ModelMatch[] = [];

  for (const [providerId, provider] of Object.entries(providers ?? {})) {
    for (const [key, model] of Object.entries(provider?.models ?? {})) {
      const ids = [key, model?.id].filter((value): value is string => typeof value === 'string');
      const candidate = { providerId, modelId: key, model };
      if (ids.some((id) => id.toLowerCase() === requestedName.toLowerCase())) exact.push(candidate);
      if (ids.some((id) => id.split('/').at(-1)?.toLowerCase() === basename)) basenameMatches.push(candidate);
    }
  }

  return { exact, loose: basenameMatches };
}

function isEmptyMatch(matches: MatchSet): boolean {
  return matches.exact.length === 0 && matches.loose.length === 0;
}

function selectMatch(
  matches: MatchSet,
  modelName: string,
  providers: ModelsPayload,
  provider?: ModelProviderHint,
): ModelMatch {
  // 请求方点名了服务商，而该服务商在 models.dev 里正好收录了这个模型：以它为准。
  // 网关会改写/扩展可用的档位名，用模型厂商的条目会少报档位（选不到 `none` 这类）。
  // 网关下的键常常带厂商前缀（`moonshotai/kimi-k3`），所以这里连 basename 命中一起看。
  const preferred = preferredProviderId(providers, provider);
  const all = [...matches.exact, ...matches.loose];
  const own = preferred ? all.find((match) => match.providerId === preferred) : undefined;
  if (own) return own;

  const exact = matches.exact.length > 0 ? matches.exact : matches.loose;
  const owner = inferOwner(modelName);
  const original = owner && exact.find((match) => match.providerId === owner);
  if (original) return original;

  const signatureCounts = new Map<string, number>();
  for (const match of exact) {
    const signature = JSON.stringify({
      context: match.model?.limit?.context,
      reasoning: match.model?.reasoning,
      options: normalizeOptionSignature(match.model?.reasoning_options),
    });
    signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
  }
  return exact.reduce((best, match) =>
    signatureCount(match, signatureCounts) > signatureCount(best, signatureCounts) ? match : best,
  );
}

/**
 * 把配置里的 provider 对到 models.dev 的 provider 条目上：先认 id（大小写不敏感），
 * 再认 `api_base` 的主机名。对不上就返回空——这时退回模型厂商的条目，不猜。
 */
function preferredProviderId(providers: ModelsPayload, provider?: ModelProviderHint): string | undefined {
  if (!provider) return undefined;
  const wantedId = provider.id?.trim().toLowerCase();
  if (wantedId) {
    const byId = Object.keys(providers ?? {}).find((key) => key.toLowerCase() === wantedId);
    if (byId) return byId;
  }
  const wantedHost = hostOf(provider.apiBase);
  if (!wantedHost) return undefined;
  return Object.keys(providers ?? {}).find((key) => hostOf(providers[key]?.api) === wantedHost);
}

function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
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
  /** 元数据来自聚合网关（模型键带厂商前缀），开关参数用厂商无关的 `reasoning`。 */
  gatewayStyle: boolean;
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
function resolveEffortMetadata(model: ModelMetadata, gatewayStyle: boolean): EffortMetadata {
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
  const effortOption = options.find((option) => option?.type === 'effort');
  const declared = (Array.isArray(effortOption?.values) ? effortOption.values : [])
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
  const hasToggle = options.some((option) => option?.type === 'toggle');
  const hasEffort = Boolean(effortOption) && declared.length > 0;

  if (!hasEffort && !hasToggle) {
    return { levels: [], declaredLevels: [], hasEffort: false, hasToggle: false, gatewayStyle };
  }

  if (!hasEffort) {
    return { levels: ['none', 'on'], declaredLevels: [], hasEffort: false, hasToggle: true, gatewayStyle };
  }
  const levels = new Set(declared);
  if (hasToggle) levels.add('none');
  return { levels: orderEffortLevels(levels), declaredLevels: declared, hasEffort: true, hasToggle, gatewayStyle };
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
      // 网关只认 `reasoning.effort`；再多带 `thinking` / `reasoning_effort` 会抢先生效，
      // 实测把 `none` 顶掉、推理照样跑。
      rule.openai_chat_completions = meta.gatewayStyle
        ? { reasoning: { effort: level } }
        : {
            ...(meta.hasToggle ? { thinking: { type: level === 'none' ? 'disabled' : 'enabled' } } : {}),
            reasoning_effort: level,
          };
    } else if (meta.hasToggle) {
      // 开关补出来的 `none` / `on` 不是模型声明的 effort 取值，所以不发数字档位。
      //
      // 开关的字段名跟着「谁在服务这次请求」走，实测两套互不通用：
      // - 厂商直连（`deepseek-flash`）：只认 `thinking: disabled`；
      // - 聚合网关（`z-ai/glm-4.6` 这类带前缀的键）：只认 `reasoning.effort`，
      //   收到 `thinking` 会静默忽略，推理照跑，`reasoning_effort` 也只有部分模型认。
      // 两边一起发更糟：网关会被 `thinking` / `reasoning_effort` 抢先生效，反而关不掉。
      rule.openai_chat_completions = meta.gatewayStyle
        ? // `on` 不是 effort 取值，网关这边用开关式写法。
          { reasoning: level === 'none' ? { effort: 'none' } : { enabled: true } }
        : { thinking: { type: level === 'none' ? 'disabled' : 'enabled' } };
      // 已经声明过 effort 取值的模型，说明这个接口的数字档位是一套真的枚举，「关掉推理」
      // 在里面就是 `none`（DeepSeek 的 responses 端点实测接受，且回包确实没有 reasoning）。
      // 只声明开关的模型没有这份证据，Responses 协议下就没有这一档。
      if (meta.hasEffort && level === 'none') {
        rule.openai_responses = { reasoning: { effort: 'none' } };
      }
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
