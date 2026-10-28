import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPluginLlmApi,
  micaPlugin,
  type PluginContext,
  type PluginModelRequest,
  type PluginSettingValues,
} from '@packages/mica-plugin/index.js';
import type { CommandResult, MicaCommand } from '@packages/mica-commands/index.js';

const hostConfig = {
  provider: 'host',
  model: 'host-model',
  providers: [
    {
      id: 'host',
      name: 'Host',
      api_base: 'https://host.example.test/v1',
      api_key: 'host-key',
      protocol: 'openai_chat_completions' as const,
      models: ['host-model'],
    },
  ],
};

vi.mock('@packages/mica-config/index.js', () => ({
  micaConfig: {
    get: () => hostConfig,
    providerForModel: () => hostConfig.providers[0],
  },
}));

const { default: setup } = await import('./index.js');

const standaloneSettings: PluginSettingValues = {
  baseUrl: 'https://api.example.test/v1',
  apiKey: 'test-key',
  protocol: 'openai_chat_completions',
  model: 'mini',
  prompt: '',
  push: 'false',
};

const repos: string[] = [];
let repo = '';

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mica-commit-plugin-command-'));
  repos.push(directory);
  git(['init', '-q'], directory);
  git(['config', 'user.name', 'Mica Commit Test'], directory);
  git(['config', 'user.email', 'commit-plugin@example.invalid'], directory);
  git(['config', 'commit.gpgsign', 'false'], directory);
  writeFileSync(join(directory, 'README.md'), 'initial\n');
  git(['add', 'README.md'], directory);
  git(['commit', '-qm', 'chore: initialize test repo'], directory);
  return directory;
}

function createHarness(options: { settings?: PluginSettingValues; text?: string } = {}) {
  const notifications: Array<{ level: string; message: string }> = [];
  const healthReports: Array<{ level: string; message: string }> = [];
  const commands: MicaCommand[] = [];
  const requests: PluginModelRequest[] = [];
  const settingsValues = options.settings ?? standaloneSettings;
  // 真组件 + 假底层：插件走的就是 `ctx.llm` 这条路。
  const llm = createPluginLlmApi({
    spec: { followMain: true },
    readValues: () => ({ useMainProvider: 'false', ...settingsValues }),
    models: vi.fn(async (request: PluginModelRequest) => {
      requests.push(request);
      return { text: options.text ?? 'feat: 插件提交 ✨', usage: null };
    }),
  });

  const ctx = {
    pluginId: 'commit',
    services: new micaPlugin.ServiceContainer(),
    commands: {
      register: (command: MicaCommand) => {
        commands.push(command);
        return { dispose() {} };
      },
    },
    hooks: { on: () => ({ dispose() {} }) },
    events: {
      publish: (event: { type: string; level?: string; message?: string }) => {
        if (event.type === 'notification')
          notifications.push({ level: event.level ?? 'info', message: event.message ?? '' });
      },
    },
    settings: {
      path: '/tmp/plugin-settings/commit.json',
      get: () => options.settings ?? standaloneSettings,
      validate: () => [],
    },
    health: {
      path: null,
      read: () => null,
      report: (report: { level: string; message: string }) => healthReports.push(report),
      clear() {},
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    llm,
    onDispose: vi.fn(),
  } as unknown as PluginContext;

  setup(ctx);
  const command = commands.find((item) => item.name === 'commit');
  if (!command) throw new Error('commit command was not registered');

  return {
    notifications,
    healthReports,
    requests,
    llm,
    run: (args = '') => command.handler({}, args) as CommandResult | Promise<CommandResult>,
  };
}

beforeEach(() => {
  repo = makeRepo();
  vi.spyOn(process, 'cwd').mockReturnValue(repo);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of repos.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('commit plugin command', () => {
  it('commits through the configured endpoint and reports progress as notifications', async () => {
    writeFileSync(join(repo, 'README.md'), 'updated by the plugin\n');
    const harness = createHarness();

    const result = await harness.run();

    expect(result).toMatchObject({
      ok: true,
      data: { ok: true, subject: 'feat: 插件提交 ✨', pushed: false },
    });
    expect(git(['log', '-1', '--pretty=%s']).trim()).toBe('feat: 插件提交 ✨');
    expect(harness.requests[0]).toMatchObject({
      purpose: '写提交说明',
      model: 'mini',
      baseUrl: 'https://api.example.test/v1',
      protocol: 'openai_chat_completions',
    });
    expect(harness.notifications.some((item) => item.message.includes('正在分析'))).toBe(true);
    expect(harness.notifications.at(-1)?.message).toContain('已提交');
    expect(harness.healthReports.at(-1)).toMatchObject({ level: 'ok' });
  });

  it('refuses to run a half-configured standalone endpoint without touching git', async () => {
    writeFileSync(join(repo, 'README.md'), 'still uncommitted\n');
    const harness = createHarness({
      settings: { ...standaloneSettings, model: '' },
    });

    const result = await harness.run();

    expect(result.ok).toBe(false);
    expect(harness.requests).toHaveLength(0);
    expect(git(['log', '-1', '--pretty=%s']).trim()).toBe('chore: initialize test repo');
    expect(harness.healthReports.at(-1)).toMatchObject({ level: 'warn' });
  });

  it('treats a clean working tree as a normal outcome, not a plugin failure', async () => {
    const harness = createHarness();

    const result = await harness.run();

    expect(result).toMatchObject({ ok: false, data: { code: 'nothing_to_commit' } });
    expect(harness.healthReports).toHaveLength(0);
    expect(harness.notifications.at(-1)).toMatchObject({ level: 'warn' });
  });

  it('rejects arguments instead of silently committing everything', async () => {
    const harness = createHarness();

    const result = await harness.run('agent');

    expect(result.ok).toBe(false);
    expect(harness.notifications.at(-1)?.message).toContain('不支持参数');
  });
});
