import { describe, expect, it } from 'vitest';
import {
  addProviderDraft,
  capabilityDefaultsSummary,
  extraConfigKeys,
  mcpServerCount,
  parseConfigDraft,
  providerEntries,
  readProviderDraft,
  readSearxngUrl,
  removeProviderDraft,
  serializeConfigDraft,
  validateConfigDraft,
  writeProviderDraft,
  writeSearxngUrl,
} from './configDraft.js';

const SOURCE = {
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      api_base: 'https://api.deepseek.com',
      api_key: 'sk-test',
      protocol: 'openai_chat_completions',
      get_model_url: 'https://api.deepseek.com/models',
      models: ['deepseek-chat'],
    },
  ],
  searxngUrl: 'http://127.0.0.1:8080',
  mcpServers: {
    'sequential-thinking': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  },
};

function draftOf(source: unknown) {
  const parsed = parseConfigDraft(JSON.stringify(source));
  if (!parsed.draft) throw new Error('draft should parse');
  return parsed.draft;
}

describe('config draft parsing', () => {
  it('reports a syntax error instead of throwing', () => {
    const result = parseConfigDraft('{ "providers": [ }');
    expect(result.draft).toBeNull();
    expect(result.error).toMatch(/JSON/);
  });

  it('rejects non-object roots', () => {
    expect(parseConfigDraft('[]').error).toBe('配置文件的根节点必须是对象');
    expect(parseConfigDraft('').draft).toEqual({});
  });
});

describe('config draft providers', () => {
  it('reads form fields from a raw provider', () => {
    expect(readProviderDraft(providerEntries(draftOf(SOURCE))[0])).toEqual({
      id: 'deepseek',
      name: 'DeepSeek',
      apiBase: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      protocol: 'openai_chat_completions',
      models: ['deepseek-chat'],
      getModelUrl: 'https://api.deepseek.com/models',
    });
  });

  it('keeps unknown provider fields and unknown top-level keys on write', () => {
    const draft = draftOf({
      ...SOURCE,
      extraTop: { keep: true },
      providers: [{ ...SOURCE.providers[0], customFlag: 'keep-me' }],
    });
    const next = writeProviderDraft(draft, 0, {
      ...readProviderDraft(providerEntries(draft)[0]),
      name: 'DeepSeek 官方',
    });
    const [provider] = providerEntries(next) as Record<string, unknown>[];
    expect(provider.customFlag).toBe('keep-me');
    expect(provider.name).toBe('DeepSeek 官方');
    expect(next.extraTop).toEqual({ keep: true });
    expect((next.mcpServers as Record<string, unknown>)['sequential-thinking']).toBeDefined();
  });

  it('drops optional keys instead of writing empty values', () => {
    const draft = draftOf(SOURCE);
    const next = writeProviderDraft(draft, 0, {
      ...readProviderDraft(providerEntries(draft)[0]),
      name: '',
      getModelUrl: '',
      models: [],
    });
    const [provider] = providerEntries(next) as Record<string, unknown>[];
    expect('name' in provider).toBe(false);
    expect('get_model_url' in provider).toBe(false);
    expect('models' in provider).toBe(false);
    // 原本就有的 api_key 保留空串表示「显式清空」，而不是删键
    expect(provider.api_key).toBe('sk-test');
  });

  // effort 是否发送由模型规则按模型名判定，配置页不再提供这一项；
  // 旧配置里已经写下的值既不能丢，也不能被表单改回默认。
  it('keeps a legacy supportsEffort value untouched', () => {
    const draft = draftOf({
      providers: [{ ...SOURCE.providers[0], supportsEffort: false }],
    });
    const next = writeProviderDraft(draft, 0, {
      ...readProviderDraft(providerEntries(draft)[0]),
      apiBase: 'https://api.deepseek.com/v1',
    });
    const [provider] = providerEntries(next) as Record<string, unknown>[];
    expect(provider.supportsEffort).toBe(false);
    expect(Object.keys(provider)).toContain('supportsEffort');
    expect(provider.api_base).toBe('https://api.deepseek.com/v1');
  });

  it('adds a provider with a unique id and removes by index', () => {
    const draft = draftOf(SOURCE);
    const added = addProviderDraft(draft);
    expect(providerEntries(added)).toHaveLength(2);
    expect(providerEntries(added)[1]).toMatchObject({ id: 'provider', protocol: 'openai_chat_completions' });

    const twice = addProviderDraft(added);
    expect(providerEntries(twice)[2]).toMatchObject({ id: 'provider-2' });

    const removed = removeProviderDraft(twice, 1);
    expect(providerEntries(removed)).toHaveLength(2);
    expect(providerEntries(removed)[1]).toMatchObject({ id: 'provider-2' });
  });
});

describe('config draft search url', () => {
  it('deletes the key when cleared', () => {
    const draft = writeSearxngUrl(draftOf(SOURCE), '   ');
    expect('searxngUrl' in draft).toBe(false);
    expect(readSearxngUrl(draft)).toBe('');
  });

  it('trims the value', () => {
    expect(writeSearxngUrl({}, ' http://localhost:8080 ')).toEqual({ searxngUrl: 'http://localhost:8080' });
  });
});

describe('config draft serialization', () => {
  it('puts known keys first and keeps extra keys after them', () => {
    const text = serializeConfigDraft({ zebra: 1, searxngUrl: 'http://x', providers: [] });
    expect(text.indexOf('"providers"')).toBeLessThan(text.indexOf('"searxngUrl"'));
    expect(text.indexOf('"searxngUrl"')).toBeLessThan(text.indexOf('"zebra"'));
    expect(text.endsWith('\n')).toBe(true);
  });

  it('lists extra keys and summaries', () => {
    const draft = draftOf({ ...SOURCE, modelRules: [], capabilityDefaults: { disabledTools: ['a', 'b'] } });
    expect(extraConfigKeys(draft)).toEqual(['modelRules']);
    expect(mcpServerCount(draft)).toBe(1);
    expect(capabilityDefaultsSummary(draft)).toBe('默认关闭 2 项');
    expect(capabilityDefaultsSummary(draftOf(SOURCE))).toBe('全部启用');
  });
});

describe('config draft validation', () => {
  it('accepts the sample config', () => {
    expect(validateConfigDraft(draftOf(SOURCE))).toEqual([]);
  });

  it('flags missing and duplicate provider ids', () => {
    const draft = draftOf({
      providers: [
        { id: '', api_base: 'https://a', protocol: 'openai_responses' },
        { id: 'dup', api_base: 'https://b', protocol: 'openai_responses' },
        { id: 'dup', api_base: '', protocol: 'nope' },
      ],
    });
    const issues = validateConfigDraft(draft);
    expect(issues.map((issue) => issue.key)).toEqual([
      'providers.0.id',
      'providers.2.id',
      'providers.2.api_base',
      'providers.2.protocol',
    ]);
    expect(issues[1].message).toContain('第 2 个');
  });

  it('rejects an empty providers array', () => {
    expect(validateConfigDraft({ providers: [] })).toEqual([
      { key: 'providers', message: '至少需要一个服务商，否则无法发送消息' },
    ]);
  });
});
