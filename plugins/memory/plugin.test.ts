import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { ensureDomain } from './domains.js';
import { clearRepoIdentityCache, resolveRepoIdentity } from './repo.js';

/**
 * 记忆插件的集成测试。
 *
 * 记忆按适用范围分三层（profile / project / domain），所以每条用例都要交代「这段会话
 * 在哪个仓库里」：仓库用只含 `.git/config` 的临时目录伪造（身份解析只读文件，不跑 git）。
 * 注入断言要区分「当前会话适用的层」与「磁盘上存在的层」——在 A 仓库写下的项目记忆
 * 不该出现在 B 仓库的提示词里。
 */

const tempDirs: string[] = [];

/** realpath：macOS 的 /var 指向 /private/var，而领域匹配比较的是真实路径。 */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mica-memory-plugin-')));
  tempDirs.push(dir);
  return dir;
}

/** 最小仓库：只有 `.git/config`，识别身份够用，不需要真的 git 二进制。 */
function makeRepo(name: string, remote?: string): string {
  const root = join(tempDir(), name);
  mkdirSync(join(root, '.git'), { recursive: true });
  const config = ['[core]', '\trepositoryformatversion = 0'];
  if (remote) config.push('[remote "origin"]', `\turl = ${remote}`);
  writeFileSync(join(root, '.git', 'config'), `${config.join('\n')}\n`, 'utf-8');
  return root;
}

/** 项目记忆文件：slug 由仓库身份（归一化后的远端地址 / common dir）算出。 */
function memoryFile(home: string, cwd: string): string {
  const repo = resolveRepoIdentity(cwd);
  if (!repo) throw new Error(`not inside a repository: ${cwd}`);
  return join(home, 'memory', 'projects', `${repo.slug}.md`);
}

function profileFile(home: string): string {
  return join(home, 'memory', 'PROFILE.md');
}

