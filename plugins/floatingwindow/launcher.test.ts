import { describe, expect, it } from 'vitest';
import createLauncher, { MAX_RECENT_SITES } from './launcher.js';
import { MAX_URL_LENGTH, normalizeAddress, persistableAddress } from './address.js';

function context(conflicts = 0) {
  let value: any = { other: 'keep' };
  let version = 0;
  return {
    readData: async () => ({ value: structuredClone(value), version }),
    writeData: async (next: any, options: any) => {
      if (conflicts-- > 0) { value.concurrent = 'preserved'; version++; return { ok: false, conflict: true }; }
      if (options.expectedVersion !== version) return { ok: false, conflict: true };
      value = structuredClone(next); version++;
      return { ok: true, version };
    },
  };
}

describe('floating window address handling', () => {
  it('accepts domains, ports and explicit HTTP(S), but not other schemes or credentials', () => {
    expect(normalizeAddress(' example.com ')).toBe('https://example.com/');
    expect(normalizeAddress('localhost:3000/path')).toBe('https://localhost:3000/path');
    expect(normalizeAddress('http://example.com/a')).toBe('http://example.com/a');
    for (const value of ['javascript:alert(1)', 'file:///tmp/a', 'https://user:pass@example.com/', 'https://a.test/ space', 'x'.repeat(MAX_URL_LENGTH + 1)]) {
      expect(() => normalizeAddress(value)).toThrow();
    }
  });
  it('only persists origin-only addresses because path and parameters can contain secrets', () => {
    expect(persistableAddress('https://example.com/')).toBe('https://example.com/');
    for (const value of ['https://example.com/path', 'https://example.com/?token=abc', 'https://example.com/#secret'])
      expect(persistableAddress(value)).toBe('https://example.com/');
    expect(persistableAddress('https://a:b@example.com/')).toBeNull();
  });
});

describe('floating window storage', () => {
  it('retries CAS, preserves concurrent data, and loads recent addresses', async () => {
    const ctx = context(2);
    const launcher = createLauncher(ctx);
    expect(await launcher.request('remember', { url: 'example.com' })).toEqual({ ok: true, saved: true, urls: ['https://example.com/'] });
    expect((await ctx.readData()).value).toEqual({ other: 'keep', concurrent: 'preserved', recentUrls: ['https://example.com/'] });
    expect(await launcher.request('recent')).toEqual({ urls: ['https://example.com/'] });
  });
  it('remembers the origin without persisting sensitive paths', async () => {
    const ctx = context();
    const launcher = createLauncher(ctx);
    await launcher.request('remember', { url: 'https://example.com/' });
    expect(await launcher.request('remember', { url: 'https://example.com/private-secret?token=x#secret' })).toEqual({ ok: true, saved: true, urls: ['https://example.com/'] });
    expect((await ctx.readData()).value.recentUrls).toEqual(['https://example.com/']);
    expect(await launcher.request('recent')).toEqual({ urls: ['https://example.com/'] });
  });
  it('reports persistent conflicts and rejects requests after dispose', async () => {
    const launcher = createLauncher(context(20));
    await expect(launcher.request('remember', { url: 'https://example.com/' })).rejects.toThrow('请重试');
    launcher.dispose();
    await expect(launcher.request('recent')).rejects.toThrow('已停用');
  });
  it('surfaces storage failures instead of claiming the URL was saved', async () => {
    const ctx = context();
    ctx.writeData = async () => ({ ok: false, error: '磁盘不可写' } as any);
    const launcher = createLauncher(ctx);
    await expect(launcher.request('remember', { url: 'https://example.com/' })).rejects.toThrow('磁盘不可写');
  });
  it('serializes concurrent writes in request order', async () => {
    const launcher = createLauncher(context());
    await Promise.all([
      launcher.request('remember', { url: 'https://a.example/' }),
      launcher.request('remember', { url: 'https://b.example/' }),
    ]);
    expect(await launcher.request('recent')).toEqual({ urls: ['https://b.example/', 'https://a.example/'] });
  });
  it('merges a concurrently added site after a CAS conflict', async () => {
    const ctx = context();
    const write = ctx.writeData;
    let first = true;
    ctx.writeData = async (next, options) => {
      if (first) {
        first = false;
        await write({ other: 'keep', recentUrls: ['https://concurrent.example/'] }, { expectedVersion: 0 });
        return { ok: false, conflict: true } as any;
      }
      return write(next, options);
    };
    const launcher = createLauncher(ctx);
    await launcher.request('remember', { url: 'https://new.example/secret' });
    expect(await launcher.request('recent')).toEqual({ urls: ['https://new.example/', 'https://concurrent.example/'] });
    expect((await ctx.readData()).value.other).toBe('keep');
  });
  it('deduplicates by origin, moves revisited sites to the front, and caps history', async () => {
    const ctx = context();
    const launcher = createLauncher(ctx);
    for (let i = 0; i < MAX_RECENT_SITES + 3; i++) await launcher.request('remember', { url: `https://site${i}.example/path?secret=x` });
    await launcher.request('remember', { url: 'https://site5.example/another' });
    const { urls = [] } = await launcher.request('recent');
    expect(urls).toHaveLength(MAX_RECENT_SITES);
    expect(urls[0]).toBe('https://site5.example/');
    expect(urls.filter((url: string) => url === 'https://site5.example/')).toHaveLength(1);
    expect(urls).not.toContain('https://site0.example/');
    expect((await ctx.readData()).value.other).toBe('keep');
  });
  it('ignores invalid addresses without destroying saved history', async () => {
    const ctx = context();
    const launcher = createLauncher(ctx);
    await launcher.request('remember', { url: 'https://safe.example/path' });
    const before = await ctx.readData();
    expect(await launcher.request('remember', { url: 'javascript:alert(1)' })).toEqual({ ok: true, saved: false });
    expect(await ctx.readData()).toEqual(before);
  });
  it('filters malformed persisted entries and never exposes paths on read', async () => {
    const ctx = context();
    await ctx.writeData({ recentUrls: ['https://a.example/private?token=x', 'https://a.example/', 'javascript:bad', null, 'http://b.example/#secret'] }, { expectedVersion: 0 });
    expect(await createLauncher(ctx).request('recent')).toEqual({ urls: ['https://a.example/', 'http://b.example/'] });
  });
});
