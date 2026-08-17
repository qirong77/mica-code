import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { modelsDevSeedBase64 } from './seed/models-dev.seed.js';

const MODELS_URL = 'https://models.dev/api.json';
const CACHE_VERSION = 1;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'];

let memoryCache;
let cacheReadPromise;
let refreshPromise;
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
export async function getModelRule(modelName = '', signal) {
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
  const contextSize = match.model?.limit?.context;
  if (!Number.isFinite(contextSize) || contextSize <= 0) {
    throw new Error(`Model has no valid context limit on models.dev: ${requestedName}`);
  }

  const options = Array.isArray(match.model.reasoning_options) ? match.model.reasoning_options : [];
  const effortOption = options.find((option) => option?.type === 'effort');
  const hasToggle = options.some((option) => option?.type === 'toggle');
  const efforts = normalizeEfforts(effortOption?.values, hasToggle, match.model.reasoning);
  const protocol = match.providerId === 'openai' ? 'openai_responses' : 'openai_chat_completions';

  return {
    contextSize,
    defaultEffort: chooseDefaultEffort(efforts, protocol),
    supportsVision: modelSupportsVision(match.model),
    efforts: Object.fromEntries(
      efforts.map((effort) => [
        effort,
        { [protocol]: requestPatch(protocol, effort, hasToggle, Boolean(effortOption)) },
      ]),
    ),
  };
}

/**
 * models.dev annotates every model with a modalities.input list. A model that
 * lists "image" can receive image blocks; anything else is text-only. When the
 * field is missing we stay conservative and assume vision is supported so a
 * text-only model never gets silently mislabeled as capable.
 */
function modelSupportsVision(model) {
  const input = model?.modalities?.input;
  return !Array.isArray(input) || input.includes('image');
}

async function loadModels(signal) {
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

function refreshModels(signal) {
  if (refreshPromise) return refreshPromise;

  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const request = fetch(MODELS_URL, { signal: requestSignal }).then(async (response) => {
    if (!response.ok) throw new Error(`models.dev request failed: ${response.status} ${response.statusText}`);
    const payload = await response.json();
    if (!isModelsPayload(payload)) throw new Error('models.dev returned an invalid payload');

    const entry = { version: CACHE_VERSION, fetchedAt: Date.now(), payload };
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

function readCacheOnce() {
  cacheReadPromise ??= readCache();
  return cacheReadPromise;
}

async function readCache() {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), 'utf8'));
    return isCacheEntry(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeCacheAtomically(entry) {
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

function cachePath() {
  const micaHome = process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : resolve(homedir(), '.mica');
  return resolve(micaHome, 'cache', 'models-dev.json');
}

function isFresh(entry) {
  const age = Date.now() - entry.fetchedAt;
  return age >= 0 && age < CACHE_TTL_MS;
}

function isCacheEntry(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.version === CACHE_VERSION &&
    Number.isFinite(value.fetchedAt) &&
    value.fetchedAt > 0 &&
    isModelsPayload(value.payload)
  );
}

function parseSeedEntry(encoded) {
  const entry = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'));
  if (!isCacheEntry(entry)) throw new Error('invalid bundled models.dev seed');
  return entry;
}

function isModelsPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).some(
    (provider) => provider && typeof provider === 'object' && provider.models && typeof provider.models === 'object',
  );
}

/** Test-only reset for the module-level disk/read/refresh state. */
export function __resetModelsCacheForTests() {
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
function warnRefreshFailure(cached) {
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
function warnSyncFallback(modelName, error) {
  if (warnedSyncFallback) return;
  warnedSyncFallback = true;
  console.error(
    `mica: model "${modelName}" was not found in the bundled seed or cached models.dev data, ` +
      `and it could not be resolved online (${error instanceof Error ? error.message : String(error)}). ` +
      'Using a generic rule (context 1M, default effort).',
  );
}

function findMatches(providers, requestedName) {
  const basename = requestedName.split('/').at(-1).toLowerCase();
  const exact = [];
  const basenameMatches = [];

  for (const [providerId, provider] of Object.entries(providers ?? {})) {
    for (const [key, model] of Object.entries(provider?.models ?? {})) {
      const ids = [key, model?.id].filter((value) => typeof value === 'string');
      const candidate = { providerId, model };
      if (ids.some((id) => id.toLowerCase() === requestedName.toLowerCase())) exact.push(candidate);
      if (ids.some((id) => id.split('/').at(-1).toLowerCase() === basename)) basenameMatches.push(candidate);
    }
  }

  return exact.length > 0 ? exact : basenameMatches;
}

function selectMatch(matches, modelName) {
  const owner = inferOwner(modelName);
  const original = owner && matches.find((match) => match.providerId === owner);
  if (original) return original;

  const signatureCounts = new Map();
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

function inferOwner(modelName) {
  const name = modelName.toLowerCase();
  if (/(^|\/)gpt-|(^|\/)o[134](?:-|$)/.test(name)) return 'openai';
  if (/(^|\/)grok-/.test(name)) return 'xai';
  if (/(^|\/)(kimi-|moonshot)/.test(name)) return 'moonshotai';
  if (/(^|\/)deepseek-/.test(name)) return 'deepseek';
  if (/(^|\/)claude-/.test(name)) return 'anthropic';
  if (/(^|\/)gemini-/.test(name)) return 'google';
  return undefined;
}

function normalizeOptionSignature(options) {
  return (Array.isArray(options) ? options : []).map((option) => ({
    type: option?.type,
    values: Array.isArray(option?.values) ? option.values.map(normalizeEffortName).sort() : undefined,
  }));
}

function signatureCount(match, counts) {
  return counts.get(
    JSON.stringify({
      context: match.model?.limit?.context,
      reasoning: match.model?.reasoning,
      options: normalizeOptionSignature(match.model?.reasoning_options),
    }),
  );
}

function normalizeEfforts(values, hasToggle, supportsReasoning) {
  const result = (Array.isArray(values) ? values : [])
    .map(normalizeEffortName)
    .filter((value) => EFFORTS.includes(value));
  if (hasToggle && !result.includes('none')) result.unshift('none');
  if (hasToggle && result.length === 1) result.push('high');
  if (result.length === 0 && supportsReasoning) result.push('high');
  return [...new Set(result)].sort((left, right) => EFFORTS.indexOf(left) - EFFORTS.indexOf(right));
}

function normalizeEffortName(value) {
  return value === 'max' ? 'xhigh' : value;
}

function chooseDefaultEffort(efforts, protocol) {
  if (protocol === 'openai_responses' && efforts.includes('medium')) return 'medium';
  if (efforts.includes('high')) return 'high';
  if (efforts.includes('medium')) return 'medium';
  return efforts.at(-1) ?? 'none';
}

function requestPatch(protocol, effort, hasToggle, hasEffort) {
  if (protocol === 'openai_responses') return { reasoning: { effort } };
  if (hasToggle) {
    const patch = { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' } };
    if (effort !== 'none' && hasEffort) patch.reasoning_effort = effort === 'xhigh' ? 'max' : effort;
    return patch;
  }
  return { reasoning_effort: effort === 'xhigh' ? 'max' : effort };
}
