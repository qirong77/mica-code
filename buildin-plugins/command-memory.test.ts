import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import setupCommandMemory from './command-memory.js';

describe('command-memory', () => {
  it('appends memory guidance to the end of string content', async () => {
    const harness = createHarness();

    const result = await harness.hooks.pipeline('prompt:build', {
      runtime: {},
      input: { text: '继续上次的讨论' },
      content: '继续上次的讨论',
    });

    const content = result.content as string;
    expect(content.startsWith('继续上次的讨论')).toBe(true);
    expect(content).toContain('# 会话记忆（Memory）');
    expect(content).toContain('snapshot.conversationMessages');
    expect(content).toContain('offset');
    expect(content).toContain('## 怎么汇报');
    expect(content).toContain('参考了会话');
    expect(content.indexOf('继续上次的讨论')).toBeLessThan(content.indexOf('# 会话记忆'));
  });

  it('appends a text block for content block arrays', async () => {
    const harness = createHarness();

    const result = await harness.hooks.pipeline('prompt:build', {
      runtime: {},
      input: { text: 'hi' },
      content: [{ type: 'text', text: 'hi' }],
    });

    expect(result.content).toEqual([{ type: 'text', text: 'hi' }, expect.objectContaining({ type: 'text' })]);
  });

  it('points at the configured sessions directory when paths are provided', async () => {
    const hooks = new micaPlugin.HookRegistry();
    setupCommandMemory({
      pluginId: 'test.commandMemory',
      hooks,
      paths: { home: '/home/u', config: '/custom/mica-home', plugins: '/custom/mica-home/plugins' },
      onDispose: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext);

    const result = await hooks.pipeline('prompt:build', {
      runtime: {},
      input: { text: 'hi' },
      content: 'hi',
    });

    expect(result.content as string).toContain('/custom/mica-home/sessions');
  });
});

function createHarness() {
  const hooks = new micaPlugin.HookRegistry();
  setupCommandMemory({
    pluginId: 'test.commandMemory',
    hooks,
    onDispose: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext);
  return { hooks };
}
