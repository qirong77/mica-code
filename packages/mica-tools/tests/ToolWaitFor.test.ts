import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolWaitFor } from '../ToolWaitFor.js';
import { clearWaitRecords, listActiveWaits, listWaitRecords, pruneWaitRecords } from '../waitFor/registry.js';

const tool = new ToolWaitFor();
const FAST = { poll_interval_ms: 50 };

let dir: string;
const servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mica-wait-for-'));
  clearWaitRecords();
});

afterEach(async () => {
  clearWaitRecords();
  rmSync(dir, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function parseField(result: string, field: string): string | undefined {
  const match = result.match(new RegExp(`^${field}: (.*)$`, 'm'));
  return match?.[1]?.trim();
}

function parseWaitId(result: string): string {
  const id = parseField(result, 'wait_id');
  expect(id).toBeTruthy();
  return id!;
}

async function listen(handler: (url: string) => Response | Promise<Response>): Promise<string> {
  const server = createServer(async (req, res) => {
    const response = await handler(`http://127.0.0.1:${(server.address() as { port: number }).port}${req.url ?? '/'}`);
    const body = await response.text();
    res.writeHead(response.status, { 'content-type': 'text/plain' });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

describe('wait_for input validation', () => {
  it('rejects unknown kinds and missing per-kind fields', async () => {
    await expect(tool.execute({ kind: 'nope' })).resolves.toContain('未知的 kind');
    await expect(tool.execute({})).resolves.toContain('需要提供 kind');
    await expect(tool.execute({ kind: 'file' })).resolves.toContain('需要提供 file_path');
    await expect(tool.execute({ kind: 'file', file_path: 'a', until: 'matches' })).resolves.toContain(
      '需要提供 pattern',
    );
    await expect(tool.execute({ kind: 'command' })).resolves.toContain('需要提供 command');
    await expect(tool.execute({ kind: 'command', command: 'x', until: 'expected_exit_code' })).resolves.toContain(
      'expected_exit_code',
    );
    await expect(tool.execute({ kind: 'http' })).resolves.toContain('需要提供 url');
    await expect(tool.execute({ kind: 'port' })).resolves.toContain('port');
    await expect(tool.execute({ kind: 'process', pid: -1 })).resolves.toContain('pid');
    await expect(tool.execute({ kind: 'file', file_path: 'a', until: 'whenever' })).resolves.toContain(
      'kind=file 的 until',
    );
    await expect(tool.execute({ kind: 'http', url: 'http://x', headers: 'nope' })).resolves.toContain(
      'headers 应为 object',
    );
  });

  it('reports unknown wait_id instead of silently waiting', async () => {
    await expect(tool.execute({ wait_id: 'deadbeef' })).resolves.toContain('未知或已过期的 wait_id');
  });
});

describe('wait_for file conditions', () => {
  it('returns immediately when the file already exists', async () => {
    const target = path.join(dir, 'ready.txt');
    writeFileSync(target, 'ok');
    const result = await tool.execute({ kind: 'file', file_path: target, ...FAST }, undefined);
    expect(parseField(result, 'status')).toBe('satisfied');
    expect(result).toContain('已存在');
  });

  it('waits until the file appears, then reports satisfied', async () => {
    const target = path.join(dir, 'later.txt');
    setTimeout(() => writeFileSync(target, 'ok'), 120);
    const result = await tool.execute({ kind: 'file', file_path: target, timeout_ms: 5_000, ...FAST });
    expect(parseField(result, 'status')).toBe('satisfied');
  });

  it('times out with a resumable wait_id and keeps the baseline on resume', async () => {
    const target = path.join(dir, 'never.txt');
    const timedOut = await tool.execute({ kind: 'file', file_path: target, timeout_ms: 120, ...FAST });
    expect(parseField(timedOut, 'status')).toBe('timeout');
    expect(timedOut).toContain('继续等待');
    const waitId = parseWaitId(timedOut);

    writeFileSync(target, 'ok');
    const resumed = await tool.execute({ wait_id: waitId, timeout_ms: 2_000, ...FAST });
    expect(parseField(resumed, 'status')).toBe('satisfied');
    expect(parseWaitId(resumed)).toBe(waitId);

    const again = await tool.execute({ wait_id: waitId });
    expect(parseField(again, 'status')).toBe('satisfied');
    expect(again).toContain('已经结束');
  });

  it('detects content change against the baseline captured on the first poll', async () => {
    const target = path.join(dir, 'changing.txt');
    writeFileSync(target, 'v1');
    setTimeout(() => writeFileSync(target, 'v2'), 150);
    const result = await tool.execute({
      kind: 'file',
      file_path: target,
      until: 'changed',
      timeout_ms: 5_000,
      ...FAST,
    });
    expect(parseField(result, 'status')).toBe('satisfied');
    expect(result).toContain('changing.txt');
    expect(result).toContain('->');
  });

  it('matches file content with a regex', async () => {
    const target = path.join(dir, 'log.txt');
    writeFileSync(target, 'building...\ndone in 12s\n');
    const hit = await tool.execute({
      kind: 'file',
      file_path: target,
      until: 'matches',
      pattern: 'done in \\d+s',
      timeout_ms: 1_000,
      ...FAST,
    });
    expect(parseField(hit, 'status')).toBe('satisfied');
    const miss = await tool.execute({
      kind: 'file',
      file_path: target,
      until: 'matches',
      pattern: 'never appears',
      timeout_ms: 100,
      ...FAST,
    });
    expect(parseField(miss, 'status')).toBe('timeout');
  });

  it('waits for a file to disappear', async () => {
    const target = path.join(dir, 'lock');
    writeFileSync(target, '');
    setTimeout(() => rmSync(target, { force: true }), 120);
    const result = await tool.execute({
      kind: 'file',
      file_path: target,
      until: 'missing',
      timeout_ms: 5_000,
      ...FAST,
    });
    expect(parseField(result, 'status')).toBe('satisfied');
  });
});

describe('wait_for process conditions', () => {
  it('waits for a pid to exit', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' });
    const result = await tool.execute({ kind: 'process', pid: child.pid!, timeout_ms: 5_000, ...FAST });
    expect(parseField(result, 'status')).toBe('satisfied');
    expect(result).toContain('已退出');
    child.kill('SIGKILL');
  });

  it('reports timeout while the process is still alive', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
    const result = await tool.execute({ kind: 'process', pid: child.pid!, timeout_ms: 100, ...FAST });
    expect(parseField(result, 'status')).toBe('timeout');
    child.kill('SIGKILL');
  });
});

describe('wait_for command conditions', () => {
  it('polls a command until its exit code matches', async () => {
    const flag = path.join(dir, 'flag');
    setTimeout(() => writeFileSync(flag, ''), 200);
    const result = await tool.execute({
      kind: 'command',
      command: `test -f ${JSON.stringify(flag)}`,
      until: 'exit_zero',
      timeout_ms: 5_000,
      ...FAST,
    });
    expect(parseField(result, 'status')).toBe('satisfied');
    expect(result).toContain('exit_code=0');
  });

  it('supports stdout_matches and keeps polling errors out of the verdict', async () => {
    const result = await tool.execute({
      kind: 'command',
      command: 'echo service-ready',
      until: 'stdout_matches',
      pattern: 'service-ready',
      timeout_ms: 1_000,
      ...FAST,
    });
    expect(parseField(result, 'status')).toBe('satisfied');

    const missing = await tool.execute({
      kind: 'command',
      command: 'echo nope',
      until: 'stdout_matches',
      pattern: 'ready',
      timeout_ms: 100,
      ...FAST,
    });
    expect(parseField(missing, 'status')).toBe('timeout');
  });

  it('surfaces a bad cwd as a poll error instead of satisfying the condition', async () => {
    const result = await tool.execute({
      kind: 'command',
      command: 'echo hi',
      cwd: path.join(dir, 'does-not-exist'),
      timeout_ms: 100,
      ...FAST,
    });
    expect(parseField(result, 'status')).toBe('timeout');
    expect(result).toContain('cwd is not accessible');
  });
});

describe('wait_for http and port conditions', () => {
  it('waits until a URL is reachable', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 200);
    const base = await listen(() => (ready ? new Response('up') : new Response('down')));
    const result = await tool.execute({ kind: 'http', url: base, until: 'reachable', timeout_ms: 5_000, ...FAST });
    expect(parseField(result, 'status')).toBe('satisfied');
  });

  it('treats connection failures as poll errors, not as satisfied', async () => {
    const result = await tool.execute({ kind: 'http', url: 'http://127.0.0.1:1/', timeout_ms: 150, ...FAST });
    expect(parseField(result, 'status')).toBe('timeout');
    expect(result).toContain('last error:');
  });

  it('waits for a status code and a body pattern', async () => {
    const base = await listen(() => new Response('{"status":"healthy"}\n', { status: 200 }));
    const status = await tool.execute({
      kind: 'http',
      url: base,
      until: 'status',
      expect_status: 200,
      timeout_ms: 1_000,
      ...FAST,
    });
    expect(parseField(status, 'status')).toBe('satisfied');

    const body = await tool.execute({
      kind: 'http',
      url: base,
      until: 'body_matches',
      pattern: '"healthy"',
      timeout_ms: 1_000,
      ...FAST,
    });
    expect(parseField(body, 'status')).toBe('satisfied');
  });

  it('waits for a TCP port to accept connections', async () => {
    const base = await listen(() => new Response('ok'));
    const port = Number(new URL(base).port);
    const result = await tool.execute({ kind: 'port', host: '127.0.0.1', port, timeout_ms: 2_000, ...FAST });
    expect(parseField(result, 'status')).toBe('satisfied');
    expect(result).toContain('可连接');
  });

  it('can send a method, headers and body', async () => {
    const base = await listen(() => new Response('warmed'));
    const result = await tool.execute({
      kind: 'http',
      url: `${base}/warm`,
      method: 'POST',
      headers: { 'x-mica': '1' },
      body: 'ping',
      until: 'body_matches',
      pattern: 'warmed',
      timeout_ms: 1_000,
      ...FAST,
    });
    expect(parseField(result, 'status')).toBe('satisfied');
  });
});

describe('wait_for duration, background and abort', () => {
  it('honours a duration wait', async () => {
    const started = Date.now();
    const result = await tool.execute({ kind: 'duration', seconds: 0.2, timeout_ms: 2_000, ...FAST });
    expect(parseField(result, 'status')).toBe('satisfied');
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it('registers background waits without blocking', async () => {
    const result = await tool.execute({ kind: 'duration', seconds: 5, background: true });
    expect(parseField(result, 'status')).toBe('parked');
    const waitId = parseWaitId(result);
    expect(listActiveWaits().map((record) => record.id)).toContain(waitId);
    const status = await tool.execute({ wait_id: waitId, timeout_ms: 0, ...FAST });
    expect(['timeout', 'parked', 'waiting']).toContain(parseField(status, 'status'));
  });

  it('settles as aborted when the turn is interrupted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await tool.execute(
      { kind: 'duration', seconds: 30, timeout_ms: 30_000, ...FAST },
      { signal: controller.signal },
    );
    expect(parseField(result, 'status')).toBe('aborted');
    expect(listWaitRecords().every((record) => record.status !== 'waiting')).toBe(true);
  });

  it('unregisters nothing until pruned, and exposes an active-wait snapshot', async () => {
    const started = tool.execute({ kind: 'duration', seconds: 30, background: true });
    const result = await started;
    const active = listActiveWaits();
    expect(active).toHaveLength(1);
    expect(active[0]!.label).toContain('等待 30s');
    expect(parseWaitId(result)).toBe(active[0]!.id);
  });

  it('keeps a timed-out wait resumable until the terminal TTL prunes it', async () => {
    const result = await tool.execute({
      kind: 'file',
      file_path: path.join(dir, 'never'),
      timeout_ms: 0,
      ...FAST,
    });
    expect(parseField(result, 'status')).toBe('timeout');
    const waitId = parseWaitId(result);

    // 终态记录的回收窗口是 TERMINAL_TTL_MS（5 分钟）。
    pruneWaitRecords(Date.now() + 60_000);
    expect(listWaitRecords().map((record) => record.id)).toContain(waitId);

    pruneWaitRecords(Date.now() + 31 * 60_000);
    expect(listWaitRecords().map((record) => record.id)).not.toContain(waitId);
    const resumed = await tool.execute({ wait_id: waitId, timeout_ms: 0, ...FAST });
    expect(resumed).toContain('输入校验失败');
  });

  it('holds a parked background wait long past the terminal TTL before dropping it', async () => {
    const result = await tool.execute({ kind: 'duration', seconds: 5, background: true });
    expect(parseField(result, 'status')).toBe('parked');
    const waitId = parseWaitId(result);

    // PARKED_TTL_MS 是 2 小时：挂满预算的 background 等待必须熬过默认超时预算，
    // 否则它会在还能被 wait_id 续等的窗口里被回收。
    pruneWaitRecords(Date.now() + 60 * 60_000);
    expect(listWaitRecords().map((record) => record.id)).toContain(waitId);
    expect(listActiveWaits().map((record) => record.id)).toContain(waitId);

    pruneWaitRecords(Date.now() + 3 * 60 * 60_000);
    expect(listWaitRecords().map((record) => record.id)).not.toContain(waitId);
  });
});

describe('wait_for display text', () => {
  it('describes the condition for the turn log', () => {
    expect(tool.onToolUseDisplayText({ kind: 'file', file_path: '/tmp/a.txt' })).toContain('/tmp/a.txt');
    expect(tool.onToolUseDisplayText({ wait_id: 'abcdef123456' })).toContain('续等');
  });
});