afterEach(() => {
  clearRepoIdentityCache();
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
  home?: string;
  settings?: PluginSettingValues;
  issues?: PluginSettingIssue[];
  messages?: { role: string; content: unknown }[];
  curatorOutput?: string;
  /** 依次返回：第 n 次整理请求用第 n 个（用完后重复最后一个）。 */
  curatorOutputs?: string[];
  curatorStatus?: 'completed' | 'partial' | 'failed' | 'killed';
  withSubagents?: boolean;
  /** 会话的工作目录；默认造一个新的最小仓库。 */
  cwd?: string;
  /** 可变的 cwd，用来模拟会话中途 `/cd`。 */
  cwdRef?: { current: string };
  sessionIdRef?: { current: string };
  mode?: 'session' | 'one-shot';
  curatorCompletion?: () => Promise<string>;
};

function createHarness(options: HarnessOptions = {}) {
  const home = options.home ?? tempDir();
  const cwd = options.cwd ?? makeRepo('mica', 'git@git.example.com:team/mica.git');
  const currentCwd = () => options.cwdRef?.current ?? cwd;
  const hooks = new HookRegistry();
  const commands = new micaCommands.CommandRegistry();
  const tools: MemoryTool[] = [];
  const activeTools = new Set<MemoryTool>();
  const promptSections: { id: string; order?: number; render(): string }[] = [];
  const healthReports: { level: string; message: string; hint?: string }[] = [];
  const shown: string[] = [];
  const subagentTypes: PluginSubagentType[] = [];
  const disposers: (() => void)[] = [];
  const runs: { type?: string; prompt: string }[] = [];
  const signals: AbortSignal[] = [];
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
      describe: () => ({ id: options.sessionIdRef?.current ?? 'session-1', title: 'test', cwd: currentCwd() }),
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
        activeTools.add(tool);
        return {
          dispose: () => {
            activeTools.delete(tool);
          },
        };
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
            run: async (request: { type?: string; prompt: string; signal: AbortSignal }) => {
              runs.push({ type: request.type, prompt: request.prompt });
              signals.push(request.signal);
              return {
                taskId: 'task-1',
                status: options.curatorStatus ?? ('completed' as const),
                output: options.curatorCompletion ? await options.curatorCompletion() : nextCuratorOutput(),
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
    cwd,
    currentCwd,
    hooks,
    commands,
    tools,
    activeTools,
    settings,
    promptSections,
    healthReports,
    shown,
    subagentTypes,
    runs,
    signals,
    models,
    disposers,
    async emitTurnAfter(event: Record<string, unknown> = { outcome: 'completed', owner: {} }) {
      await hooks.emit('turn:after', event);
    },
    emitToolCall(name: string, args: Record<string, unknown>, owner: object = {}) {
      hooks.emit('agent:observe', { type: 'tool:call', name, args: JSON.stringify(args), owner });
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
      activity: 'maintenance',
      allowedTools: [],
      writeMode: 'none',
      contextModeDefault: 'none',
      maxTurns: 1,
    });
    expect(harness.healthReports.at(-1)).toMatchObject({ level: 'ok' });
  });

  it('counts only the layers that apply to the session, not every file on disk', () => {
    const harness = createHarness();

    const text = harness.promptSections[0]!.render();

    // 没有任何适用内容时整段消失，避免每个新会话都为一句占位文案付 token。
    expect(text).toBe('');
    expect(text).not.toContain('### 用户档案');
    // 仓库里的会话适用 profile + 当前仓库两层。
    expect(harness.healthReports.at(-1)?.message).toContain('本会话注入 2 层 · 0 条');
  });

  it('leaves the prompt and tools off while retaining the command when memory is disabled', () => {
    const harness = createHarness({ settings: { enabled: 'false' } });

    expect(harness.tools).toHaveLength(0);
    expect(harness.promptSections[0]!.render()).toBe('');
    expect(harness.commands.list().map((command) => command.name)).toEqual(['memory']);
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
  it('applies changes to enabled without restarting and refuses calls to an old tool', async () => {
    const harness = createHarness({ settings: { autoCapture: 'true' } });
    const section = harness.promptSections[0]!;
    await harness.tools[0]!.execute({ scope: 'profile', operations: [{ action: 'add', content: '偏好中文' }] });
    expect(section.render()).toContain('已知事实（记忆）');

    const staleTool = harness.tools[0]!;
    harness.settings.enabled = 'false';
    await expect(
      staleTool.execute({ scope: 'profile', operations: [{ action: 'add', content: '不该保存' }] }),
    ).rejects.toThrow(/disabled/);
    expect(section.render()).toBe('');
    expect(harness.activeTools.size).toBe(0);
    await harness.emitTurnAfter();
    expect(harness.runs).toHaveLength(0);

    harness.settings.enabled = 'true';
    expect(section.render()).toContain('偏好中文');
    expect(harness.activeTools.size).toBe(1);
    expect(existsSync(profileFile(harness.home))).toBe(true);
  });

  it('clamps what is injected but keeps every entry in the file', async () => {
    const harness = createHarness({ settings: { profileCharLimit: '200' } });
    const tool = harness.tools[0]!;
    const older = '甲'.repeat(150);
    const newer = '乙'.repeat(150);

    const result = await tool.execute({
      scope: 'profile',
      operations: [
        { action: 'add', content: older },
        { action: 'add', content: newer },
      ],
    });

    // 预算是注入额度，不是写入限制：两条 150 字符的记忆照样落盘，注入时只挑得下一条。
    expect(result).toContain('302/200 characters');
    expect(result).toContain('over its injection budget');
    const onDisk = readFileSync(profileFile(harness.home), 'utf-8');
    expect(onDisk).toContain(older);
    expect(onDisk).toContain(newer);

    const section = harness.promptSections[0]!;
    expect(section.render()).toContain('### 用户档案（另有 1 条更早的未展示）');
    expect(section.render()).toContain('- ' + older);
    expect(section.render()).not.toContain(newer);

    // 预算随快照一起冻结：会话中途调大不会改变这一轮已注入的内容。
    harness.settings.profileCharLimit = '2000';
    expect(section.render()).toContain('（另有 1 条更早的未展示）');
  });

  it('freezes the section until /memory refresh is run', async () => {
    const harness = createHarness();
    const section = harness.promptSections[0]!;

    expect(section.render()).not.toContain('项目用 bun');
    await harness.tools[0]!.execute({ scope: 'project', operations: [{ action: 'add', content: '项目用 bun' }] });
    expect(section.render()).not.toContain('项目用 bun');

    await harness.commands.execute('/memory refresh');
    expect(section.render()).toContain('项目用 bun');
  });

  it('refreshes only the current session and leaves other frozen snapshots intact', async () => {
    const sessionIdRef = { current: 'first' };
    const harness = createHarness({ sessionIdRef });
    const tool = harness.tools[0]!;
    const section = harness.promptSections[0]!;
    await tool.execute({ scope: 'profile', operations: [{ action: 'add', content: '原有偏好' }] });
    expect(section.render()).toContain('原有偏好');
    sessionIdRef.current = 'second';
    expect(section.render()).toContain('原有偏好');
    await tool.execute({
      scope: 'profile',
      operations: [{ action: 'patch', old_text: '原有偏好', content: '新的偏好' }],
    });

    sessionIdRef.current = 'first';
    await harness.commands.execute('/memory refresh');
    expect(section.render()).toContain('新的偏好');
    sessionIdRef.current = 'second';
    expect(section.render()).toContain('原有偏好');
    expect(section.render()).not.toContain('新的偏好');
  });

  it('swaps only the project layer when the session moves to another repository', async () => {
    const alpha = makeRepo('alpha', 'git@git.example.com:team/alpha.git');
    const beta = makeRepo('beta', 'git@git.example.com:team/beta.git');
    const cwdRef = { current: alpha };
    const harness = createHarness({ cwdRef, cwd: alpha });
    const section = harness.promptSections[0]!;

    await harness.tools[0]!.execute({ scope: 'profile', operations: [{ action: 'add', content: '偏好中文' }] });
    await harness.tools[0]!.execute({ scope: 'project', operations: [{ action: 'add', content: 'alpha 用 pnpm' }] });
    await harness.commands.execute('/memory refresh');
    expect(section.render()).toContain('alpha 用 pnpm');

    cwdRef.current = beta;
    const afterSwitch = section.render();

    // 项目层换成 beta 的（空）；profile 不跟着 cwd 变。
    expect(afterSwitch).not.toContain('alpha 用 pnpm');
    expect(afterSwitch).not.toContain('项目记忆 · alpha');
    expect(afterSwitch).toContain('偏好中文');
  });
});

describe('memory scope layering', () => {
  it('shares project memory across every directory of the same repository', async () => {
    const home = tempDir();
    const repo = makeRepo('mica-code', 'git@git.example.com:team/mica-code.git');
    const nested = join(repo, 'apps', 'desktop');
    mkdirSync(nested, { recursive: true });

    const atRoot = createHarness({ home, cwd: repo });
    await atRoot.tools[0]!.execute({ scope: 'project', operations: [{ action: 'add', content: '桌面端用 vite' }] });

    const inSubdir = createHarness({ home, cwd: nested });

    expect(inSubdir.promptSections[0]!.render()).toContain('桌面端用 vite');
    expect(memoryFile(home, nested)).toBe(memoryFile(home, repo));
  });

  it('does not inject the project memory of another repository', async () => {
    const home = tempDir();
    const alpha = makeRepo('alpha', 'git@git.example.com:team/alpha.git');
    const beta = makeRepo('beta', 'git@git.example.com:team/beta.git');

    const alphaSession = createHarness({ home, cwd: alpha });
    await alphaSession.tools[0]!.execute({
      scope: 'project',
      operations: [{ action: 'add', content: 'alpha 用 pnpm' }],
    });
    expect(alphaSession.promptSections[0]!.render()).toContain('alpha 用 pnpm');

    const betaSession = createHarness({ home, cwd: beta });
    const text = betaSession.promptSections[0]!.render();

    expect(text).not.toContain('alpha 用 pnpm');
    expect(text).toBe('');
    expect(existsSync(memoryFile(home, alpha))).toBe(true);
  });

  it('injects only the profile layer outside any repository and refuses project writes', async () => {
    const harness = createHarness({ cwd: tempDir() });
    const tool = harness.tools[0]!;

    await tool.execute({ scope: 'profile', operations: [{ action: 'add', content: '偏好中文' }] });

    const text = harness.promptSections[0]!.render();
    expect(text).toContain('### 用户档案');
    expect(text).toContain('- 偏好中文');
    expect(text).not.toContain('### 项目记忆');
    expect(harness.healthReports.at(-1)?.message).toContain('本会话注入 1 层 · 0 条');

    await expect(
      tool.execute({ scope: 'project', operations: [{ action: 'add', content: '无处安放' }] }),
    ).rejects.toThrow(/no repository/);
  });

  it('injects a domain layer only where the domain covers the working directory', async () => {
    const home = tempDir();
    const zuche = makeRepo('mis', 'git@git.example.com:zuche/mis.git');
    const other = makeRepo('mica-code', 'git@git.example.com:team/mica-code.git');
    ensureDomain(join(home, 'memory'), '租车', [zuche]);

    const inside = createHarness({ home, cwd: zuche });
    const written = await inside.tools[0]!.execute({
      scope: 'domain',
      domain: '租车',
      operations: [{ action: 'add', content: '灰度字段在 mis 的 API 里' }],
    });

    expect(written).toContain('领域记忆 · 租车');
    expect(inside.promptSections[0]!.render()).toContain('灰度字段在 mis 的 API 里');

    const outside = createHarness({ home, cwd: other });
    const text = outside.promptSections[0]!.render();
    expect(text).not.toContain('灰度字段在 mis 的 API 里');
    expect(text).not.toContain('领域记忆');

    await expect(
      outside.tools[0]!.execute({
        scope: 'domain',
        domain: '租车',
        operations: [{ action: 'add', content: '不该写进去' }],
      }),
    ).rejects.toThrow(/does not cover/);
  });
});

describe('memory target repository', () => {
  it('writes to the repository the task actually touched, not the session directory', async () => {
    const home = tempDir();
    const session = makeRepo('mis', 'git@git.example.com:zuche/mis.git');
    const target = makeRepo('sass', 'git@git.example.com:zuche/sass.git');
    const harness = createHarness({ home, cwd: session });

    harness.emitToolCall('write_file', { file_path: join(target, 'src/order-table.ts') });
    const result = await harness.tools[0]!.execute({
      operations: [{ action: 'add', content: '订单表列宽由 CSS grid 控制' }],
    });

    expect(result).toContain('项目记忆 · sass（本次任务目标）');
    expect(readFileSync(memoryFile(home, target), 'utf-8')).toContain('订单表列宽由 CSS grid 控制');
    expect(existsSync(memoryFile(home, session))).toBe(false);
  });

  it('injects the memory of the touched repository into the running session', async () => {
    const home = tempDir();
    const session = makeRepo('mis', 'git@git.example.com:zuche/mis.git');
    const target = makeRepo('sass', 'git@git.example.com:zuche/sass.git');
    const writer = createHarness({ home, cwd: target });
    await writer.tools[0]!.execute({
      scope: 'project',
      operations: [{ action: 'add', content: 'sass 用 melos 工作区' }],
    });

    const harness = createHarness({ home, cwd: session });
    // 还没碰目标仓库：它的记忆不该出现，否则又退化成「全量注入」。
    expect(harness.promptSections[0]!.render()).not.toContain('sass 用 melos 工作区');

    harness.emitToolCall('apply_patch', { patch: `*** Begin Patch\n*** Update File: ${join(target, 'src/a.ts')}` });

    const text = harness.promptSections[0]!.render();
    expect(text).toContain('sass 用 melos 工作区');
    expect(text).toContain('### 项目记忆 · sass（本次任务目标）');
  });

  it('does not pull in a repository that was only glanced at', async () => {
    const home = tempDir();
    const session = makeRepo('mis', 'git@git.example.com:zuche/mis.git');
    const other = makeRepo('sass', 'git@git.example.com:zuche/sass.git');
    const writer = createHarness({ home, cwd: other });
    await writer.tools[0]!.execute({
      scope: 'project',
      operations: [{ action: 'add', content: 'sass 用 melos 工作区' }],
    });

    const harness = createHarness({ home, cwd: session });
    harness.emitToolCall('read_file', { file_path: join(other, 'README.md') });

    expect(harness.promptSections[0]!.render()).not.toContain('sass 用 melos 工作区');
  });

  it('ignores tool calls from another session', async () => {
    const home = tempDir();
    const session = makeRepo('mis', 'git@git.example.com:zuche/mis.git');
    const target = makeRepo('sass', 'git@git.example.com:zuche/sass.git');
    const harness = createHarness({ home, cwd: session });

    harness.emitToolCall('write_file', { file_path: join(target, 'src/a.ts') }, {});
    const result = await harness.tools[0]!.execute({ operations: [] });

    // 观察桶按 owner 隔离：默认渲染与命令用同一个「无 owner」桶，因此这里看得到。
    expect(result).toContain('sass');
  });
});

describe('memory auto capture', () => {
  it('reads only the recent message budget while retaining the minimum conversation threshold', async () => {
    let reads = 0;
    const messages = Array.from({ length: 20_000 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      get content() {
        reads += 1;
        return `message ${index}`;
      },
    }));
    const harness = createHarness({ settings: { maxMessages: '2' }, messages });
    await harness.commands.execute('/memory review');
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.prompt).toContain('message 19999');
    expect(harness.runs[0]?.prompt).not.toContain('message 19997');
    expect(reads).toBe(8);
  });

  it('does not retry malformed output after automatic capture is switched off', async () => {
    let finish: (text: string) => void = () => {};
    const harness = createHarness({
      settings: { autoCapture: 'true' },
      messages: thread(['偏好中文', '好的']),
      curatorCompletion: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    });
    await harness.emitTurnAfter();
    harness.settings.autoCapture = 'false';
    finish('invalid JSON');
    await vi.waitFor(() => expect(readdirSync(join(harness.home, 'memory', 'curator.lock.owners'))).toEqual([]));
    expect(harness.runs).toHaveLength(1);
    expect(harness.signals[0]?.aborted).toBe(true);
    expect(existsSync(profileFile(harness.home))).toBe(false);
  });

  it('records a paid attempt before awaiting its response, so a cancelled review is still throttled', async () => {
    let finish: (text: string) => void = () => {};
    const harness = createHarness({
      settings: { autoCapture: 'true', minIntervalMinutes: '60' },
      messages: thread(['偏好中文', '好的']),
      curatorCompletion: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    });
    await harness.emitTurnAfter();
    expect(existsSync(join(harness.home, 'memory', 'state.json'))).toBe(true);
    harness.settings.enabled = 'false';
    harness.promptSections[0]!.render();
    finish('{"operations":[]}');
    await vi.waitFor(() => expect(readdirSync(join(harness.home, 'memory', 'curator.lock.owners'))).toEqual([]));
    harness.settings.enabled = 'true';
    await harness.emitTurnAfter();
    expect(harness.runs).toHaveLength(1);
  });

  it('writes a delayed review to the repository it reviewed after the session changes directory', async () => {
    const alpha = makeRepo('alpha', 'git@git.example.com:team/alpha.git');
    const beta = makeRepo('beta', 'git@git.example.com:team/beta.git');
    const cwdRef = { current: alpha };
    let finish: (text: string) => void = () => {};
    const harness = createHarness({
      cwdRef,
      cwd: alpha,
      messages: thread(['alpha 用 pnpm', '记住了']),
      curatorCompletion: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    });

    const review = harness.commands.execute('/memory review');
    await vi.waitFor(() => expect(harness.runs).toHaveLength(1));
    cwdRef.current = beta;
    finish('{"operations":[{"scope":"project","action":"add","content":"alpha 用 pnpm"}]}');
    await review;

    expect(readFileSync(memoryFile(harness.home, alpha), 'utf-8')).toBe('alpha 用 pnpm\n');
    expect(existsSync(memoryFile(harness.home, beta))).toBe(false);
  });

  it('serializes curator requests across hosts sharing the memory directory', async () => {
    let finish: (text: string) => void = () => {};
    const common: HarnessOptions = {
      settings: { autoCapture: 'true', minIntervalMinutes: '60' },
      messages: thread(['偏好中文', '好的']),
    };
    const first = createHarness({
      ...common,
      curatorCompletion: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    });
    const second = createHarness({ ...common, home: first.home });

    await first.emitTurnAfter();
    await second.emitTurnAfter();
    expect(first.runs).toHaveLength(1);
    expect(second.runs).toHaveLength(0);
    finish('{"operations":[]}');
    await vi.waitFor(() => expect(existsSync(join(first.home, 'memory', 'state.json'))).toBe(true));
    await second.emitTurnAfter();
    expect(second.runs).toHaveLength(0);
    expect(readdirSync(join(first.home, 'memory', 'curator.lock.owners'))).toEqual([]);
  });

  it('drops a delayed response after the plugin is disposed', async () => {
    let finish: (text: string) => void = () => {};
    const harness = createHarness({
      messages: thread(['偏好中文', '好的']),
      curatorCompletion: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    });
    const review = harness.commands.execute('/memory review');
    await vi.waitFor(() => expect(harness.runs).toHaveLength(1));
    for (const dispose of [...harness.disposers].reverse()) dispose();
    finish('{"operations":[{"scope":"project","action":"add","content":"偏好中文"}]}');
    await review;
    expect(existsSync(memoryFile(harness.home, harness.cwd))).toBe(false);
    expect(readdirSync(join(harness.home, 'memory', 'curator.lock.owners'))).toEqual([]);
  });

  it('records thrown request errors so failures also respect the global interval', async () => {
    const harness = createHarness({
      settings: { autoCapture: 'true', minIntervalMinutes: '60' },
      messages: thread(['偏好中文', '好的']),
      curatorCompletion: async () => {
        throw new Error('network disconnected');
      },
    });
    const statePath = join(harness.home, 'memory', 'state.json');
    await harness.emitTurnAfter();
    await vi.waitFor(() => expect(JSON.parse(readFileSync(statePath, 'utf-8')).lastError).toBe('network disconnected'));
    await harness.emitTurnAfter();
    expect(harness.runs).toHaveLength(1);
  });

  it('does not run the curator when auto capture is off', async () => {
    const harness = createHarness();

    await harness.emitTurnAfter();

    expect(harness.runs).toHaveLength(0);
  });

  it('applies each operation to the scope the curator chose', async () => {
    const home = tempDir();
    const repo = makeRepo('mica-code', 'git@git.example.com:team/mica-code.git');
    ensureDomain(join(home, 'memory'), '租车', [repo]);
    const harness = createHarness({
      home,
      cwd: repo,
      settings: { autoCapture: 'true' },
      messages: thread(['以后测试都用 bun run test', '记住了。']),
      curatorOutput: JSON.stringify({
        operations: [
          { scope: 'project', action: 'add', content: '测试命令：bun run test' },
          { scope: 'domain', domain: '租车', action: 'add', content: '灰度字段在 mis 的 API 里' },
        ],
      }),
    });

    await harness.emitTurnAfter();

    await vi.waitFor(() => expect(harness.healthReports.at(-1)?.message).toContain('应用 2 条'));
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.type).toBe('memory-curator');
    expect(harness.runs[0]?.prompt).toContain('以后测试都用 bun run test');
    expect(harness.runs[0]?.prompt).toContain('可用的领域：租车');
    expect(readFileSync(memoryFile(home, repo), 'utf-8')).toBe('测试命令：bun run test\n');
    const domainText = readFileSync(join(home, 'memory', 'domains', '租车.md'), 'utf-8');
    // 领域文件头部的 `match` 不能被正文写入吃掉。
    expect(domainText).toContain('match:');
    expect(domainText).toContain(repo);
    expect(domainText).toContain('灰度字段在 mis 的 API 里');
  });

  it('rejects profile operations from the curator instead of writing the user profile', async () => {
    const harness = createHarness({
      settings: { autoCapture: 'true' },
      messages: thread(['偏好中文', '好']),
      curatorOutput: JSON.stringify({
        operations: [{ scope: 'profile', action: 'add', content: '用户偏好中文' }],
      }),
    });

    await harness.emitTurnAfter();

    await vi.waitFor(() =>
      expect(harness.healthReports.at(-1)).toMatchObject({
        level: 'warn',
        message: expect.stringContaining('1 项未能写入'),
      }),
    );
    expect(harness.healthReports.at(-1)?.hint).toContain('profile');
    expect(existsSync(profileFile(harness.home))).toBe(false);
    const state = JSON.parse(readFileSync(join(harness.home, 'memory', 'state.json'), 'utf-8'));
    expect(state.lastApplied).toBe(0);
    expect(state.lastError).toContain('profile');
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

  it('uses maxMessages as an input cap rather than making the conversation permanently too short', async () => {
    const harness = createHarness({
      settings: { autoCapture: 'true', maxMessages: '2' },
      messages: thread(['偏好中文', '好的']),
    });

    await harness.emitTurnAfter();
    await vi.waitFor(() => expect(existsSync(join(harness.home, 'memory', 'state.json'))).toBe(true));

    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.prompt).toContain('偏好中文');
    expect(harness.runs[0]?.prompt).not.toContain('先看下这个仓库');
  });

  it('respects the configured interval between runs', async () => {
    const harness = createHarness({
      settings: { autoCapture: 'true', minIntervalMinutes: '60' },
      messages: thread(['偏好中文', '好的']),
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
        '{"operations":[{"scope":"project","action":"add","content":"用户偏好中文"}]}',
      ],
    });

    await harness.emitTurnAfter();

    await vi.waitFor(() => expect(readFileSync(memoryFile(harness.home, harness.cwd), 'utf-8')).toBe('用户偏好中文\n'));
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
      curatorOutput: JSON.stringify({ operations: [{ scope: 'project', action: 'add', content: '偏好中文' }] }),
    });

    await harness.emitTurnAfter();

    await vi.waitFor(() => expect(readFileSync(memoryFile(harness.home, harness.cwd), 'utf-8')).toBe('偏好中文\n'));
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
        operations: [{ scope: 'project', action: 'add', content: '独立接口写入的一条' }],
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
      expect(readFileSync(memoryFile(harness.home, harness.cwd), 'utf-8')).toBe('独立接口写入的一条\n'),
    );
  });
});

