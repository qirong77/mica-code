import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { buildPanelView, createPanelHandler, readDrafts } from './Panel.js';
import { materializeBundle, normalizeHost, readDeployState } from './DeployRunner.js';

function fakeContext(values: Record<string, string> = {}): PluginContext {
  const store = { enabled: 'true', relayUrl: '', token: '', ...values };
  return {
    pluginId: 'mobile-relay',
    settings: {
      path: null,
      get: () => ({ ...store }),
      validate: () => [],
      set: (patch: Record<string, unknown>) => {
        Object.assign(store, patch);
        return { ...store };
      },
    },
    health: { report: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

describe('mobile-relay deploy bundle', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mica-relay-panel-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes every deploy file where setup.mjs expects it', () => {
    const script = materializeBundle(dir);
    expect(existsSync(script)).toBe(true);
    // setup.mjs 用相对自己的路径找这三份，结构必须和仓库一致
    for (const relative of ['relay/relay.mjs', 'relay/nginx-site.conf', 'relay/mobile-relay.service']) {
      expect(existsSync(join(dir, 'bundle', relative))).toBe(true);
    }
    expect(readFileSync(script, 'utf8')).toContain('--ssh-port');
  });

  it('rejects hosts that are not a plain ssh target', () => {
    expect(normalizeHost('root@1.2.3.4')).toBe('root@1.2.3.4');
    expect(normalizeHost('  root@host.example  ')).toBe('root@host.example');
    expect(normalizeHost('root@1.2.3.4; rm -rf /')).toBe('');
    expect(normalizeHost('')).toBe('');
  });

  it('reports idle before anything ran', () => {
    expect(readDeployState(dir).phase).toBe('idle');
  });
});

describe('mobile-relay panel', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mica-relay-panel-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('offers the setup section with the ssh field and an apply button', () => {
    const view = buildPanelView(fakeContext(), dir);
    const section = view.sections?.find((item) => item.title === '接中转机');
    expect(section).toBeTruthy();
    expect(section?.fields?.map((field) => field.key)).toContain('sshHost');
    const apply = section?.actions?.find((action) => action.id === 'apply');
    expect(apply).toBeTruthy();
    // 没填 SSH 时不能点，免得点了个必然失败的动作
    expect(apply?.disabled).toBe(true);
  });

  it('remembers what the user typed', async () => {
    const handler = createPanelHandler(fakeContext(), dir);
    // 没有中转地址时这个动作会 reject，先把预期的失败吞掉，只验草稿落盘
    const attempt = handler.action({ action: 'test', values: { sshHost: 'root@1.2.3.4', sshPort: '2222', label: '台式机' } });
    await expect(attempt).rejects.toThrow(/中转地址/);
    expect(readDrafts(dir)).toMatchObject({ sshHost: 'root@1.2.3.4', sshPort: '2222', label: '台式机' });
  });

  it('shows the phone link once there is a relay and a token', () => {
    const view = buildPanelView(
      fakeContext({ relayUrl: 'https://mica.example.com', token: '0123456789abcdef' }),
      dir
    );
    const row = view.sections?.[0]?.rows?.find((item) => item.label === '手机链接');
    expect(row?.value).toBe('https://mica.example.com/?t=0123456789abcdef');
  });

  // 没登记过的短口令在中转机上一律 401：那种链接打不开，不该出现在面板里
  it('hides the phone link for a token that was never registered', () => {
    const view = buildPanelView(fakeContext({ relayUrl: 'https://mica.example.com', token: 'dd' }), dir);
    const row = view.sections?.[0]?.rows?.find((item) => item.label === '手机链接');
    expect(row).toBeUndefined();
  });

  it('turns a save action into an error instead of a silent no-op', async () => {
    const handler = createPanelHandler(fakeContext(), dir);
    // 没有中转地址时「测试连接」应当明确报错，而不是什么都不发生
    await expect(handler.action({ action: 'test', values: {} })).rejects.toThrow(/中转地址/);
  });

  it('offers a register button that needs only the relay address', () => {
    const empty = buildPanelView(fakeContext(), dir);
    const section = empty.sections?.find((item) => item.title === '注册这台机器');
    expect(section).toBeTruthy();
    const button = section?.actions?.find((item) => item.id === 'register');
    expect(button?.disabled).toBe(true);
    expect(section?.fields?.map((field) => field.key)).toEqual(['relayUrl', 'enrollKey']);

    const withAddress = buildPanelView(fakeContext({ relayUrl: 'https://mica.example.com' }), dir);
    const ready = withAddress.sections
      ?.find((item) => item.title === '注册这台机器')
      ?.actions?.find((item) => item.id === 'register');
    expect(ready?.disabled).toBe(false);
    expect(ready?.label).toBe('注册这台机器');
  });

  it('asks for an address instead of a token when registering', async () => {
    const handler = createPanelHandler(fakeContext(), dir);
    await expect(handler.action({ action: 'register', values: {} })).rejects.toThrow(/中转地址/);
  });

  it('writes the typed values into the panel draft file', () => {
    writeFileSync(join(dir, 'panel.json'), JSON.stringify({ sshHost: 'root@10.0.0.1', sshPort: '' }), 'utf8');
    expect(readDrafts(dir)).toEqual({
      sshHost: 'root@10.0.0.1',
      sshPort: '22',
      label: '',
      renderer: '',
      relayUrl: '',
      enrollKey: '',
    });
  });
});
