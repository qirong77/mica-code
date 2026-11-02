import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import setupCommandMemory from './command-memory.js';

describe('command-memory', () => {
  it('appends memory guidance to the system prompt', () => {
    const harness = createHarness();

    const result = { prompt: harness.sections.render() };

    expect(result.prompt).toContain('<injection source="plugin" plugin="test.commandMemory" section="guidance">');
    expect(result.prompt).toContain('# 会话记忆（Memory）');
    expect(result.prompt).toContain('snapshot.conversationMessages');
    expect(result.prompt).toContain('offset');
    expect(result.prompt).toContain('## 怎么汇报');
    expect(result.prompt).toContain('参考了会话');
  });

  it('does not modify user prompt content', async () => {
    const harness = createHarness();

    const result = await harness.hooks.pipeline('prompt:build', {
      runtime: {},
      input: { text: 'hi' },
      content: [{ type: 'text', text: 'hi' }],
    });

    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('points at the configured sessions directory when paths are provided', () => {
    const hooks = new micaPlugin.HookRegistry();
    const sections = new micaPlugin.PluginPromptSections();
    setupCommandMemory({
      pluginId: 'test.commandMemory',
      hooks,
      prompt: {
        section: (section: Parameters<NonNullable<PluginContext['prompt']>['section']>[0]) =>
          sections.add('test.commandMemory', section),
      },
      paths: { home: '/home/u', config: '/custom/mica-home', plugins: '/custom/mica-home/plugins' },
      onDispose: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext);

    const result = { prompt: sections.render() };

    expect(result.prompt).toContain('/custom/mica-home/sessions');
  });
});

function createHarness() {
  const hooks = new micaPlugin.HookRegistry();
  const sections = new micaPlugin.PluginPromptSections();
  setupCommandMemory({
    pluginId: 'test.commandMemory',
    hooks,
    prompt: {
      section: (section: Parameters<NonNullable<PluginContext['prompt']>['section']>[0]) =>
        sections.add('test.commandMemory', section),
    },
    onDispose: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext);
  return { hooks, sections };
}
