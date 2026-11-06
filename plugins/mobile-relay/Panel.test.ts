import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext, PluginPanelActionResult } from '@packages/mica-plugin/index.js';
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
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens the latest actual request log without replacing connection drafts', async () => {
    vi.stubEnv('MICA_LOG_DIR', dir);
    writeFileSync(join(dir, 'relay-requests-20261105-2.jsonl'), '{}\n');
    const latest = join(dir, 'relay-requests-20261105-10.jsonl');
    writeFileSync(latest, '{}\n');
    writeFileSync(join(dir, 'plugin-mobile-relay-20261106.jsonl'), '{}\n');
    writeFileSync(join(dir, 'panel.json'), JSON.stringify({ relayUrl: 'https://draft.example' }));
    const result = await createPanelHandler(fakeContext(), dir).action({ action: 'request-logs' });
    expect(result).toEqual({ openPath: { path: latest } });
    expect(readDrafts(dir).relayUrl).toBe('https://draft.example');
  });

  it('opens the log directory before the first request rather than inventing a file', async () => {
    vi.stubEnv('MICA_LOG_DIR', dir);
    expect(await createPanelHandler(fakeContext(), dir).action({ action: 'request-logs' })).toEqual({
      openPath: { path: dir },
    });
  });

  it('offers the first-deploy section with the ssh field and an apply button', () => {
    const view = buildPanelView(fakeContext(), dir);
    const section = view.sections?.find((item) => item.title === '首次部署');
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
    const attempt = handler.action({
      action: 'test',
      values: { sshHost: 'root@1.2.3.4', sshPort: '2222', label: '台式机' },
    });
    await expect(attempt).rejects.toThrow(/中转地址/);
    expect(readDrafts(dir)).toMatchObject({ sshHost: 'root@1.2.3.4', sshPort: '2222', label: '台式机' });
  });

  it('shows the phone link once there is a relay and a token', () => {
    const view = buildPanelView(fakeContext({ relayUrl: 'https://mica.example.com', token: '0123456789abcdef' }), dir);
    const row = view.sections?.[0]?.rows?.find((item) => item.label === '手机链接');
    expect(row?.value).toBe('https://mica.example.com/?t=0123456789abcdef');
  });

  // 没登记过的短口令在中转机上一律 401：那种链接打不开，不该出现在面板里
  it('hides the phone link for a token that was never registered', () => {
    const view = buildPanelView(fakeContext({ relayUrl: 'https://mica.example.com', token: 'dd' }), dir);
    const row = view.sections?.[0]?.rows?.find((item) => item.label === '手机链接');
    expect(row).toBeUndefined();
  });

  /*
   * 入口动作（清单 desktop.panel.open）：点「手机访问」只要一个二维码。
   * 它不能走 saveDrafts——页面没有表单可提交，落一次空草稿会把用户填了一半的中转地址
   * 与 SSH 清空。
   */
  it('answers the entry action with a QR code and leaves the draft alone', async () => {
    writeFileSync(
      join(dir, 'panel.json'),
      JSON.stringify({ sshHost: 'root@1.2.3.4', relayUrl: 'https://draft.example' }),
      'utf8',
    );
    const handler = createPanelHandler(
      fakeContext({ relayUrl: 'https://mica.example.com', token: '0123456789abcdef' }),
      dir,
    );
    const outcome = (await handler.action({ action: 'show', values: {} })) as PluginPanelActionResult;
    expect(outcome.dialog?.qr?.value).toBe('https://mica.example.com/?t=0123456789abcdef');
    expect(outcome.dialog?.title).toBe('手机访问');
    expect(readDrafts(dir)).toMatchObject({
      sshHost: 'root@1.2.3.4',
      relayUrl: 'https://draft.example',
    });
  });

  it('points at the plugin page instead of drawing a QR code when nothing is set up', async () => {
    const handler = createPanelHandler(fakeContext(), dir);
    const outcome = (await handler.action({ action: 'show', values: {} })) as PluginPanelActionResult;
    expect(outcome.dialog?.configure?.label).toBe('去插件页面配置');
    expect(outcome.dialog?.panel?.label).toBe('首次部署');
    expect(outcome.dialog?.qr).toBeUndefined();
    expect(outcome.dialog?.text).toContain('还没接入');
  });

  it('turns a save action into an error instead of a silent no-op', async () => {
    const handler = createPanelHandler(fakeContext(), dir);
    // 没有中转地址时「测试连接」应当明确报错，而不是什么都不发生
    await expect(handler.action({ action: 'test', values: {} })).rejects.toThrow(/中转地址/);
  });

  it('offers a register button that needs only the relay address', () => {
    const empty = buildPanelView(fakeContext(), dir);
    const section = empty.sections?.find((item) => item.title === '接入');
    expect(section).toBeTruthy();
    const button = section?.actions?.find((item) => item.id === 'register');
    expect(button?.disabled).toBe(true);
    expect(section?.fields?.map((field) => field.key)).toEqual(['relayUrl', 'enrollKey']);

    const withAddress = buildPanelView(fakeContext({ relayUrl: 'https://mica.example.com' }), dir);
    const ready = withAddress.sections
      ?.find((item) => item.title === '接入')
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

  /*
   * 手机打开的那份页面正是中转机上托管的那份，所以「页面落后」在手机上最该被看见：
   * 用户面对的就是旧界面，却没有别的入口能把它换掉。概览因此把监管写下的页面版本
   * 原样透出来，并在同一块里把「更新」按钮升成主按钮。
   */
  it('shows the page version and an update button when the relay page is behind', () => {
    writeFileSync(
      join(dir, 'data.json'),
      JSON.stringify({
        page: { text: '落后（中转机 4d32，本机 bcc7）', tone: 'warn' },
        pageKey: 'bcc7->4d32',
      }),
      'utf8',
    );
    const section = buildPanelView(fakeContext({ relayUrl: 'https://mica.example.com' }), dir).sections?.find(
      (item) => item.title === '概览',
    );
    expect(section?.rows?.find((item) => item.label === '页面版本')).toEqual({
      label: '页面版本',
      value: '落后（中转机 4d32，本机 bcc7）',
      tone: 'warn',
    });
    expect(section?.actions?.find((item) => item.id === 'sync-page')?.tone).toBe('primary');
  });

  it('keeps the update button quiet once the two sides match', () => {
    writeFileSync(join(dir, 'data.json'), JSON.stringify({ page: { text: '已同步 bcc7', tone: 'ok' } }), 'utf8');
    const section = buildPanelView(fakeContext(), dir).sections?.find((item) => item.title === '概览');
    const button = section?.actions?.find((item) => item.id === 'sync-page');
    expect(button?.tone).toBe('ghost');
    // 没配中转机时点它只会得到一句「还没连接中转机」
    expect(button?.disabled).toBe(true);
  });

  // 提示点只亮一次（`page-notice.json`），落后本身不会因此消失：概览里仍要有
  // 「页面版本 · 落后」与主按钮，否则用户想手动再传一次时找不到入口。
  it('keeps the stale row and the primary button after the notice was dismissed', () => {
    writeFileSync(
      join(dir, 'data.json'),
      JSON.stringify({
        page: { text: '落后 · 手机端 4d32，本机 bcc7', tone: 'warn' },
        pageKey: 'bcc7->4d32',
        attention: null,
      }),
      'utf8',
    );
    const section = buildPanelView(fakeContext({ relayUrl: 'https://mica.example.com' }), dir).sections?.find(
      (item) => item.title === '概览',
    );
    expect(section?.rows?.find((item) => item.label === '页面版本')?.tone).toBe('warn');
    expect(section?.actions?.find((item) => item.id === 'sync-page')?.tone).toBe('primary');
  });

  it('hands the page update to a new session instead of uploading from the panel', async () => {
    const handler = createPanelHandler(fakeContext(), dir);
    const result = await handler.action({ action: 'sync-page', values: {} });
    // 面板只准备提示词：真正上传由会话里的 agent 调 mobile_relay 工具完成。
    const staged = result && 'newSession' in result ? result.newSession : undefined;
    expect(staged?.send).toBe(false);
    expect(staged?.prompt).toContain('sync_page');
  });
});
