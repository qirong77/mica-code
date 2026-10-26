import { describe, expect, it } from 'vitest';
import {
  TERMINAL_CONTROL_DISABLED_STEPS,
  sessionStatusLabel,
  sessionTitle,
  sessionWindowLabel,
  terminalCurlExample,
  terminalEnvHint,
  unavailableTerminalControlDetails,
} from './terminalControl.js';
import { readTerminalControlDetails, setConfigWebClient, supportsTerminalControl } from './api.js';
import type { ConfigWebBrowserControlEndpoint, ConfigWebTerminalControlSession } from '../src/shared/types.js';

function endpoint(overrides: Partial<ConfigWebBrowserControlEndpoint> = {}): ConfigWebBrowserControlEndpoint {
  return { id: 'e1', method: 'GET', path: '/sessions', summary: '', params: [], ...overrides };
}

function session(overrides: Partial<ConfigWebTerminalControlSession> = {}): ConfigWebTerminalControlSession {
  return {
    id: 'term-1',
    owner: null,
    label: '',
    cwd: '',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    createdAt: null,
    updatedAt: null,
    running: true,
    exitCode: null,
    signal: null,
    windowVisible: false,
    outputSeq: 0,
    truncated: false,
    ...overrides,
  };
}

describe('terminal control details', () => {
  // 浏览器宿主没有这个能力：侧栏条目照样在，页面必须拿到一份可渲染的「未开启」详情。
  it('falls back to the unavailable details when the host cannot read them', async () => {
    setConfigWebClient({} as never);
    try {
      expect(supportsTerminalControl()).toBe(false);
      const details = await readTerminalControlDetails();
      expect(details.available).toBe(false);
      expect(details.error).toContain('桌面应用');
    } finally {
      setConfigWebClient(null);
    }
  });

  // 侧栏条目各处都在，所以拿不到服务时页面必须能照常渲染并说明「未开启」。
  it('describes an unopened service instead of an empty page', () => {
    const details = unavailableTerminalControlDetails();
    expect(details.available).toBe(false);
    expect(details.serviceUrl).toBeNull();
    expect(details.mcpUrl).toBeNull();
    expect(details.toolName).toBe('control');
    expect(details.sessions).toEqual([]);
    expect(details.endpoints).toEqual([]);
    expect(details.error).toContain('桌面应用');
    expect(details.envVars).toEqual({ url: 'MICA_TERMINAL_URL', owner: 'MICA_TERMINAL_OWNER' });
  });

  it('keeps an explicit reason when the host supplies one', () => {
    expect(unavailableTerminalControlDetails('服务没起来').error).toBe('服务没起来');
    expect(unavailableTerminalControlDetails('').error).toContain('桌面应用');
  });

  it('explains how to get a working terminal', () => {
    expect(TERMINAL_CONTROL_DISABLED_STEPS.join(' ')).toContain('PTY');
    expect(TERMINAL_CONTROL_DISABLED_STEPS.join(' ')).toContain('桌面应用');
  });
});

describe('terminal control curl example', () => {
  it('uses the terminal env vars and the real service url', () => {
    expect(terminalCurlExample(endpoint({ method: 'GET', path: '/sessions' }))).toContain(
      '"$MICA_TERMINAL_URL/sessions"',
    );
    const example = terminalCurlExample(
      endpoint({ method: 'POST', path: '/sessions/:id/input' }),
      'http://127.0.0.1:8899/remote/terminal',
    );
    expect(example).toContain('curl -X POST "http://127.0.0.1:8899/remote/terminal/sessions/abc123/input"');
    expect(example).toContain('-H "x-mica-owner: $MICA_TERMINAL_OWNER"');
  });

  it('explains the environment variables', () => {
    expect(terminalEnvHint({ url: 'MICA_TERMINAL_URL', owner: 'MICA_TERMINAL_OWNER' })).toContain(
      'x-mica-owner: $MICA_TERMINAL_OWNER',
    );
    expect(terminalEnvHint(null)).toContain('$MICA_TERMINAL_URL');
  });
});

describe('terminal session labels', () => {
  it('distinguishes running from exited shells', () => {
    expect(sessionStatusLabel(session())).toBe('运行中');
    expect(sessionStatusLabel(session({ running: false, exitCode: 0 }))).toBe('已退出 · code 0');
    expect(sessionStatusLabel(session({ running: false, signal: 'SIGHUP' }))).toBe('已退出 · SIGHUP');
    expect(sessionStatusLabel(session({ running: false }))).toBe('已退出');
  });

  it('falls back to the id and appends the cwd only when it adds information', () => {
    expect(sessionTitle(session({ id: 'term-9' }))).toBe('term-9');
    expect(sessionTitle(session({ id: 'term-9', label: 'build' }))).toBe('build');
    expect(sessionTitle(session({ id: 'term-9', label: 'build', cwd: '/repo' }))).toBe('build · /repo');
    expect(sessionTitle(session({ id: 'term-9', cwd: '/repo' }))).toBe('term-9 · /repo');
  });

  it('says whether the window is on screen, hidden, or gone', () => {
    expect(sessionWindowLabel(session({ windowVisible: true }))).toBe('显示中');
    expect(sessionWindowLabel(session({ windowVisible: false }))).toBe('后台');
    expect(sessionWindowLabel(session({ running: false, windowVisible: false }))).toBe('已关闭');
  });
});
