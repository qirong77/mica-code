import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mitt from 'mitt';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import { writePluginState } from '@packages/mica-plugin/PluginState.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { micaSession } from '@packages/mica-session/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { HeadlessTurnExecutor } from '../runtime/HeadlessTurnExecutor.js';
import { createHeadlessPluginHost, startAsSubmit } from './HeadlessPluginHost.js';

function mockAgent(overrides: Record<string, unknown> = {}): AgentRuntime {
  return {
    events: mitt(),
    config: { provider: { id: 'test-provider', contextWindowSize: 1_000_000 }, model: 'test-model', effort: 'medium' },
    getSnapshot: () => ({
      providerId: 'test-provider',
      model: 'test-model',
      effort: 'medium',
      role: 'default',
      messages: [],
      usageHistory: [],
      lastUsage: undefined,
    }),
    toConversationMessages: () => [],
    captureClientSnapshot: () => null,
    restoreClientSnapshot: () => {},
    registerTextRollbackConsumer: () => () => {},
    clearSession: () => {},
    reserveRunId: () => 1,
    isCurrent: () => true,
    run: async () => ({ runId: 1, text: 'ok' }),
    abort: () => {},
    preserveAbortedTurn: () => true,
    promptSections: new micaPlugin.PluginPromptSections(),
    // 官方插件在渲染提示词段落时读自己的会话状态（session-notes 就这么做）。
    getPluginState: () => undefined,
    setPluginState: () => {},
    clearPluginState: () => {},
    ...overrides,
  } as unknown as AgentRuntime;
}

function mockSessionController(saveSpy: ReturnType<typeof vi.fn>): SessionController {
  return {
    getCurrentSessionId: () => 'sess-headless',
    acquireTurnLease: () => micaSession.acquireTurnLease('sess-headless'),
    // 官方插件会在 turn:before 里读展示标题（session-rename），桩缺了它整条 hook 会抛错。
    getCurrentDisplayTitle: () => 'headless test session',
    getCurrentTitleSource: () => 'derived',
    // describe() 会读它：桩缺了这个方法，插件 setup 里的 describe() 直接抛，
    // 整批插件注册中断（表现为「memory 工具不见了」）。
    getParentSessionId: () => null,
    getConversationMessages: () => [],
    saveCurrent: saveSpy,
    refreshFromStore: () => null,
    startNewSession: () => {},
    renameCurrent: () => {},
    list: () => [],
    listRecent: () => [],
    load: () => null,
    resume: () => ({ ok: false, message: 'n/a' }),
  } as unknown as SessionController;
}

async function mount(
  saveSpy = vi.fn(() => true),
  agentOverrides: Record<string, unknown> = {},
  hostOptions: { desktopHost?: boolean; loadUserPlugins?: boolean } = {},
) {
  const hooks = new micaPlugin.HookRegistry();
  const agent = mockAgent(agentOverrides);
  const sessionController = mockSessionController(saveSpy);
  const subagentTasks = {
    killForOwner: () => 0,
    list: () => [],
    stop: async () => {},
    setRestartHandler: () => {},
  };
  const executor = new HeadlessTurnExecutor({
    agent,
    sessionController,
    onEvent: () => {},
    parseImageRefs: (text: string) => Promise.resolve(text),
  });
  const host = createHeadlessPluginHost({
    hooks,
    agent,
    sessionController,
    subagentTasks: subagentTasks as never,
    ...hostOptions,
    isBusy: () => executor.isBusy,
    submit: (text, options) => startAsSubmit((input) => executor.start(input), text, options),
  });
  executor.attachPluginLayer({
    hooks: host.hooks,
    host,
    queue: host.queue,
    getConversationMessages: host.getConversationMessages,
    notices: host.notices,
  });
  await host.emitRuntimeStart();
  return { agent, executor, host, hooks };
}

function toolNames(): string[] {
  return micaTools.getDefinitions().map((tool) => tool.name);
}

