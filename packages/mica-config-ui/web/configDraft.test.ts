import { describe, expect, it } from 'vitest';
import {
  addProviderDraft,
  parseConfigDraft,
  providerEntries,
  readDefaultModelDraft,
  readProviderDraft,
  removeProviderDraft,
  serializeConfigDraft,
  validateConfigDraft,
  writeDefaultModelDraft,
  writeProviderDraft,
} from './configDraft.js';

const SOURCE = {
  providers: [
    {
      id: 'deepseek',
      api_base: 'https://api.deepseek.com',
      api_key: 'sk-test',
      protocol: 'openai_chat_completions',
      models: ['deepseek-chat'],
    },
  ],
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
      apiBase: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      protocol: 'openai_chat_completions',
      models: ['deepseek-chat'],
    });
  });

  it('keeps unknown provider fields and unknown top-level keys on write', () => {
    const draft = draftOf({
      ...SOURCE,
      extraTop: { keep: true },
      providers: [{ ...SOURCE.providers[0], customFlag: 'keep-me', name: 'DeepSeek 官方' }],
    });
    const next = writeProviderDraft(draft, 0, {
      ...readProviderDraft(providerEntries(draft)[0]),
      apiBase: 'https://api.deepseek.com/v1',
    });
    const [provider] = providerEntries(next) as Record<string, unknown>[];
    expect(provider.customFlag).toBe('keep-me');
    // 显示名称已并入 id，旧配置里的 name 在保存时被清掉。
    expect('name' in provider).toBe(false);
    expect(provider.api_base).toBe('https://api.deepseek.com/v1');
    expect(next.extraTop).toEqual({ keep: true });
    expect((next.mcpServers as Record<string, unknown>)['sequential-thinking']).toBeDefined();
  });

  it('drops optional keys instead of writing empty values', () => {
    const draft = draftOf(SOURCE);
    const next = writeProviderDraft(draft, 0, {
      ...readProviderDraft(providerEntries(draft)[0]),
      models: [],
    });
    const [provider] = providerEntries(next) as Record<string, unknown>[];
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

  // 模型列表地址这个功能已经删掉：旧配置里残留的键在保存时清掉，而不是继续留在文件里。
  it('clears a legacy get_model_url on write', () => {
    const draft = draftOf({
      providers: [{ ...SOURCE.providers[0], get_model_url: 'https://api.deepseek.com/models' }],
    });
    const next = writeProviderDraft(draft, 0, {
      ...readProviderDraft(providerEntries(draft)[0]),
      apiBase: 'https://api.deepseek.com/v1',
    });
    const [provider] = providerEntries(next) as Record<string, unknown>[];
    expect('get_model_url' in provider).toBe(false);
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

describe('config draft serialization', () => {
  it('puts known keys first and keeps extra keys after them', () => {
    const text = serializeConfigDraft({ zebra: 1, mcpServers: {}, providers: [] });
    expect(text.indexOf('"providers"')).toBeLessThan(text.indexOf('"mcpServers"'));
    expect(text.indexOf('"mcpServers"')).toBeLessThan(text.indexOf('"zebra"'));
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('config draft default model', () => {
  it('leaves unconfigured defaults absent when reading and serializing', () => {
    const draft = draftOf(SOURCE);
    expect(readDefaultModelDraft(draft)).toEqual({ provider: '', model: '', effort: '' });
    expect(JSON.parse(serializeConfigDraft(draft))).not.toHaveProperty('defaultModel');
  });

  it('round trips the selected provider, model and arbitrary effort without losing other settings', () => {
    const draft = draftOf({ ...SOURCE, extraTop: { keep: true } });
    const next = writeDefaultModelDraft(draft, {
      provider: ' deepseek ',
      model: ' deepseek-chat ',
      effort: ' custom-effort ',
    });
    const restored = draftOf(JSON.parse(serializeConfigDraft(next)));
    expect(readDefaultModelDraft(restored)).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      effort: 'custom-effort',
    });
    expect(validateConfigDraft(restored)).toEqual([]);
    expect(restored.providers).toEqual(SOURCE.providers);
    expect(restored.mcpServers).toEqual(SOURCE.mcpServers);
    expect(restored.extraTop).toEqual({ keep: true });
    expect(draft).not.toHaveProperty('defaultModel');
  });

  it('deletes blank effort and deletes the entire optional setting when cleared', () => {
    const draft = draftOf({
      ...SOURCE,
      defaultModel: { provider: 'deepseek', model: 'deepseek-chat', effort: 'high' },
    });
    const next = writeDefaultModelDraft(draft, { ...readDefaultModelDraft(draft), effort: ' ' });
    expect(next.defaultModel).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    const cleared = writeDefaultModelDraft(next, { provider: '', model: ' ', effort: '' });
    expect(cleared).not.toHaveProperty('defaultModel');
    expect(JSON.parse(serializeConfigDraft(cleared))).not.toHaveProperty('defaultModel');
    expect(validateConfigDraft(cleared)).toEqual([]);
  });

  it('rejects a model outside a static provider list', () => {
    const draft = draftOf({
      providers: SOURCE.providers,
      defaultModel: { provider: 'deepseek', model: 'missing' },
    });
    expect(validateConfigDraft(draft).map((issue) => issue.key)).toEqual(['defaultModel.model']);
  });

  it('blocks incomplete defaults until a model is entered', () => {
    const draft = writeDefaultModelDraft(draftOf(SOURCE), { provider: 'deepseek', model: '', effort: '' });
    expect(validateConfigDraft(draft).map((issue) => issue.key)).toEqual(['defaultModel.model']);
  });

  it.each([{ value: null }, { value: [] }, { value: 'deepseek' }])(
    'rejects a non-object default model: $value',
    ({ value: defaultModel }) => {
      expect(validateConfigDraft(draftOf({ ...SOURCE, defaultModel })).map((issue) => issue.key)).toEqual([
        'defaultModel',
      ]);
    },
  );

  it.each([
    [{}, ['defaultModel.provider', 'defaultModel.model']],
    [{ provider: 1, model: false }, ['defaultModel.provider', 'defaultModel.model']],
    [{ provider: 'missing', model: 'model' }, ['defaultModel.provider']],
    [{ provider: 'deepseek', model: ' ' }, ['defaultModel.model']],
    [{ provider: 'deepseek', model: 'deepseek-chat', effort: '' }, ['defaultModel.effort']],
    [{ provider: 'deepseek', model: 'deepseek-chat', effort: 2 }, ['defaultModel.effort']],
    [{ provider: 'deepseek', model: 'deepseek-chat', effort: 'bad effort' }, ['defaultModel.effort']],
  ])('reports field-specific default model errors for %j', (defaultModel, keys) => {
    expect(validateConfigDraft(draftOf({ ...SOURCE, defaultModel })).map((issue) => issue.key)).toEqual(keys);
  });

  it('flags a default whose provider was removed', () => {
    const draft = draftOf({
      ...SOURCE,
      providers: [...SOURCE.providers, { ...SOURCE.providers[0], id: 'other' }],
      defaultModel: { provider: 'deepseek', model: 'deepseek-chat' },
    });
    expect(validateConfigDraft(removeProviderDraft(draft, 0)).map((issue) => issue.key)).toEqual([
      'defaultModel.provider',
    ]);
  });

  it('serializes defaults with known keys before advanced settings', () => {
    const serialized = serializeConfigDraft({
      extra: true,
      mcpServers: {},
      defaultModel: { provider: 'p', model: 'm' },
      providers: [],
    });
    expect(Object.keys(JSON.parse(serialized))).toEqual(['providers', 'defaultModel', 'mcpServers', 'extra']);
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
