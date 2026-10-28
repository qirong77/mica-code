import { describe, expect, it, vi } from 'vitest';
import { micaCommands, type CommandRegistry } from '@packages/mica-commands/index.js';
import type { PluginContext, PluginNoticeOptions, PluginSubagentThread } from '@packages/mica-plugin/index.js';
import setupBtw from './index.js';
import { formatBtwNotice, parseBtwArgs } from './message.js';

/**
 * `/btw` 作为插件的行为：注册形态、进度与结果怎么呈现、`-continue` 复用的是哪条线程、
 * 失败是否对用户可见。宿主能力（真正的子代理、记账、notice 渲染）由宿主自己的测试覆盖，
 * 这里用替身把它们隔开。
 */

describe('parseBtwArgs', () => {
  it('parses a plain question', () => {
    expect(parseBtwArgs('这个方案可行吗')).toEqual({ question: '这个方案可行吗', isContinue: false });
  });

  it('parses a continue with a follow-up', () => {
    expect(parseBtwArgs('-continue 那具体怎么落地')).toEqual({ question: '那具体怎么落地', isContinue: true });
  });

  it('treats empty / continue-only as null', () => {
    expect(parseBtwArgs('')).toBeNull();
    expect(parseBtwArgs('   ')).toBeNull();
    expect(parseBtwArgs('-continue')).toBeNull();
  });
});

describe('formatBtwNotice', () => {
  it('shows the question, answer, and a -continue affordance', () => {
    const notice = formatBtwNotice('这个方案可行吗', '可行。');
    expect(notice).toContain('> 这个方案可行吗');
    expect(notice).toContain('可行。');
    expect(notice).toContain('/btw -continue');
  });

  it('says so when a continue had no thread to continue', () => {
    expect(formatBtwNotice('没有前文', '答案', true)).toContain('没有可延续的 btw 对话');
  });
});

describe('/btw plugin', () => {
  it('registers /btw so it can run while the main flow is busy', () => {
    const harness = makeHarness();
    const command = harness.commands.list().find((item) => item.name === 'btw');
    expect(command).toBeDefined();
    expect(command?.scope).toBe('local-only');
    expect(command?.allowDuringTurn).toBe(true);
    expect(command?.pluginId).toBe('btw');
  });

  it('answers in an isolated thread and reports progress then the result', async () => {
    const harness = makeHarness();
    await harness.run('/btw 这个方案可行吗');

    expect(harness.ask).toHaveBeenCalledWith('这个方案可行吗', { description: '这个方案可行吗' });
    expect(harness.notices[0]).toEqual({
      content: '> 这个方案可行吗\n\n正在思考…',
      options: { command: '/btw', status: 'running', surface: 'command_panel' },
    });
    const last = harness.notices.at(-1);
    expect(last?.content).toContain('> 这个方案可行吗');
    expect(last?.content).toContain('/btw -continue');
    expect(last?.options).toEqual({ command: '/btw', status: 'success' });
  });

  it('gives the thread the main transcript, the session role, and a btw type for accounting', async () => {
    const harness = makeHarness();
    await harness.run('/btw 这个方案可行吗');

    const options = harness.threadOptions[0];
    expect(options.type).toBe('btw');
    expect(options.systemPrompt).toContain('用户：主流程在写代码');
    expect(options.systemPrompt).toContain('<role name="default">');
  });

  it('reuses the same thread on -continue', async () => {
    const harness = makeHarness();
    await harness.run('/btw 这个方案可行吗');
    await harness.run('/btw -continue 那具体怎么落地');

    expect(harness.threadOptions).toHaveLength(1);
    expect(harness.ask).toHaveBeenCalledTimes(2);
    expect(harness.ask).toHaveBeenLastCalledWith('那具体怎么落地', { description: '那具体怎么落地' });
  });

  it('falls back to a new thread and says so when continuing with no prior btw', async () => {
    const harness = makeHarness();
    await harness.run('/btw -continue 没有前文');

    expect(harness.threadOptions).toHaveLength(1);
    expect(harness.notices.at(-1)?.content).toContain('没有可延续的 btw 对话，已作为一条新问题处理');
  });

  it('starts a new thread after the session changed', async () => {
    const harness = makeHarness();
    await harness.run('/btw 第一问');
    harness.setSession('s2');
    await harness.run('/btw 第二问');

    expect(harness.threadOptions).toHaveLength(2);
  });

  it('shows the usage when there is no question', async () => {
    const harness = makeHarness();
    await harness.run('/btw');

    expect(harness.threadOptions).toHaveLength(0);
    expect(harness.notices[0]?.options).toEqual({ command: '/btw', status: 'info' });
  });

  it('reports a failure instead of leaving the running notice on screen', async () => {
    const harness = makeHarness({ ask: vi.fn(async () => Promise.reject(new Error('boom'))) });
    await harness.run('/btw 问题');

    const last = harness.notices.at(-1);
    expect(last?.content).toContain('btw 出错：boom');
    expect(last?.options).toEqual({ command: '/btw', status: 'error' });
  });

  it('reports why the thread could not be created', async () => {
    const harness = makeHarness({ threadError: new Error('未配置 api_key') });
    await harness.run('/btw 问题');

    expect(harness.notices.at(-1)?.content).toContain('btw 暂时不可用：未配置 api_key');
  });

  it('refuses to run without a session', async () => {
    const harness = makeHarness();
    harness.clearSession();
    await harness.run('/btw 问题');

    expect(harness.threadOptions).toHaveLength(0);
    expect(harness.notices.at(-1)?.options).toEqual({ command: '/btw', status: 'error' });
  });

  it('disposes the threads it opened', async () => {
    const harness = makeHarness();
    await harness.run('/btw 问题');
    harness.dispose();

    expect(harness.disposed).toHaveBeenCalledOnce();
  });
});

