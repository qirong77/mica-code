import { describe, expect, it, vi } from 'vitest';
import type { PluginAskQuestion, PluginContext, PluginNoticeOptions } from '@packages/mica-plugin/index.js';
import { AskPlugin } from './AskPlugin.js';
import { AskUserTool } from './AskTool.js';
import manifest from './plugin.json';

describe('AskPlugin', () => {
  it('declares a configurable five-minute timeout in the plugin settings', () => {
    expect(manifest.settings).toContainEqual(
      expect.objectContaining({
        key: 'timeoutMinutes',
        type: 'number',
        default: '5',
        min: 1,
        max: 60,
        unit: '分钟',
      }),
    );
    expect(manifest.requires).toEqual(expect.arrayContaining(['settings', 'ui', 'session']));
  });

  it('applies live settings and routes timeout notices to the original session', async () => {
    let timeoutMinutes = '5';
    const originalOwner = {};
    let currentOwner = originalOwner;
    const notices: Array<{ message: string; options?: PluginNoticeOptions }> = [];
    const questions: PluginAskQuestion[] = [];
    let tool: AskUserTool | undefined;
    const context = {
      settings: { get: () => ({ timeoutMinutes }) },
      session: { captureOwner: () => currentOwner },
      ask: {
        request: async (question: PluginAskQuestion) => {
          questions.push(question);
          currentOwner = {};
          return { optionIds: [], cancelled: true, reason: 'timeout' };
        },
      },
      ui: {
        notice: (message: string, options?: PluginNoticeOptions) => notices.push({ message, options }),
      },
      tools: {
        register: (registered: AskUserTool) => {
          tool = registered;
          return { dispose: vi.fn() };
        },
      },
      onDispose: vi.fn(),
    } as unknown as PluginContext;
    new AskPlugin().setup(context);

    const question = { title: '先做哪个入口？', options: [{ id: 'a', label: '入口 A' }] };
    await tool!.execute(question);
    expect(questions[0].timeoutMs).toBe(300_000);
    expect(notices[0]).toEqual({
      message: expect.stringContaining('等待回复已超时'),
      options: { status: 'warning', owner: originalOwner },
    });
    timeoutMinutes = '2';
    await tool!.execute(question);
    expect(questions[1].timeoutMs).toBe(120_000);
  });
});
