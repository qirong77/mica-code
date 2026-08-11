import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const bunAvailable = process.env.MICA_BIN || spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
const suite = bunAvailable ? describe : describe.skip;

function makeHome(tag: string, providers: unknown[]): string {
  const home = mkdtempSync(join(tmpdir(), `mica-models-flow-${process.pid}-${tag}-`));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ providers }), 'utf-8');
  const models = providers.flatMap((provider) =>
    provider && typeof provider === 'object' && Array.isArray((provider as { models?: unknown }).models)
      ? ((provider as { models: string[] }).models ?? [])
      : [],
  );
  const modelCache = JSON.stringify({
    version: 1,
    fetchedAt: Date.now(),
    payload: {
      cached: { models: Object.fromEntries(models.map((model) => [model, { limit: { context: 1_000_000 } }])) },
    },
  });
  mkdirSync(join(home, 'cache'), { recursive: true });
  writeFileSync(join(home, 'cache', 'models-dev.json'), modelCache, 'utf-8');
  return home;
}

function runCli(args: string[], micaHome: string) {
  return spawnSync(
    process.env.MICA_BIN ?? 'bun',
    [...(process.env.MICA_BIN ? [] : ['apps/cli/src/index.ts']), ...args],
    {
      cwd: ROOT,
      env: { ...process.env, MICA_HOME: micaHome, MICA_NO_DAEMON: '1' },
      encoding: 'utf-8',
      timeout: 30_000,
    },
  );
}

suite('mica models flows', () => {
  it('prints valid JSON from the real CLI, including provider-qualified model ids', () => {
    const home = makeHome('json', [
      {
        id: 'deepseek',
        api_base: 'https://example.invalid/v1',
        api_key: 'test-key',
        protocol: 'openai_chat_completions',
        models: ['deepseek-chat', 'deepseek-reasoner'],
      },
      {
        id: 'openrouter',
        api_base: 'https://example.invalid/v1',
        api_key: 'test-key',
        protocol: 'openai_responses',
        models: ['openai/gpt-5'],
      },
    ]);
    try {
      const result = runCli(['models', '--json'], home);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');

      const entries = JSON.parse(result.stdout.trim()) as Array<{ id: string; efforts: string[] }>;
      expect(entries.map((entry) => entry.id)).toEqual([
        'deepseek/deepseek-chat',
        'deepseek/deepseek-reasoner',
        'openrouter/openai/gpt-5',
      ]);
      expect(entries.every((entry) => Array.isArray(entry.efforts))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps static models and exits successfully when dynamic provider discovery fails', () => {
    const home = makeHome('dynamic-error', [
      {
        id: 'static',
        api_base: 'https://example.invalid/v1',
        protocol: 'openai_chat_completions',
        models: ['static-model'],
      },
      {
        id: 'dynamic',
        api_base: 'https://example.invalid/v1',
        protocol: 'openai_chat_completions',
        // Port 1 is intentionally unavailable in the test environment. The
        // discovery path is best-effort and must not suppress static entries.
        get_model_url: 'http://127.0.0.1:1/models',
      },
    ]);
    try {
      const result = runCli(['models', '--json'], home);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout.trim())).toEqual([{ id: 'static/static-model', efforts: expect.any(Array) }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
