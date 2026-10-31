import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import { HookRegistry } from '@packages/mica-plugin/HookRegistry.js';
import { createPluginLlmApi, type PluginContext, type PluginModelRequest } from '@packages/mica-plugin/index.js';
import setupMemory from '../memory/index.js';
import { projectSlug } from '../memory/store.js';
import setupRename from './index.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'mica-plugin-owner-'));
  directories.push(home);
  const owner = {};
  const hooks = new HookRegistry();
  const originSettings = {
    enabled: 'true',
    autoCapture: 'true',
    curatorMode: 'direct',
    minIntervalMinutes: '0',
    useMainProvider: 'false',
    baseUrl: 'https://example.test/v1',
    model: 'origin-model',
    prompt: '发起会话的提示词',
    maxMessages: '12',
    minIntervalSeconds: '0',
  };
  const settingsFor = (value?: unknown) =>
    value === owner
      ? originSettings
      : {
          enabled: 'false',
          autoCapture: 'false',
          useMainProvider: 'false',
          model: '',
          baseUrl: '',
        };
  const requests: PluginModelRequest[] = [];
  const rename = vi.fn(() => true);
  const health = { report: vi.fn(), read: () => null, path: null };
  const disposers: Array<() => void> = [];
  const context = {
    pluginId: 'review',
    paths: { config: home },
    hooks,
    commands: new micaCommands.CommandRegistry(),
    agent: { mode: 'session' },
    settings: { get: () => settingsFor(), validate: () => [], path: null },
    sessionSettings: { get: settingsFor },
    session: {
      describe: (value?: unknown) =>
        value === owner
          ? { id: 'origin', title: '旧标题', cwd: '/repo/origin', titleSource: 'derived' }
          : { id: 'selected', title: '当前会话', cwd: '/repo/selected', titleSource: 'manual' },
      messages: (value?: unknown) =>
        value === owner
          ? Array.from({ length: 10 }, (_, index) => ({
              role: index % 2 ? 'assistant' : 'user',
              content: `发起会话的历史 ${index}`,
            }))
          : [],
      rename,
    },
    tools: { register: () => ({ dispose() {} }) },
    prompt: { section: () => ({ dispose() {} }) },
    llm: createPluginLlmApi({
      spec: {},
      readValues: settingsFor,
      models: async (request) => {
        requests.push(request);
        return {
          text:
            request.purpose === '整理记忆'
              ? '{"operations":[{"target":"project","action":"add","content":"约定使用中文"}]}'
              : '处理原会话任务',
          usage: null,
        };
      },
    }),
    logger: { info() {}, warn() {}, error() {} },
    health,
    onDispose: (dispose: () => void) => disposers.push(dispose),
  } as unknown as PluginContext;
  return {
    home,
    owner,
    hooks,
    originSettings,
    requests,
    rename,
    health,
    context,
    dispose: () => disposers.reverse().forEach((dispose) => dispose()),
  };
}

describe('background plugin session ownership', () => {
  it('uses the originating memory settings, model and project while another session is selected', async () => {
    const fixture = harness();
    setupMemory(fixture.context);
    await fixture.hooks.emit('turn:after', { outcome: 'completed', owner: fixture.owner });
    const project = join(fixture.home, 'memory', 'projects', projectSlug('/repo/origin'), 'MEMORY.md');
    await vi.waitFor(() => expect(existsSync(project)).toBe(true));
    expect(fixture.requests[0]).toMatchObject({ owner: fixture.owner, model: 'origin-model' });
    expect(existsSync(join(fixture.home, 'memory', 'projects', projectSlug('/repo/selected'), 'MEMORY.md'))).toBe(
      false,
    );
    fixture.dispose();
  });

  it('uses the originating title model, prompt, history and rename target and reads interval changes', async () => {
    const fixture = harness();
    setupRename(fixture.context);
    const emit = (id: string) =>
      fixture.hooks.emit('turn:before', {
        runtime: {},
        owner: fixture.owner,
        input: { id, text: '继续原任务', source: 'ui', createdAt: 0 },
      });
    fixture.originSettings.minIntervalSeconds = '60';
    await emit('first');
    await vi.waitFor(() => expect(fixture.rename).toHaveBeenCalledTimes(1));
    expect(fixture.requests[0]).toMatchObject({
      owner: fixture.owner,
      model: 'origin-model',
      system: '发起会话的提示词',
    });
    expect(fixture.requests[0]?.user).toContain('发起会话的历史');
    expect(fixture.rename).toHaveBeenCalledWith('处理原会话任务', { owner: fixture.owner, source: 'auto' });
    await emit('second');
    expect(fixture.requests).toHaveLength(1);
    fixture.originSettings.minIntervalSeconds = '0';
    await emit('third');
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(2));
    fixture.dispose();
  });
});
