import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import { createPluginLlmApi } from '@packages/mica-plugin/index.js';
import { HookRegistry } from '@packages/mica-plugin/HookRegistry.js';
import type {
  PluginContext,
  PluginSettingIssue,
  PluginSettingValues,
  PluginSubagentType,
} from '@packages/mica-plugin/index.js';
import setup from './index.js';
import type { MemoryTool } from './MemoryTool.js';
import { projectSlug } from './store.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-memory-plugin-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 整理门槛是 8 条消息（约 4 轮）：真实会话都有这个体量，一两句寒暄不值得花钱整理。
 * 用例只需要一两轮核心内容时，用固定背景轮次把输入补到门槛以上。
 */
function thread(...core: [string, string][]): { role: string; content: string }[] {
  const padding: [string, string][] = [
    ['先看下这个仓库', '好的，我先看目录结构。'],
    ['继续', '已经看完了，结构不复杂。'],
    ['接下来做什么？', '等你给下一步指令。'],
  ];
  return [...padding, ...core].flatMap(([user, assistant]) => [
    { role: 'user', content: user },
    { role: 'assistant', content: assistant },
  ]);
}

type HarnessOptions = {
  settings?: PluginSettingValues;
  issues?: PluginSettingIssue[];
  messages?: { role: string; content: unknown }[];
  curatorOutput?: string;
  /** 依次返回：第 n 次整理请求用第 n 个（用完后重复最后一个）。 */
  curatorOutputs?: string[];
  curatorStatus?: 'completed' | 'partial' | 'failed' | 'killed';
  withSubagents?: boolean;
  cwd?: string;
  /** 可变的 cwd，用来模拟会话中途 `/cd`。 */
  cwdRef?: { current: string };
  mode?: 'session' | 'one-shot';
};

