import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import setupModelEffortContext from '../../plugins/builtin/model-effort-context/index.mjs';
import {
  __resetModelsCacheForTests,
  getModelRule as getModelsDevRule,
} from '../../plugins/builtin/model-effort-context/getModelRule.js';
import { ensureModelRule, getModelEffortOptions, getModelRule, resolveModelRequestPatch } from './getModelRule.js';

let dispose: (() => void) | undefined;
let tempMicaHome: string;
const previousMicaHome = process.env.MICA_HOME;

beforeEach(async () => {
  tempMicaHome = await mkdtemp(join(tmpdir(), 'mica-models-cache-'));
  process.env.MICA_HOME = tempMicaHome;
  __resetModelsCacheForTests();
});

afterEach(async () => {
  dispose?.();
  dispose = undefined;
  __resetModelsCacheForTests();
  vi.unstubAllGlobals();
  if (previousMicaHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousMicaHome;
  await rm(tempMicaHome, { recursive: true, force: true });
});

describe('model-effort-context', () => {
  it('forwards headless cancellation to the models.dev request', async () => {
    const fetchMock = vi.fn(
      async (_url: string, options?: { signal?: AbortSignal }) =>
        await new Promise<Response>((_resolve, reject) => {
          if (options?.signal?.aborted) {
            reject(options.signal.reason);
            return;
          }
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    dispose = setupModelEffortContext();
    const controller = new AbortController();
    const pending = ensureModelRule('cancelled-model', controller.signal);
    controller.abort(new Error('cancelled'));

    await expect(pending).rejects.toThrow('cancelled');
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('loads context sizes and dynamic effort options on demand', async () => {
    await mockModelsDev();
    dispose = setupModelEffortContext();
    await Promise.all(['kimi-k2.6', 'deepseek-v4-pro', 'gpt-5.5', 'grok-4.5'].map((model) => ensureModelRule(model)));

    expect(getModelRule('kimi-k2.6').contextSize).toBe(262144);
    expect(getModelRule('deepseek-v4-pro').contextSize).toBe(1000000);
    expect(getModelRule('gpt-5.5').contextSize).toBe(1050000);
    expect(getModelRule('grok-4.5').contextSize).toBe(500000);
    expect(getModelEffortOptions('deepseek-v4-pro')).toEqual(['none', 'high', 'xhigh']);
    expect(getModelEffortOptions('grok-4.5')).toEqual(['low', 'medium', 'high']);
  });

  it('resolves protocol-specific request patches without provider matching', async () => {
    await mockModelsDev();
    dispose = setupModelEffortContext();
    await Promise.all(['kimi-k2.6', 'deepseek-v4-pro', 'gpt-5.5'].map((model) => ensureModelRule(model)));

    expect(resolveModelRequestPatch('kimi-k2.6', 'none', 'openai_chat_completions')).toEqual({
      thinking: { type: 'disabled' },
    });
    expect(resolveModelRequestPatch('deepseek-v4-pro', 'xhigh', 'openai_chat_completions')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    expect(resolveModelRequestPatch('gpt-5.5', 'medium', 'openai_responses')).toEqual({
      reasoning: { effort: 'medium' },
    });
  });
  it('uses a models.dev disk cache younger than 24 hours without requesting the API', async () => {
    await writeModelsCache(Date.now() - 60 * 60 * 1000, {
      cached: { models: { 'cached-model': model(321000, []) } },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getModelsDevRule('cached-model')).resolves.toMatchObject({ contextSize: 321000 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a stale cache immediately and refreshes it in the background', async () => {
    await writeModelsCache(Date.now() - 25 * 60 * 60 * 1000, {
      cached: { models: { 'stale-model': model(111000, []) } },
    });
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getModelsDevRule('stale-model')).resolves.toMatchObject({ contextSize: 111000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(new Response(JSON.stringify({ refreshed: { models: { 'stale-model': model(222000, []) } } })));
    await vi.waitFor(async () => {
      const cache = JSON.parse(await readFile(modelsCachePath(), 'utf8')) as ModelsCache;
      expect(cache.payload.refreshed?.models['stale-model']?.limit.context).toBe(222000);
    });
  });

  it('keeps a stale cache when the background refresh fails', async () => {
    await writeModelsCache(Date.now() - 25 * 60 * 60 * 1000, {
      cached: { models: { 'fallback-model': model(333000, []) } },
    });
    const before = await readFile(modelsCachePath(), 'utf8');
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getModelsDevRule('fallback-model')).resolves.toMatchObject({ contextSize: 333000 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(await readFile(modelsCachePath(), 'utf8')).toBe(before);
  });

  it('waits for a cold request and atomically caches a successful response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ fetched: { models: { 'cold-model': model(456000, []) } } })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getModelsDevRule('cold-model')).resolves.toMatchObject({ contextSize: 456000 });
    const cache = JSON.parse(await readFile(modelsCachePath(), 'utf8')) as ModelsCache;
    expect(cache.version).toBe(1);
    expect(cache.payload.fetched?.models['cold-model']?.limit.context).toBe(456000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves models from the bundled seed when no disk cache exists and models.dev is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    dispose = setupModelEffortContext();

    const rule = await getModelsDevRule('deepseek-v4-flash');
    expect(rule.contextSize).toBeGreaterThan(0);
    expect(rule.efforts).toBeDefined();
  });

  it('falls back to the bundled seed when a disk cache misses a model the seed knows', async () => {
    await writeModelsCache(Date.now(), {
      other: { models: { 'other-model': model(999000, []) } },
    });
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    dispose = setupModelEffortContext();

    const rule = await getModelsDevRule('deepseek-v4-flash');
    expect(rule.contextSize).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the generic rule with a warning when the model is missing from the seed and refresh fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    dispose = setupModelEffortContext();

    const rule = await ensureModelRule('brand-new-model-2099');
    expect(rule.contextSize).toBe(1000000);
    expect(rule.defaultEffort).toBe('medium');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('brand-new-model-2099'));
    errorSpy.mockRestore();
  });
});

type ModelsCache = {
  version: number;
  fetchedAt: number;
  payload: Record<string, { models: Record<string, ReturnType<typeof model>> }>;
};

function modelsCachePath() {
  return join(tempMicaHome, 'cache', 'models-dev.json');
}

async function writeModelsCache(fetchedAt: number, payload: ModelsCache['payload']) {
  await mkdir(join(tempMicaHome, 'cache'), { recursive: true });
  await writeFile(modelsCachePath(), JSON.stringify({ version: 1, fetchedAt, payload }), 'utf8');
}

async function mockModelsDev() {
  const payload = {
    moonshotai: {
      models: {
        'kimi-k2.6': model(262144, [{ type: 'toggle' }]),
      },
    },
    deepseek: {
      models: {
        'deepseek-v4-pro': model(1000000, [{ type: 'toggle' }, { type: 'effort', values: ['high', 'max'] }]),
      },
    },
    openai: {
      models: {
        'gpt-5.5': model(1050000, [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'max'] }]),
      },
    },
    xai: {
      models: {
        'grok-4.5': model(500000, [{ type: 'effort', values: ['low', 'medium', 'high'] }]),
      },
    },
  };
  // A disk cache pins the tests to the mock payload regardless of the bundled seed.
  await writeModelsCache(Date.now(), payload);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
}

function model(context: number, reasoning_options: unknown[]) {
  return { reasoning: true, reasoning_options, limit: { context } };
}