describe('memory command', () => {
  it('reports the layers that apply to this session and the curator mode', async () => {
    const harness = createHarness();

    await harness.commands.execute('/memory status');

    expect(harness.shown.at(-1)).toContain('用户档案：0 条');
    expect(harness.shown.at(-1)).toContain('项目记忆 · mica：0 条');
    expect(harness.shown.at(-1)).toContain('仓库：mica');
    expect(harness.shown.at(-1)).toContain('自动整理：关闭');
    expect(harness.shown.at(-1)).toContain(join(harness.home, 'memory'));
  });

  it('runs a manual review even when auto capture is off', async () => {
    const harness = createHarness({
      messages: thread(['用 pnpm', '好']),
      curatorOutput: JSON.stringify({ operations: [{ scope: 'project', action: 'add', content: '用 pnpm' }] }),
    });

    await harness.commands.execute('/memory review');

    expect(harness.runs).toHaveLength(1);
    expect(harness.shown.at(-1)).toContain('记忆整理完成');
  });

  it('lists entries per layer and rejects unknown layers', async () => {
    const harness = createHarness();
    await harness.tools[0]!.execute({ scope: 'profile', operations: [{ action: 'add', content: '偏好中文' }] });

    await harness.commands.execute('/memory list profile');
    expect(harness.shown.at(-1)).toContain('1. 偏好中文');

    await harness.commands.execute('/memory list project');
    expect(harness.shown.at(-1)).toContain('项目记忆 · mica 还没有任何记忆。');

    await harness.commands.execute('/memory list nope');
    expect(harness.shown.at(-1)).toContain('未知的记忆层');
  });

  it('creates a domain from the command and marks it as covering this session', async () => {
    const harness = createHarness();

    await harness.commands.execute('/memory domain new 租车');
    expect(harness.shown.at(-1)).toContain('已创建领域「租车」');

    await harness.commands.execute('/memory domain list');
    expect(harness.shown.at(-1)).toContain('● 租车');

    await harness.commands.execute('/memory list domain 租车');
    expect(harness.shown.at(-1)).toContain('领域记忆 · 租车 还没有任何记忆。');
  });
});