type Harness = {
  commands: CommandRegistry;
  notices: Array<{ content: string; options?: PluginNoticeOptions }>;
  ask: ReturnType<typeof vi.fn>;
  threadOptions: Array<Record<string, unknown>>;
  disposed: ReturnType<typeof vi.fn>;
  setSession(id: string): void;
  clearSession(): void;
  dispose(): void;
  run(raw: string): Promise<unknown>;
};

function makeHarness(overrides: { ask?: ReturnType<typeof vi.fn>; threadError?: Error } = {}): Harness {
  const commands = new micaCommands.CommandRegistry();
  const notices: Harness['notices'] = [];
  const ask = overrides.ask ?? vi.fn(async () => '答案');
  const disposed = vi.fn();
  const thread: PluginSubagentThread = { ask, usage: () => ({ requests: 1, last: null }), dispose: disposed };
  const threadOptions: Array<Record<string, unknown>> = [];
  const disposes: Array<() => void> = [];
  let session: { id: string; title: string; role: string } | null = { id: 's1', title: 'session', role: 'default' };

  const ctx = {
    pluginId: 'btw',
    commands,
    session: {
      describe: () => session,
      messages: () => [
        { role: 'user', content: '主流程在写代码' },
        { role: 'assistant', content: '收到。' },
      ],
      rename: () => true,
    },
    subagents: {
      thread: (options: Record<string, unknown>) => {
        if (overrides.threadError) throw overrides.threadError;
        threadOptions.push(options);
        return thread;
      },
    },
    ui: {
      submit() {},
      showMessage() {},
      notice(content: string, options?: PluginNoticeOptions) {
        notices.push({ content, options });
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    onDispose(dispose: () => void) {
      disposes.push(dispose);
    },
  } as unknown as PluginContext;

  setupBtw(ctx);

  return {
    commands,
    notices,
    ask,
    threadOptions,
    disposed,
    setSession(id) {
      session = { id, title: id, role: 'default' };
    },
    clearSession() {
      session = null;
    },
    dispose() {
      for (const dispose of disposes) dispose();
    },
    run: (raw) => commands.execute(raw, {}),
  };
}
