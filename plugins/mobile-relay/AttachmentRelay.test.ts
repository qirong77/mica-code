import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./relay/relay.mjs', import.meta.url), 'utf8');
const MAX_BYTES = 24 * 1024 * 1024;
const TOKEN = 'attachment-test-token';

function section(start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing relay section: ${start}`);
  return source.slice(from, to);
}

function harness(
  result: unknown = { ok: true, result: { path: '/local/attachments/report.pdf', name: 'report.pdf' } },
) {
  const state = { token: TOKEN };
  const invoke = vi.fn(async () => result);
  const functions = runInNewContext(
    [
      section('function sendJson(', 'function escapeHtml('),
      section('async function handleAttachment(', 'function handleEnv('),
      section('function tokenFrom(', 'function rememberTokens('),
      section('function currentState(', 'const MIME ='),
      section('async function route(', 'function buildServer('),
      '; ({ handleAttachment, route })',
    ].join('\n'),
    {
      Buffer,
      URL,
      MAX_PASTE_IMAGE_BYTES: MAX_BYTES,
      MAX_REMEMBERED: 8,
      agents: new Map([[TOKEN, state]]),
      invokeForResponse: invoke,
    },
  ) as {
    handleAttachment(req: unknown, res: unknown, state: unknown): Promise<void>;
    route(req: unknown, res: unknown): Promise<void>;
  };
  return { ...functions, invoke, state };
}

function response() {
  let status = 0;
  let body: unknown;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writeHead: vi.fn((value: number) => {
      status = value;
    }),
    end: vi.fn((payload: Buffer) => {
      body = JSON.parse(payload.toString('utf8'));
    }),
  });
  return { res, status: () => status, body: () => body };
}

function request(body: unknown, headers: Record<string, string> = {}, method = 'POST') {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    url: '/api/attachment',
    method,
    headers,
  });
}

describe('relay attachment upload', () => {
  it('forwards non-image data and the unmodified filename, then returns the local path and name', async () => {
    const { handleAttachment, invoke, state } = harness();
    const output = response();
    const body = { dataUrl: 'data:application/pdf;base64,JVBERg==', name: '../report: draft.pdf' };
    await handleAttachment(request(body), output.res, state);
    expect(invoke).toHaveBeenCalledWith(state, '__attachment', body, output.res);
    expect(output.status()).toBe(200);
    expect(output.body()).toEqual({ ok: true, path: '/local/attachments/report.pdf', name: 'report.pdf' });
  });

  it.each([
    {},
    { dataUrl: 123 },
    { dataUrl: 'not a data URL' },
    { dataUrl: 'data:text/plain,hello' },
    { dataUrl: 'data:application/octet-stream;base64,' },
    { dataUrl: 'data:text/plain;base64,!!!' },
  ])('rejects invalid attachment data: %j', async (body) => {
    const { handleAttachment, invoke, state } = harness();
    const output = response();
    await handleAttachment(request(body), output.res, state);
    expect(output.status()).toBe(400);
    expect(output.body()).toMatchObject({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON without invoking the local machine', async () => {
    const { handleAttachment, invoke, state } = harness();
    const output = response();
    await handleAttachment(Readable.from([Buffer.from('{')]), output.res, state);
    expect(output.status()).toBe(400);
    expect(output.body()).toEqual({ ok: false, error: 'bad json' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('applies the 24MB budget to the full JSON request and returns 413', async () => {
    const { handleAttachment, invoke, state } = harness();
    const output = response();
    const req = Readable.from([Buffer.alloc(MAX_BYTES), Buffer.from('x')]);
    await handleAttachment(req, output.res, state);
    expect(output.status()).toBe(413);
    expect(output.body()).toMatchObject({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([undefined, 403, 503])('preserves local failures and their HTTP status: %s', async (status) => {
    const { handleAttachment, state } = harness({ ok: false, error: 'local write denied', status });
    const output = response();
    await handleAttachment(request({ dataUrl: 'data:text/plain;base64,aGk=' }), output.res, state);
    expect(output.status()).toBe(status || 200);
    expect(output.body()).toEqual({ ok: false, error: 'local write denied' });
  });

  it('preserves a failure returned inside the local attachment response', async () => {
    const { handleAttachment, state } = harness({ ok: true, result: { ok: false, error: 'disk full' } });
    const output = response();
    await handleAttachment(request({ dataUrl: 'data:text/plain;base64,aGk=' }), output.res, state);
    expect(output.status()).toBe(200);
    expect(output.body()).toEqual({ ok: false, error: 'disk full' });
  });

  it('does not write a response after the client disconnects', async () => {
    const { handleAttachment, state } = harness();
    const output = response();
    output.res.destroyed = true;
    await handleAttachment(request({ dataUrl: 'data:;base64,aGk=' }), output.res, state);
    expect(output.res.end).not.toHaveBeenCalled();
  });
});

describe('relay attachment route authentication', () => {
  const unauthenticated: Record<string, string>[] = [{}, { 'x-relay-token': 'wrong-token' }];
  const authenticated: Record<string, string>[] = [{ 'x-relay-token': TOKEN }, { cookie: `mica_relay=${TOKEN}` }];

  it.each(unauthenticated)('rejects unauthenticated requests before forwarding: %j', async (headers) => {
    const { route, invoke } = harness();
    const output = response();
    await route(request({ dataUrl: 'data:text/plain;base64,aGk=' }, headers), output.res);
    expect(output.status()).toBe(401);
    expect(output.body()).toEqual({ ok: false, error: 'bad token' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(authenticated)('dispatches authenticated POST requests: %j', async (headers) => {
    const { route, invoke, state } = harness();
    const output = response();
    const body = { dataUrl: 'data:text/plain;base64,aGk=', name: 'notes.txt' };
    await route(request(body, headers), output.res);
    expect(invoke).toHaveBeenCalledWith(state, '__attachment', body, output.res);
    expect(output.status()).toBe(200);
  });

  it('does not dispatch an authenticated GET to the upload handler', async () => {
    const { route, invoke } = harness();
    const output = response();
    await route(request({}, { 'x-relay-token': TOKEN }, 'GET'), output.res);
    expect(output.status()).toBe(404);
    expect(invoke).not.toHaveBeenCalled();
  });
});

it('keeps the nginx upload budget aligned with the attachment JSON limit', () => {
  const config = readFileSync(new URL('./relay/nginx-site.conf', import.meta.url), 'utf8');
  expect(config).toMatch(/client_max_body_size\s+24m;/);
});