function createHarness(options: HarnessOptions = {}) {
  const home = tempDir();
  const hooks = new HookRegistry();
  const commands = new micaCommands.CommandRegistry();
  const tools: MemoryTool[] = [];
  const promptSections: { id: string; order?: number; render(): string }[] = [];
  const healthReports: { level: string; message: string; hint?: string }[] = [];
  const shown: string[] = [];
  const subagentTypes: PluginSubagentType[] = [];
  const disposers: (() => void)[] = [];
  const runs: { type?: string; prompt: string }[] = [];
  const models: { purpose: string; system: string; user: string }[] = [];

  const settings: PluginSettingValues = {
    enabled: 'true',
    autoCapture: 'false',
    curatorMode: 'subagent',
    minIntervalMinutes: '0',
    maxMessages: '30',
    ...options.settings,
  };
  const curatorOutput = options.curatorOutput ?? '{"operations":[]}';
  const curatorOutputs = options.curatorOutputs ?? [curatorOutput];
  let curatorOutputIndex = 0;
  const nextCuratorOutput = () =>
    curatorOutputs[Math.min(curatorOutputIndex++, curatorOutputs.length - 1)] ?? '{"operations":[]}';

  const ctx = {
    pluginId: 'memory',
    paths: { home, config: home, plugins: join(home, 'plugins') },
    services: {},
    hooks,
    commands,
    agent: { mode: options.mode ?? 'session' },
    events: {},
    session: {
      describe: () => ({
        id: 'session-1',
        title: 'test',
        cwd: options.cwdRef?.current ?? options.cwd ?? '/repo/mica',
      }),
      messages: () => options.messages ?? [],
      rename: () => true,
    },
    settings: {
      path: join(home, 'plugin-settings', 'memory.json'),
      get: () => settings,
      validate: () => options.issues ?? [],
    },
    tools: {
      register: (tool: MemoryTool) => {
        tools.push(tool);
        return { dispose() {} };
      },
    },
    prompt: {
      section: (section: { id: string; order?: number; render(): string }) => {
        promptSections.push(section);
        return { dispose() {} };
      },
    },
    health: {
      path: null,
      read: () => null,
      report: (report: { level: string; message: string; hint?: string }) => healthReports.push(report),
      clear() {},
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ui: { showMessage: (text: string) => shown.push(text) },
    // 真组件 + 假底层：插件走的就是 `ctx.llm` 这条路。
    llm: createPluginLlmApi({
      spec: {},
      readValues: () => settings,
      models: async (request) => {
        models.push(request);
        return { text: nextCuratorOutput(), usage: null };
      },
    }),
    onDispose: (dispose: () => void) => disposers.push(dispose),
    subagents:
      options.withSubagents === false
        ? undefined
        : {
            registerType: (type: PluginSubagentType) => {
              subagentTypes.push(type);
              return { dispose() {} };
            },
            listTypes: () => subagentTypes,
            getType: () => null,
            run: async (request: { type?: string; prompt: string }) => {
              runs.push({ type: request.type, prompt: request.prompt });
              return {
                taskId: 'task-1',
                status: options.curatorStatus ?? ('completed' as const),
                output: nextCuratorOutput(),
              };
            },
            background: () => ({ taskId: 'task-1', done: Promise.resolve({ status: 'completed' as const }) }),
            tasks: { list: () => [], get: () => null, kill: () => false, wait: async () => [] },
            caller: () => null,
          },
  } as unknown as PluginContext;

  setup(ctx);

  return {
    home,
    hooks,
    commands,
    tools,
    promptSections,
    healthReports,
    shown,
    subagentTypes,
    runs,
    models,
    disposers,
    async emitTurnAfter(event: Record<string, unknown> = { outcome: 'completed', owner: {} }) {
      await hooks.emit('turn:after', event);
    },
  };
}

describe('memory plugin setup', () => {
  it('registers the tool, the frozen prompt section, the command, the hook, and the curator type', () => {
    const harness = createHarness();

    expect(harness.tools).toHaveLength(1);
    expect(harness.tools[0]?.name).toBe('memory');
    expect(harness.promptSections).toHaveLength(1);
    expect(harness.promptSections[0]).toMatchObject({ id: 'memory', order: 900 });
    expect(harness.commands.list().map((command) => command.name)).toEqual(['memory']);
    expect(harness.subagentTypes[0]).toMatchObject({
      name: 'memory-curator',
      allowedTools: [],
      writeMode: 'none',
      contextModeDefault: 'none',
      maxTurns: 1,
    });
    expect(harness.healthReports.at(-1)).toMatchObject({ level: 'ok' });
  });

  it('renders project memory for the session working directory', () => {
    const harness = createHarness({ cwd: '/repo/mica' });
    const section = harness.promptSections[0]!;

    expect(section.render()).toContain('当前还没有保存任何记忆');
    expect(harness.healthReports.at(-1)?.message).toContain('0 条');
  });

  it('does nothing when memory is disabled', () => {
    const harness = createHarness({ settings: { enabled: 'false' } });

    expect(harness.tools).toHaveLength(0);
    expect(harness.promptSections).toHaveLength(0);
    expect(harness.commands.list()).toHaveLength(0);
    expect(harness.healthReports.at(-1)?.message).toContain('已关闭');
  });

  it('warns when auto capture uses the direct provider without credentials', () => {
    const harness = createHarness({
      settings: { autoCapture: 'true', curatorMode: 'direct', useMainProvider: 'false' },
    });

    expect(harness.healthReports.at(-1)).toMatchObject({
      level: 'warn',
      message: expect.stringContaining('独立接口'),
    });
  });
});

describe('memory prompt snapshot', () => {
  it('freezes the section until /memory refresh is run', async () => {
    const harness = createHarness();
    const section = harness.promptSections[0]!;

    expect(section.render()).not.toContain('项目用 bun');
    await harness.tools[0]!.execute({ target: 'memory', operations: [{ action: 'add', content: '项目用 bun' }] });
    expect(section.render()).not.toContain('项目用 bun');

    await harness.commands.execute('/memory refresh');
    expect(section.render()).toContain('项目用 bun');
  });

  it('swaps only project memory when the session changes directory', async () => {
    const cwdRef = { current: '/repo/alpha' };
    const harness = createHarness({ cwdRef, cwd: '/repo/alpha' });
    const section = harness.promptSections[0]!;

    await harness.tools[0]!.execute({ target: 'user', operations: [{ action: 'add', content: '偏好中文' }] });
    await harness.tools[0]!.execute({ target: 'project', operations: [{ action: 'add', content: 'alpha 用 pnpm' }] });
    await harness.commands.execute('/memory refresh');
    expect(section.render()).toContain('alpha 用 pnpm');

    cwdRef.current = '/repo/beta';
    const afterSwitch = section.render();

    // 项目记忆必须换；user / memory 仍按快照冻结，不因为 /cd 重读磁盘。
    expect(afterSwitch).not.toContain('alpha 用 pnpm');
    expect(afterSwitch).toContain('偏好中文');
  });
});

describe('memory auto capture', () => {
  it('does not run the curator when auto capture is off', async () => {
    const harness = createHarness();

    await harness.emitTurnAfter();

    expect(harness.runs).toHaveLength(0);
  });

  it('runs the curator after a completed turn and applies the operations', async () => {
    const harness = createHarness({
      settings: { autoCapture: 'true' },
      messages: thread(['以后测试都用 bun run test', '记住了。']),
      curatorOutput: JSON.stringify({
        operations: [
          { target: 'user', action: 'add', content: '用户要求测试用 bun run test' },
          { target: 'project', action: 'add', content: '测试命令：bun run test' },
        ],
      }),
    });

    await harness.emitTurnAfter();

    await vi.waitFor(() => expect(harness.runs).toHaveLength(1));
    expect(harness.runs[0]?.type).toBe('memory-curator');
    expect(harness.runs[0]?.prompt).toContain('以后测试都用 bun run test');
    await vi.waitFor(() =>
      expect(readFileSync(join(harness.home, 'memory', 'USER.md'), 'utf-8')).toBe('用户要求测试用 bun run test\n'),
    );
    expect(
      readFileSync(join(harness.home, 'memory', 'projects', projectSlug('/repo/mica'), 'MEMORY.md'), 'utf-8'),
    ).toBe('测试命令：bun run test\n');
    expect(harness.healthReports.at(-1)?.message).toContain('应用 2 条');
  });

  it('skips aborted turns', async () => {
    const harness = createHarness({ settings: { autoCapture: 'true' } });

    await harness.emitTurnAfter({ outcome: 'aborted', owner: {} });

    expect(harness.runs).toHaveLength(0);
  });

  it('skips one-shot hosts where there is no next session to benefit from memory', async () => {
    const harness = createHarness({
      settings: { autoCapture: 'true' },
      messages: [
        { role: 'user', content: '以后测试都用 bun' },
        { role: 'assistant', content: '好' },
      ],
      mode: 'one-shot',
    });

    await harness.emitTurnAfter();

    expect(harness.runs).toHaveLength(0);
  });

  it('skips conversations that are too short to contain a durable fact', async () => {
    const harness = createHarness({
      settings: { autoCapture: 'true' },
      messages: [{ role: 'user', content: '你好' }],
    });

    await harness.emitTurnAfter();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.runs).toHaveLength(0);
  });

  it('respects the configured interval between runs', async () => {
    const harness = createHarness({
      settings: { autoCapture: 'true', minIntervalMinutes: '60' },
      messages: thread(['偏好中文', '好的']),
      curatorOutput: JSON.stringify({ operations: [{ target: 'user', action: 'add', content: '偏好中文' }] }),
    });

    await harness.emitTurnAfter();
    await vi.waitFor(() => expect(harness.runs).toHaveLength(1));
    await vi.waitFor(() => expect(existsSync(join(harness.home, 'memory', 'state.json'))).toBe(true));
    await harness.emitTurnAfter();

    expect(harness.runs).toHaveLength(1);
  });

  it('reports a curator failure without breaking the turn', async () => {
    const harness = createHarness({
      settings: { autoCapture: 'true' },
      messages: thread(['记住这个', '好']),
      curatorOutput: '这不是 JSON',
    });

    await harness.emitTurnAfter();
    await vi.waitFor(() => expect(harness.healthReports.at(-1)).toMatchObject({ level: 'warn' }));
    // 解析失败会重试一次，两次都不可用才上报失败。
    expect(harness.runs).toHaveLength(2);
    expect(harness.runs[1]?.prompt).toContain('<correction>');
  });

  it('retries once when the curator falls back to another schema', async () => {
    const harness = createHarness({
      settings: { autoCapture: 'true' },
      messages: thread(['偏好中文', '好']),
      curatorOutputs: [
        // 真实模型（codex 系网关）会这样回。
        '{"operations":[{"op":"add","path":"/repo/demo","value":"偏好中文"}]}',
        '{"operations":[{"target":"user","action":"add","content":"用户偏好中文"}]}',
      ],
    });

    await harness.emitTurnAfter();

    await vi.waitFor(() =>
      expect(readFileSync(join(harness.home, 'memory', 'USER.md'), 'utf-8')).toBe('用户偏好中文\n'),
    );
    expect(harness.runs).toHaveLength(2);
    expect(harness.runs[1]?.prompt).toContain('unsupported shape');
  });

  it('works without subagents when the hosted runner is absent', async () => {
    const harness = createHarness({ withSubagents: false });

    await expect(harness.emitTurnAfter()).resolves.toBeUndefined();
    expect(harness.subagentTypes).toHaveLength(0);
  });

  it('asks for the direct provider when a manual review has no subagent runner', async () => {
    const harness = createHarness({
      withSubagents: false,
      messages: thread(['记住这条', '好']),
    });

    await harness.commands.execute('/memory review');

    expect(harness.shown.at(-1)).toContain('不提供子代理能力');
  });

  it('accepts a partial curator response when it still carries JSON', async () => {
    const harness = createHarness({
      settings: { autoCapture: 'true' },
      messages: thread(['偏好中文', '好']),
      curatorStatus: 'partial',
      curatorOutput: JSON.stringify({ operations: [{ target: 'user', action: 'add', content: '偏好中文' }] }),
    });

    await harness.emitTurnAfter();

    await vi.waitFor(() => expect(readFileSync(join(harness.home, 'memory', 'USER.md'), 'utf-8')).toBe('偏好中文\n'));
  });

  it('uses the configured provider instead of a subagent in direct mode', async () => {
    const harness = createHarness({
      settings: {
        autoCapture: 'true',
        curatorMode: 'direct',
        useMainProvider: 'false',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        model: 'cheap-model',
      },
      messages: thread(['记住这条', '好']),
      curatorOutput: JSON.stringify({
        operations: [{ target: 'user', action: 'add', content: '独立接口写入的一条' }],
      }),
    });

    await harness.emitTurnAfter();

    await vi.waitFor(() => expect(harness.models).toHaveLength(1));
    expect(harness.runs).toHaveLength(0);
    expect(harness.models[0]).toMatchObject({
      purpose: '整理记忆',
      model: 'cheap-model',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-test',
      protocol: 'openai_chat_completions',
    });
    await vi.waitFor(() =>
      expect(readFileSync(join(harness.home, 'memory', 'USER.md'), 'utf-8')).toBe('独立接口写入的一条\n'),
    );
  });
});

describe('memory command', () => {
  it('reports usage and the curator mode', async () => {
    const harness = createHarness();

    await harness.commands.execute('/memory status');

    expect(harness.shown.at(-1)).toContain('用户档案（user）');
    expect(harness.shown.at(-1)).toContain('自动整理：关闭');
    expect(harness.shown.at(-1)).toContain(join(harness.home, 'memory'));
  });

  it('runs a manual review even when auto capture is off', async () => {
    const harness = createHarness({
      messages: thread(['用 pnpm', '好']),
      curatorOutput: JSON.stringify({ operations: [{ target: 'project', action: 'add', content: '用 pnpm' }] }),
    });

    await harness.commands.execute('/memory review');

    expect(harness.runs).toHaveLength(1);
    expect(harness.shown.at(-1)).toContain('记忆整理完成');
  });

  it('lists entries and rejects unknown stores', async () => {
    const harness = createHarness();
    await harness.tools[0]!.execute({ target: 'user', operations: [{ action: 'add', content: '偏好中文' }] });

    await harness.commands.execute('/memory list user');
    expect(harness.shown.at(-1)).toContain('1. 偏好中文');

    await harness.commands.execute('/memory list nope');
    expect(harness.shown.at(-1)).toContain('未知的记忆块');
  });
});
