import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyData, findHost, readData, upsertHost, writeData, type SshHost } from './Hosts.js';
import {
  TailBuffer,
  buildRemoteScript,
  buildSshArgs,
  createRemoteContext,
  shellQuote,
  type RemoteContext,
} from './Remote.js';
import { renderPromptSection } from './Prompt.js';
import { createTools, findMutatingHint, formatResult, formatSessionResult, type ToolDeps } from './Tools.js';
import type { PluginToolDescriptor } from '@packages/mica-tools/PluginTool.js';
import { createPanelHandler } from './Panel.js';
import { PANEL_STATE_FILE } from './Panel.js';
import { createNoopScope, normalizeScopeState, scopedHosts, type SshScope } from './Scope.js';
import type { PluginPanelView } from '@packages/mica-plugin/index.js';

let dir = '';
let ctx: RemoteContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-ssh-'));
  ctx = createRemoteContext({ dataDir: dir, tailLines: 5, persistSeconds: 60 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function hostDraft(overrides: Record<string, unknown> = {}) {
  return { id: 'test', host: '10.0.0.1', user: 'root', port: 22, auth: 'key' as const, keyPath: '~/.ssh/id_ed25519', ...overrides };
}

function makeHost(overrides: Partial<SshHost> = {}): SshHost {
  return {
    id: 'test',
    host: '10.0.0.1',
    port: 22,
    user: 'root',
    auth: 'key',
    keyPath: '~/.ssh/id_ed25519',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('主机清单', () => {
  it('缺文件时是一份空清单', () => {
    expect(readData(join(dir, 'data.json'))).toMatchObject({ version: 1, hosts: [] });
  });

  it('手工改坏的 JSON 当成空清单，不让整个插件起不来', () => {
    const file = join(dir, 'data.json');
    writeFileSync(file, '{ not json', 'utf8');
    expect(readData(file).hosts).toEqual([]);
  });

  it('写盘能原样读回，并记下配置页要显示的那行摘要', () => {
    const file = join(dir, 'data.json');
    const data = emptyData();
    data.hosts.push(makeHost());
    writeData(file, data);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { hostsSummary: string };
    expect(parsed.hostsSummary).toBe('1 台（test）');
    expect(readData(file).hosts.map((host) => host.id)).toEqual(['test']);
  });

  it('拒绝不合法的别名与缺字段的机器', () => {
    const data = emptyData();
    expect(() => upsertHost(data, hostDraft({ id: '有 空格' }))).toThrow();
    expect(() => upsertHost(data, hostDraft({ host: '' }))).toThrow();
    expect(() => upsertHost(data, hostDraft({ user: '' }))).toThrow();
    expect(() => upsertHost(data, hostDraft({ auth: 'key', keyPath: '' }))).toThrow();
  });

  it('新增同一别名是更新而不是重复', () => {
    const first = upsertHost(emptyData(), hostDraft({ label: '测试机' }));
    expect(first.created).toBe(true);
    const second = upsertHost(first.data, hostDraft({ label: '换了个用途' }));
    expect(second.created).toBe(false);
    expect(second.data.hosts).toHaveLength(1);
    expect(second.data.hosts[0]?.label).toBe('换了个用途');
  });

  it('端口与只读标记按类型归一化', () => {
    const outcome = upsertHost(emptyData(), hostDraft({ port: '2222', readOnly: 'yes' }));
    expect(outcome.host.port).toBe(2222);
    expect(outcome.host.readOnly).toBe(true);
  });

  it('按别名或地址都能找到，找不到就是 null', () => {
    const data = upsertHost(emptyData(), hostDraft()).data;
    expect(findHost(data, 'test')?.host).toBe('10.0.0.1');
    expect(findHost(data, '10.0.0.1')?.id).toBe('test');
    expect(findHost(data, 'nope')).toBeNull();
  });
});

describe('ssh 参数', () => {
  it('没有指纹时首次接受并记录，有指纹后严格校验', () => {
    const first = buildSshArgs(ctx, makeHost(), { control: true });
    expect(first).toContain('StrictHostKeyChecking=accept-new');
    const later = buildSshArgs(ctx, makeHost({ fingerprint: 'SHA256:abc' }), { control: true });
    expect(later).toContain('StrictHostKeyChecking=yes');
  });

  it('known_hosts 用插件自己的那一份，且不隐藏全局文件', () => {
    const args = buildSshArgs(ctx, makeHost(), { control: true });
    expect(args.some((arg) => arg.endsWith('known_hosts'))).toBe(true);
    expect(args).toContain('GlobalKnownHostsFile=/dev/null');
    expect(args).toContain('HashKnownHosts=no');
  });

  it('连接复用只在一次性执行时开，持久会话不复用', () => {
    expect(buildSshArgs(ctx, makeHost(), { control: true })).toContain('ControlMaster=auto');
    expect(buildSshArgs(ctx, makeHost(), { control: false, pty: true })).toContain('ControlMaster=no');
  });

  it('`-tt` 排在目标主机之前，否则它会变成远端命令的一部分', () => {
    const args = buildSshArgs(ctx, makeHost(), { control: false, pty: true });
    expect(args.indexOf('-tt')).toBe(args.length - 2);
    expect(args[args.length - 1]).toBe('root@10.0.0.1');
  });

  it('密码认证禁掉公钥，私钥认证带回 -i', () => {
    const password = buildSshArgs(ctx, makeHost({ auth: 'password' }), { control: true });
    expect(password).toContain('PubkeyAuthentication=no');
    const key = buildSshArgs(ctx, makeHost(), { control: true });
    expect(key).toContain('-i');
    expect(key).toContain('IdentitiesOnly=yes');
  });

  it('端口出现在 -p 后面', () => {
    const args = buildSshArgs(ctx, makeHost({ port: 2202 }), { control: true });
    expect(args[args.indexOf('-p') + 1]).toBe('2202');
  });
});

describe('远端脚本', () => {
  it('cwd 失败就中止，而不是在当前目录里跑下去', () => {
    const script = buildRemoteScript({ script: 'pwd', cwd: '/srv/app' });
    expect(script).toContain("cd -- '/srv/app' || { echo");
    expect(script).toContain('exit 97');
  });

  it('写了 remoteLog 才 tee 到远端，只读查询不留文件', () => {
    expect(buildRemoteScript({ script: 'ls', remoteLog: '/tmp/mica.log' })).toContain('tee "$__mica_log"');
    expect(buildRemoteScript({ script: 'ls' })).not.toContain('tee');
  });

  it('退出码是脚本的，不是 tee 的', () => {
    expect(buildRemoteScript({ script: 'false' })).toContain('set -o pipefail');
  });

  it('单引号路径不会把脚本拼坏', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe('输出裁剪', () => {
  it('只留最后 N 行，但报告总行数', () => {
    const tail = new TailBuffer(3);
    tail.push('1\n2\n3\n4\n5\n');
    expect(tail.text()).toBe('3\n4\n5');
    expect(tail.totalLines).toBe(5);
    expect(tail.truncated).toBe(true);
  });

  it('没超上限时一行不少、也不算截断', () => {
    const tail = new TailBuffer(10);
    tail.push('a\nb\n');
    expect(tail.text()).toBe('a\nb');
    expect(tail.totalLines).toBe(2);
    expect(tail.truncated).toBe(false);
  });

  it('末尾没有换行的半行也算一行', () => {
    const tail = new TailBuffer(10);
    tail.push('a\nb');
    expect(tail.text()).toBe('a\nb');
    expect(tail.totalLines).toBe(2);
  });
});

describe('给模型的结果', () => {
  it('成功时带退出码、耗时，超长时给出远端日志路径', () => {
    const text = formatResult(makeHost(), {
      exitCode: 0,
      output: 'ok',
      totalLines: 400,
      truncated: true,
      logPath: '/tmp/mica-ssh-1.log',
      durationMs: 1200,
      timedOut: false,
      aborted: false,
    });
    expect(text).toContain('[test] exit=0');
    expect(text).toContain('/tmp/mica-ssh-1.log');
    expect(text).toContain('400 行');
  });

  it('超时说清「已经中断，久的用 ssh_session」', () => {
    const text = formatResult(makeHost(), {
      exitCode: null,
      output: '',
      totalLines: 0,
      truncated: false,
      logPath: null,
      durationMs: 500,
      timedOut: true,
      aborted: false,
      error: '超过 120s 没结束，已中断。更久的任务用 ssh_session',
    });
    expect(text).toContain('失败');
    expect(text).toContain('ssh_session');
  });

  it('会话等待超时说明还能继续等', () => {
    const text = formatSessionResult('test', { output: 'tick1', exitCode: null, timedOut: true }, Date.now(), 10);
    expect(text).toContain('还在跑');
    expect(text).toContain('wait');
  });

  it('会话断了要求重新 open', () => {
    expect(formatSessionResult('test', { output: '', exitCode: null, timedOut: false, dead: true }, Date.now(), 10)).toContain('open');
  });
});

describe('工具对只读机器的约束', () => {
  /** 默认把这台机器放进本次会话：工具的行为由会话范围决定，与只读约束是两件事。 */
  function toolsFor(host: SshHost, inSession = true) {
    const dataFile = join(dir, 'data.json');
    const data = emptyData();
    data.hosts.push(host);
    writeData(dataFile, data);
    const registered = new Map<string, PluginToolDescriptor>();
    const deps: ToolDeps = {
      ctx,
      dataFile,
      scope: {
        explicit: () => (inSession ? [host.id] : []),
        set: () => {},
      } as SshScope,
      sessions: new (class {
        list() {
          return [];
        }
      })() as never,
      register: (tool) => {
        const descriptor = tool as PluginToolDescriptor;
        registered.set(descriptor.name, descriptor);
        return {
          dispose: () => {
            registered.delete(descriptor.name);
          },
        };
      },
    };
    createTools(deps);
    return registered;
  }

  it('只读机器上 ssh_run 直接拒绝，并且不跑任何命令', async () => {
    const tools = toolsFor(makeHost({ readOnly: true }));
    const result = await tools.get('ssh_run')!.execute({ host: 'test', script: 'echo hi' });
    expect(String(result)).toContain('只读');
    expect(String(result)).not.toContain('[test] exit');
  });

  it('ssh_read 在只读机器上照常可用', async () => {
    const tools = toolsFor(makeHost({ readOnly: true }));
    expect(tools.get('ssh_read')!.readOnly).toBe(true);
    // 没网络时它会在连接阶段失败，但绝不会被前端的「只读主机」检查挡下来。
    expect(tools.get('ssh_read')!.name).toBe('ssh_read');
  });

  it('ssh_read 拒掉明显的写命令，并指向 ssh_run', async () => {
    const tools = toolsFor(makeHost());
    const result = await tools.get('ssh_read')!.execute({ host: 'test', script: 'rm -rf /tmp/x' });
    expect(String(result)).toContain('ssh_run');
  });

  it('不认识的别名给出可操作的提示', async () => {
    const tools = toolsFor(makeHost());
    const result = await tools.get('ssh_run')!.execute({ host: 'nope', script: 'echo hi' });
    expect(String(result)).toContain('找不到服务器');
    expect(String(result)).toContain('test');
  });

  it('没添加到本次会话的机器：拒绝执行，并指向面板里的勾选框', async () => {
    const tools = toolsFor(makeHost(), false);
    const result = await tools.get('ssh_run')!.execute({ host: 'test', script: 'echo hi' });
    expect(String(result)).toContain('没有添加到本次会话');
    expect(String(result)).toContain('添加到会话');
    expect(String(result)).not.toContain('[test] exit');
  });
});

describe('只读工具的命令护栏', () => {
  it('挡掉明显的写操作', () => {
    for (const script of ['rm -rf /srv', 'echo x > /etc/hosts', 'mkfs.ext4 /dev/sdb', 'systemctl restart api', 'kill -9 1', 'apt-get install -y nginx']) {
      expect(findMutatingHint(script), script).not.toBeNull();
    }
  });

  it('放行普通查询', () => {
    for (const script of ['ps aux | head', 'df -h', 'tail -n 50 /var/log/app.log', 'grep -r "500" /var/log/nginx', 'systemctl status api', 'cat /etc/os-release']) {
      expect(findMutatingHint(script), script).toBeNull();
    }
  });
});

describe('prompt 段落', () => {
  it('没配置机器时指向面板，不让模型自己 ssh', () => {
    const text = renderPromptSection([]);
    expect(text).toContain('「SSH」');
    expect(text).not.toContain('ssh_run');
  });

  it('配了机器但一台都没进本次会话时，让模型请用户去勾', () => {
    const text = renderPromptSection([], 3);
    expect(text).toContain('3 台服务器');
    expect(text).toContain('添加到会话');
    expect(text).not.toContain('`test` —');
  });

  it('列机器时只说别名、账号与认证方式，不带口令', () => {
    const text = renderPromptSection([makeHost({ label: '测试机', auth: 'password' })]);
    expect(text).toContain('`test` — root@10.0.0.1:22');
    expect(text).toContain('测试机');
    expect(text).toContain('密码认证');
    expect(text).toContain('ssh_read');
    expect(text).not.toContain('id_ed25519');
  });

  it('只读机器标出来', () => {
    expect(renderPromptSection([makeHost({ readOnly: true })])).toContain('只读');
  });
});

describe('配置面板', () => {
  function setupPanel(options: { autoAdd?: boolean; explicit?: string[] | null } = {}) {
    const dataFile = join(dir, 'data.json');
    const data = emptyData();
    data.hosts.push(makeHost(options.autoAdd ? { autoAdd: true } : {}));
    writeData(dataFile, data);
    const closed: string[] = [];
    const changes: number[] = [];
    let explicit: string[] | null = options.explicit ?? null;
    const scope: SshScope = {
      explicit: () => explicit,
      set: (ids) => {
        explicit = [...ids];
      },
    };
    const panel = createPanelHandler({
      ctx,
      dataFile,
      scope,
      closeSession: (id) => closed.push(id),
      onHostsChange: () => changes.push(Date.now()),
    });
    return { panel, dataFile, closed, changes, scope: () => explicit };
  }

  it('服务器是一张表：名称 / 地址 / 状态 / 操作 / 两列勾选', async () => {
    const { panel } = setupPanel();
    const view = (await panel.view({ role: 'default' })) as PluginPanelView;
    const section = view.sections?.find((entry) => entry.title === '服务器');
    expect(section?.table?.columns.map((column) => column.key)).toEqual([
      'name',
      'address',
      'status',
      'actions',
      'session',
      'auto',
    ]);
    const row = section?.table?.rows[0];
    expect(row?.key).toBe('test');
    expect(row?.cells.name?.text).toBe('test');
    expect(row?.cells.address?.text).toBe('root@10.0.0.1:22');
    expect(row?.cells.status).toMatchObject({ text: '未测试', tone: 'muted' });
    expect(row?.actions?.map((action) => action.id)).toEqual(['edit', 'delete']);
    // 没有全局开关，也不再摊一份条目列表。
    expect(section?.fields).toBeUndefined();
    expect(section?.items).toBeUndefined();
  });

  it('一台都没添加进会话时没有状态条，勾上才出现', async () => {
    const { panel } = setupPanel();
    const view = (await panel.view({ role: 'default' })) as PluginPanelView;
    expect(view.statusBar).toBeUndefined();
    expect(view.sections?.[0]?.subtitle).toContain('模型看不到');

    await panel.action({ action: 'toggle-session', key: 'test', values: { column: 'session', check: 'true' } });
    const after = (await panel.view({ role: 'default' })) as PluginPanelView;
    expect(after.statusBar).toMatchObject({ label: 'test', detail: '未测试', section: '服务器' });
    expect(after.sections?.[0]?.subtitle).toContain('模型可以用');
  });

  it('「添加到会话」只改本次会话，不动主机清单', async () => {
    const { panel, dataFile, scope } = setupPanel();
    const result = await panel.action({
      action: 'toggle-session',
      key: 'test',
      values: { column: 'session', check: 'true' },
    });
    expect(result).toMatchObject({ message: expect.stringContaining('添加到本次会话') });
    expect(scope()).toEqual(['test']);
    expect(readData(dataFile).hosts[0]?.autoAdd).toBeUndefined();

    await panel.action({ action: 'toggle-session', key: 'test', values: { check: 'false' } });
    expect(scope()).toEqual([]);
  });

  it('「自动添加到会话」写进主机清单，新会话因此默认带上它', async () => {
    const { panel, dataFile } = setupPanel();
    await panel.action({ action: 'toggle-auto', key: 'test', values: { check: 'true' } });
    expect(readData(dataFile).hosts[0]?.autoAdd).toBe(true);

    // 另一条会话（显式清单还是 null）读到的就是自动勾上的那台。
    const fresh = (await panel.view({ role: 'default' })) as PluginPanelView;
    expect(fresh.statusBar).toMatchObject({ label: 'test' });
    expect(fresh.sections?.[0]?.table?.rows[0]?.cells.session?.check?.checked).toBe(true);
  });

  it('第一次勾选会保留「自动添加」那些机器', async () => {
    const dataFile = join(dir, 'data.json');
    const data = emptyData();
    data.hosts.push(makeHost({ autoAdd: true }));
    data.hosts.push(makeHost({ id: 'prod', host: '10.0.0.2', autoAdd: false }));
    writeData(dataFile, data);
    let explicit: string[] | null = null;
    const panel = createPanelHandler({
      ctx,
      dataFile,
      scope: {
        explicit: () => explicit,
        set: (ids) => {
          explicit = [...ids];
        },
      },
      closeSession: () => {},
    });
    await panel.action({ action: 'toggle-session', key: 'prod', values: { check: 'true' } });
    expect(explicit).toEqual(['test', 'prod']);
  });

  it('连接成功后把这台机器加进本次会话，并记下状态', async () => {
    const dataFile = join(dir, 'data.json');
    writeData(dataFile, emptyData());
    let explicit: string[] | null = null;
    const panel = createPanelHandler({
      ctx,
      dataFile,
      scope: {
        explicit: () => explicit,
        set: (ids) => {
          explicit = [...ids];
        },
      },
      closeSession: () => {},
    });
    // 连不上（地址不可达）时不该加进会话，也不该留下「已连接」。
    const result = await panel.action({
      action: 'connect',
      values: { id: 'test', host: '127.0.0.1', port: '1', user: 'root', auth: 'key', keyPath: '~/.ssh/nope' },
    });
    expect(result).toMatchObject({ message: expect.stringContaining('连接失败') });
    const view = (await panel.view({ role: 'default' })) as PluginPanelView;
    expect(view.statusBar).toBeUndefined();
    expect(view.sections?.[0]?.table?.rows[0]?.cells.status).toMatchObject({ text: expect.stringContaining('连不上') });
    expect(view.sections?.[0]?.rows?.[0]?.label).toContain('连不上（test）');
  });

  it('一台机器都没有时表格不画，只留一句空态', async () => {
    const dataFile = join(dir, 'empty.json');
    writeData(dataFile, emptyData());
    const panel = createPanelHandler({ ctx, dataFile, scope: createNoopScope(), closeSession: () => {} });
    const view = (await panel.view({ role: 'default' })) as PluginPanelView;
    expect(view.sections?.[0]?.table).toBeUndefined();
    expect(view.sections?.[0]?.empty).toContain('「添加」');
  });

  it('删除要两步：先记下、再确认', async () => {
    const { panel, dataFile } = setupPanel();
    const asked = await panel.action({ action: 'delete', key: 'test' });
    expect(asked).toMatchObject({ message: expect.stringContaining('确认删除') });
    expect(readData(dataFile).hosts).toHaveLength(1);

    await panel.action({ action: 'confirm-delete' });
    expect(readData(dataFile).hosts).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(dir, PANEL_STATE_FILE), 'utf8')).pendingDelete).toBeUndefined();
  });

  it('编辑时把当前值填回输入框，私钥模式不出现密码字段', async () => {
    const { panel } = setupPanel();
    await panel.action({ action: 'edit', key: 'test' });
    const view = (await panel.view({ role: 'default' })) as PluginPanelView;
    const draft = view.sections?.find((entry) => entry.title === '编辑 · test');
    expect(draft?.fields?.find((field) => field.key === 'host')?.value).toBe('10.0.0.1');
    expect(draft?.fields?.find((field) => field.key === 'keyPath')?.value).toBe('~/.ssh/id_ed25519');
    expect(draft?.fields?.find((field) => field.key === 'password')).toBeUndefined();
    // 面板不再收「用途」，编辑时也不能把它从已有机器上抹掉。
    expect(draft?.fields?.find((field) => field.key === 'label')).toBeUndefined();
  });

  it('切到密码认证才出现口令字段，且口令永远不回填', async () => {
    const { panel } = setupPanel();
    await panel.action({ action: 'edit', key: 'test' });
    await panel.action({ action: 'draft', values: { id: 'test', host: '10.0.0.1', user: 'root', auth: 'password' } });
    const view = (await panel.view({ role: 'default' })) as PluginPanelView;
    const draft = view.sections?.find((entry) => entry.title === '编辑 · test');
    expect(draft?.fields?.find((field) => field.key === 'password')).toMatchObject({
      type: 'password',
      value: '',
    });
    expect(draft?.fields?.find((field) => field.key === 'keyPath')).toBeUndefined();
    expect(draft?.actions?.map((action) => action.id)).toEqual(['connect', 'cancel']);
  });

  it('连接时校验不过就把原因回给用户，而不是抛错', async () => {
    const { panel } = setupPanel();
    const result = await panel.action({ action: 'connect', values: { id: 'bad id', host: 'x', user: 'root' } });
    expect(result).toMatchObject({ message: expect.stringContaining('连接失败') });
  });
});

describe('会话范围决定模型能看到什么', () => {
  function fakeContext(home: string) {
    const registered: string[] = [];
    let panelHandler: { view: unknown; action: unknown } | null = null;
    let sessionState: unknown;
    const ctx = {
      pluginId: 'ssh',
      paths: { config: home },
      settings: { get: () => ({}) },
      tools: {
        register: (tool: { name: string }) => {
          registered.push(tool.name);
          return { dispose: () => registered.splice(registered.indexOf(tool.name), 1) };
        },
      },
      prompt: { section: () => ({ dispose: () => {} }) },
      sessionState: {
        get: () => sessionState,
        set: (value: unknown) => {
          sessionState = value;
        },
      },
      desktop: {
        panel: (handler: unknown) => {
          panelHandler = handler as { view: unknown; action: unknown };
          return { dispose: () => {} };
        },
      },
      onDispose: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      health: { report: () => {} },
    };
    return { ctx, registered, panel: () => panelHandler };
  }

  it('没有机器时不注册工具，加了一台就注册四个，删掉又全部注销', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-ssh-home-'));
    const dataFile = join(home, 'plugin-data', 'ssh', 'data.json');
    writeData(dataFile, emptyData());
    const fake = fakeContext(home);
    const setup = (await import('./index.js')).default;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setup(fake.ctx as any);
    expect(fake.registered).toEqual([]);

    const panel = fake.panel();
    expect(panel).not.toBeNull();
    const handler = panel as unknown as {
      action: (input: { action: string; key?: string; values?: Record<string, string> }) => Promise<unknown>;
    };
    writeData(dataFile, { ...emptyData(), hosts: [makeHost()] });
    // 加机器走的是面板的「连接」（会连一次网）；这里直接确认同步入口认清单。
    await handler.action({ action: 'toggle-auto', key: 'test', values: { check: 'true' } });
    expect(fake.registered).toEqual([]);

    // 再起一个宿主，清单里已经有机器 → 工具在 setup 时就注册好了。
    const second = fakeContext(home);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setup(second.ctx as any);
    expect(second.registered.sort()).toEqual(['ssh_hosts', 'ssh_read', 'ssh_run', 'ssh_session']);

    const secondHandler = second.panel() as unknown as {
      action: (input: { action: string; key?: string; values?: Record<string, string> }) => Promise<unknown>;
    };
    await secondHandler.action({ action: 'delete', key: 'test' });
    await secondHandler.action({ action: 'confirm-delete' });
    expect(second.registered).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('会话范围', () => {
  it('没改过会话清单时跟随「自动添加」，改过就以显式清单为准', () => {
    const data = emptyData();
    data.hosts.push(makeHost({ autoAdd: true }));
    data.hosts.push(makeHost({ id: 'prod', host: '10.0.0.2', autoAdd: false }));
    expect(scopedHosts(data, null).map((host) => host.id)).toEqual(['test']);
    expect(scopedHosts(data, ['prod']).map((host) => host.id)).toEqual(['prod']);
  });

  it('显式清单里已经删掉的机器不再生效', () => {
    const data = emptyData();
    data.hosts.push(makeHost());
    expect(scopedHosts(data, ['test', 'gone']).map((host) => host.id)).toEqual(['test']);
  });

  it('会话状态的形状不对时当「没改过」，不让脏数据挡住默认值', () => {
    expect(normalizeScopeState(undefined)).toBeNull();
    expect(normalizeScopeState({ added: 'test' })).toBeNull();
    expect(normalizeScopeState({ added: ['test', 3, '  ', 'prod'] })).toEqual(['test', 'prod']);
  });
});
