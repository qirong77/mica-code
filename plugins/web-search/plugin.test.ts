import { describe, expect, it, vi } from 'vitest';
import type { PluginContext, PluginSettingValues } from '@packages/mica-plugin/index.js';
import setup from './index.js';

const configured: PluginSettingValues = {
  searxngUrl: 'https://search.example.test',
  defaultCount: '8',
};

function countHint(defaultCount: string): string {
  return createHarness({ settings: { defaultCount } }).registered[0]!.input_schema.properties.count.description;
}

describe('web-search plugin', () => {
  it('registers the tool with the URL from its own settings', () => {
    const harness = createHarness();

    expect(harness.registered).toHaveLength(1);
    expect(harness.registered[0]!.name).toBe('web_search');
    expect(harness.healthReports[0]!.message).toContain('https://search.example.test');
    expect(harness.registered[0]!.input_schema.properties.count.description).toContain('默认 8');
  });

  it('falls back to SEARXNG_URL, then to the local default', () => {
    const fromEnv = createHarness({ settings: { searxngUrl: '' }, env: 'http://searxng:8080/' });
    expect(fromEnv.healthReports[0]!.message).toContain('http://searxng:8080');

    const fromDefault = createHarness({ settings: {}, env: '' });
    expect(fromDefault.healthReports[0]!.message).toContain('http://127.0.0.1:8080');
  });

  it('clamps the default result count to a sane range', () => {
    expect(countHint('999')).toContain('默认 20');
    expect(countHint('0')).toContain('默认 1');
    expect(countHint('nope')).toContain('默认 5');
    expect(countHint('')).toContain('默认 5');
  });

  it('contributes its own prompt section so the guidance disappears with the plugin', () => {
    const harness = createHarness();

    expect(harness.promptSections).toHaveLength(1);
    expect(harness.promptSections[0]).toMatchObject({ id: 'web-search' });
    expect(harness.promptSections[0]?.render()).toContain('`web_search`');
  });

  it('reports an unconfigured instance as usable but with the default address', () => {
    const harness = createHarness({ settings: {}, env: '' });

    expect(harness.healthReports[0]).toMatchObject({ level: 'ok' });
    expect(harness.healthReports[0]?.message).toContain('127.0.0.1:8080');
  });

  it('marks a broken configuration as needing attention instead of claiming it works', () => {
    const harness = createHarness({ issues: ['地址 必须是 http/https 地址'] });

    expect(harness.healthReports[0]).toMatchObject({ level: 'warn' });
    // 配置坏了仍然注册工具：地址可能只是暂时写错，模型调用时会给出明确失败原因，
    // 而不是让工具凭空消失。
    expect(harness.registered).toHaveLength(1);
  });
});

function createHarness(
  options: {
    settings?: PluginSettingValues;
    env?: string;
    issues?: string[];
  } = {},
) {
  const registered: Array<{
    name: string;
    description: string;
    input_schema: { properties: { count: { description: string } } };
  }> = [];
  const promptSections: Array<{ id: string; render(): string }> = [];
  const healthReports: Array<{ level: string; message: string }> = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const settings = options.settings ?? configured;
  const previousEnv = process.env.SEARXNG_URL;
  if (options.env === undefined) delete process.env.SEARXNG_URL;
  else process.env.SEARXNG_URL = options.env;

  const ctx = {
    pluginId: 'web-search',
    settings: {
      path: '/tmp/plugin-settings/web-search.json',
      get: () => settings,
      validate: () => (options.issues ?? []).map((message) => ({ key: 'searxngUrl', label: '地址', message })),
    },
    tools: {
      register: (tool: unknown) => {
        registered.push(
          tool as {
            name: string;
            description: string;
            input_schema: { properties: { count: { description: string } } };
          },
        );
        return { dispose() {} };
      },
    },
    prompt: {
      section: (section: { id: string; render(): string }) => {
        promptSections.push(section);
        return { dispose() {} };
      },
    },
    health: {
      path: null,
      read: () => null,
      report: (report: { level: string; message: string }) => healthReports.push(report),
      clear() {},
    },
    logger,
    onDispose: () => {},
  } as unknown as PluginContext;

  setup(ctx);

  process.env.SEARXNG_URL = previousEnv ?? '';
  if (previousEnv === undefined) delete process.env.SEARXNG_URL;

  return {
    registered,
    promptSections,
    healthReports,
    logger,
  };
}