describe('HeadlessPluginHost (headless === TUI plugin surface)', () => {
  it.skipIf(process.platform !== 'darwin')(
    'only the desktop host gets the computer-use skill (requires: ["desktop"])',
    async () => {
      const headless = await mount();
      expect(micaSkills.getLoaded().some((skill) => skill.name === 'computer-use')).toBe(false);
      await headless.host.dispose();

      const desktop = await mount(
        vi.fn(() => true),
        {},
        { desktopHost: true },
      );
      const skill = micaSkills.getLoaded().find((entry) => entry.name === 'computer-use');
      expect(skill).toBeDefined();
      // 落盘路径必须是真目录，正文里的占位符要换成它
      expect(skill?.baseDir).toBe(join(process.env.MICA_HOME!, 'computer-use'));
      expect(skill?.content).toContain(skill!.baseDir);
      expect(existsSync(join(skill!.baseDir, 'scripts', 'desktop.mjs'))).toBe(true);
      await desktop.host.dispose();

      // 卸载后注册随之消失，否则下一个宿主会看到别人的能力
      expect(micaSkills.getLoaded().some((entry) => entry.name === 'computer-use')).toBe(false);
    },
  );

  it('registers the session-autonomy tools and todo_write', async () => {
    const { host } = await mount();
    const names = toolNames();
    for (const expected of ['session_peers', 'todo_write']) {
      expect(names).toContain(expected);
    }
    // session_info / session_compact were removed: the model must not see them again.
    expect(names).not.toContain('session_info');
    await host.dispose();
  });

  it('loads the memory plugin: `memory` tool plus a session-scoped prompt section', async () => {
    // 自带的 MICA_HOME：不读用户真实的 ~/.mica/memory，内容也由这条用例决定。
    const home = mkdtempSync(join(tmpdir(), 'mica-memory-host-'));
    vi.stubEnv('MICA_HOME', home);
    mkdirSync(join(home, 'memory'), { recursive: true });
    writeFileSync(join(home, 'memory', 'PROFILE.md'), '用户偏好中文\n', 'utf-8');
    try {
      const { agent, host } = await mount();
      expect(toolNames()).toContain('memory');
      // 段落按会话读盘并冻结；headless 宿主与 TUI 共用同一份能力面。
      const prompt = agent.promptSections.render();
      expect(prompt).toContain('### 用户档案');
      expect(prompt).toContain('用户偏好中文');
      await host.dispose();
      expect(agent.promptSections.render()).not.toContain('### 用户档案');
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('injects the session-autonomy guidance through a host-wrapped prompt section', async () => {
    const { agent, host } = await mount();
    const prompt = agent.promptSections.render();
    expect(prompt).toContain('会话自治');
    expect(prompt).toContain('session_peers');
    expect(prompt).toContain('section="guidance">');
    expect(prompt.indexOf('# 会话记忆')).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf('# 会话记忆')).toBeLessThan(prompt.indexOf('# 会话自治'));
    await host.dispose();
    expect(agent.promptSections.render()).not.toContain('会话自治');
  });

  it('fires turn:before / prompt:build / turn:after in order around a turn', async () => {
    const { executor, hooks, host } = await mount();
    const order: string[] = [];
    const before = hooks.on('turn:before', () => order.push('turn:before'), { pluginId: 'test' });
    const prompt = hooks.on('prompt:build', () => order.push('prompt:build'), { pluginId: 'test' });
    const after = hooks.on('turn:after', () => order.push('turn:after'), { pluginId: 'test' });

    const result = await executor.start(micaRuntime.createRuntimeInput('hello', 'ui'));
    expect(result).toBe('started');
    await waitFor(() => !executor.isBusy);
    expect(order).toEqual(['turn:before', 'prompt:build', 'turn:after']);
    before.dispose();
    prompt.dispose();
    after.dispose();
    await host.dispose();
  });

  it('notices from session tools are persisted into conversationMessages', async () => {
    const saveSpy = vi.fn(() => true);
    const { host } = await mount(saveSpy);
    const commandHost = host.services.get(
      (await import('@packages/mica-builtin-commands/commandHost.js')).commandHostToken,
    );
    commandHost.services.showNotice('session_compact: 完成', 'sess-headless', {
      variant: 'compact',
      command: 'session_compact',
      status: 'success',
    });
    const lastCall = saveSpy.mock.calls.at(-1) as unknown[] | undefined;
    const saved = lastCall?.[0] as unknown as { conversationMessages?: Array<{ role: string; content: string }> };
    expect(saved.conversationMessages?.some((message) => message.role === 'notice')).toBe(true);
    expect(host.getConversationMessages()?.some((message) => message.role === 'notice')).toBe(true);
    await host.dispose();
  });

  // 状态型 notice（压缩到多大、同步到第几页）只该占一行：连着写几次如果在对话里排成一列，
  // 用户看到的是一堵「又一次会话压缩」的墙，而不是「现在多大」。
  it('keeps a single row for notices that ask to replace', async () => {
    const saveSpy = vi.fn(() => true);
    const { host } = await mount(saveSpy);
    const commandHost = host.services.get(
      (await import('@packages/mica-builtin-commands/commandHost.js')).commandHostToken,
    );
    for (const text of ['会话压缩：500K → 90K', '会话压缩：680K → 145K']) {
      commandHost.services.showNotice(text, 'sess-headless', {
        variant: 'compact',
        command: 'session-compact',
        status: 'success',
        replace: true,
      });
    }

    const notices = (host.getConversationMessages() ?? []).filter((message) => message.role === 'notice');
    expect(notices.map((message) => message.content)).toEqual(['会话压缩：680K → 145K']);
    await host.dispose();
  });

  // 启停是配置，而工具与 prompt 段落活在进程里：只改文件不动进程，配置页写着「已停用」、
  // 对话里它的工具还在。这条用例走的是真实装配路径（常驻宿主 + 真轮次）。
  it('applies a plugin toggle at the next turn, without restarting the host', async () => {
    // 这个用例真的写 `plugins-state.json`：给自己的 MICA_HOME，免得落到别的用例头上。
    const home = mkdtempSync(join(tmpdir(), 'mica-plugin-toggle-'));
    vi.stubEnv('MICA_HOME', home);
    try {
      const { executor, host } = await mount(
        vi.fn(() => true),
        {},
        { loadUserPlugins: true },
      );
      const statePath = join(home, 'plugins-state.json');
      const runTurn = async () => {
        await executor.start(micaRuntime.createRuntimeInput('hello', 'ui'));
        await waitFor(() => !executor.isBusy);
      };
      const loadedIds = () =>
        (
          JSON.parse(readFileSync(join(home, 'plugin-status.json'), 'utf8')) as { plugins: { id: string }[] }
        ).plugins.map((entry) => entry.id);

      expect(toolNames()).toContain('todo_write');
      expect(loadedIds()).toContain('todo');

      writePluginState({ disabled: ['todo'] }, { path: statePath });
      await runTurn();
      expect(toolNames()).not.toContain('todo_write');
      expect(loadedIds()).not.toContain('todo');

      writePluginState({ disabled: [] }, { path: statePath });
      await runTurn();
      expect(toolNames()).toContain('todo_write');
      expect(loadedIds()).toContain('todo');
      await host.dispose();
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 5000) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
