import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function harness(wanted = true) {
  const source = readFileSync(new URL('./agent/bridge.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function channelCounts(');
  const end = source.indexOf('\nfunction deriveKey(', start);
  const record = vi.fn();
  const post = vi.fn(async () => ({ status: 200, body: Buffer.from('{"commands":[]}') }));
  const send = runInNewContext(`${source.slice(start, end)}; sendRelay`, {
    Date,
    Buffer,
    wanted,
    settings: { relayUrl: 'https://private.example/?token=never-log' },
    seal: (value: unknown) => Buffer.from(JSON.stringify(value)),
    open: (value: Buffer) => JSON.parse(value.toString()),
    postBinary: post,
    requestLog: { record },
  }) as (endpoint: string, body: unknown) => Promise<unknown>;
  return { send, record, post };
}

describe('bridge request log integration', () => {
  it('records outbound bytes and channel counts without bodies, addresses or errors', async () => {
    const { send, record } = harness();
    await send('/api/poll', {
      results: [{ channel: 'files:read', payload: { path: '/private/file' }, result: 'private contents' }],
      events: [{ channel: 'terminal:data', payload: { data: 'private input' } }],
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({
      endpoint: '/api/poll',
      status: 200,
      outcome: 'ok',
      resultCount: 1,
      eventCount: 1,
      channels: { 'files:read': 1 },
    });
    const logged = JSON.stringify(record.mock.calls);
    expect(logged).not.toMatch(/private|never-log|token|payload/);
    expect(record.mock.calls[0]![0].requestBytes).toBeGreaterThan(0);
  });

  it('does not log healthy idle polls but records the first incoming operation', async () => {
    const { send, record, post } = harness(false);
    await send('/api/poll', {});
    expect(record).not.toHaveBeenCalled();
    post.mockResolvedValueOnce({
      status: 200,
      body: Buffer.from('{"commands":[{"channel":"terminal:write","payload":{"data":"secret"}}]}'),
    });
    await send('/api/poll', {});
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ commandCount: 1, channels: { 'terminal:write': 1 } }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain('secret');
  });

  it('records HTTP and network failures once with no raw failure text', async () => {
    const { send, record, post } = harness(false);
    post.mockResolvedValueOnce({ status: 503, body: Buffer.from('private response') });
    await expect(send('/api/push', {})).rejects.toThrow('503');
    post.mockRejectedValueOnce(new Error('secret URL/token failure'));
    await expect(send('/api/poll', {})).rejects.toThrow('secret');
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[0]![0].outcome).toBe('http-error');
    expect(record.mock.calls[1]![0].outcome).toBe('network-error');
    expect(JSON.stringify(record.mock.calls)).not.toMatch(/private|secret|token/);
  });
});

describe('bridge attachment forwarding', () => {
  function attachmentHarness() {
    const source = readFileSync(new URL('./agent/bridge.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('async function saveAttachment(');
    const end = source.indexOf('async function readLocalEnv(', start);
    const fetcher = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ ok: true, path: '/local/attachments/file.pdf', name: 'file.pdf' })),
    );
    const save = runInNewContext(`${source.slice(start, end)}; saveAttachment`, {
      fetch: fetcher,
      AbortSignal,
      settings: { localUrl: 'http://127.0.0.1:8787' },
    }) as (payload: unknown) => Promise<unknown>;
    return { save, fetcher };
  }

  it('delegates bytes and the original filename to the real runtime attachment endpoint', async () => {
    const { save, fetcher } = attachmentHarness();
    const payload = { dataUrl: 'data:application/pdf;base64,cGRm', name: '../original.pdf' };
    expect(await save(payload)).toEqual({
      ok: true,
      result: { path: '/local/attachments/file.pdf', name: 'file.pdf' },
    });
    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:8787/api/attachment');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body))).toEqual(payload);
  });

  it('does not turn a runtime save failure into a successful empty reference', async () => {
    const { save, fetcher } = attachmentHarness();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'disk full' })));
    expect(await save({})).toEqual({ ok: false, error: 'disk full' });
  });
});
