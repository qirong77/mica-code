import { describe, expect, it, vi } from 'vitest';
import type {
  PluginAskQuestion,
  PluginContext,
  PluginNoticeOptions,
  PluginPromptSection,
} from '@packages/mica-plugin/index.js';
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
    const sections: PluginPromptSection[] = [];
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
      prompt: {
        section: (section: PluginPromptSection) => {
          sections.push(section);
          return { dispose: vi.fn() };
        },
      },
      onDispose: vi.fn(),
    } as unknown as PluginContext;
    new AskPlugin().setup(context);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ id: 'ask', label: '提问策略' });
    const guidance = sections[0].render();
    expect(guidance).toContain('关键选择');
    expect(guidance).toContain('超出现有授权');
    expect(guidance).toContain('已授权的可逆修改直接推进');
    expect(guidance).not.toMatch(/会动到他机器|options|command|timeout|cancelled|2–4/);

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
