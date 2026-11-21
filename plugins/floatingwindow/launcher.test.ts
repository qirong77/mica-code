import { describe, expect, it } from 'vitest';
import createLauncher, { MAX_FAVORITE_SITES, MAX_RECENT_SITES } from './launcher.js';
import { MAX_URL_LENGTH, normalizeAddress, persistableAddress, persistableOrigin } from './address.js';

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
  it('persists the whole address the user opened, and the origin for per-site data', () => {
    expect(persistableAddress('https://example.com/')).toBe('https://example.com/');
    expect(persistableAddress('example.com/deep/path?q=1#top')).toBe('https://example.com/deep/path?q=1#top');
    expect(persistableAddress('https://example.com/search?q=你好')).toBe('https://example.com/search?q=%E4%BD%A0%E5%A5%BD');
    expect(persistableAddress('https://a:b@example.com/')).toBeNull();
    expect(persistableOrigin('https://example.com/deep/path?q=1#top')).toBe('https://example.com');
    expect(persistableOrigin('javascript:alert(1)')).toBeNull();
  });
});

describe('floating window storage', () => {
  it('retries CAS, preserves concurrent data, and loads recent addresses', async () => {
    const ctx = context(2);
    const launcher = createLauncher(ctx);
    expect(await launcher.request('remember', { url: 'example.com' })).toEqual({ ok: true, saved: true, urls: ['https://example.com/'], favicons: {} });
    expect((await ctx.readData()).value).toEqual({ other: 'keep', concurrent: 'preserved', recentUrls: ['https://example.com/'], favicons: {} });
    expect(await launcher.request('recent')).toEqual({ urls: ['https://example.com/'], favorites: [], favicons: {} });
  });
  it('remembers the full address and keys the icon by site', async () => {
    const ctx = context();
    const launcher = createLauncher(ctx);
    await launcher.request('remember', { url: 'https://example.com/' });
    expect(await launcher.request('remember', { url: 'https://example.com/private-secret?token=x#secret', faviconUrl: 'https://cdn.example/assets/favicon.svg?cache=1' })).toEqual({
      ok: true,
      saved: true,
      urls: ['https://example.com/private-secret?token=x#secret', 'https://example.com/'],
      favicons: { 'https://example.com': 'https://cdn.example/assets/favicon.svg?cache=1' },
    });
    expect((await ctx.readData()).value.recentUrls).toEqual(['https://example.com/private-secret?token=x#secret', 'https://example.com/']);
    expect(await launcher.request('recent')).toEqual({
      urls: ['https://example.com/private-secret?token=x#secret', 'https://example.com/'],
      favorites: [],
      favicons: { 'https://example.com': 'https://cdn.example/assets/favicon.svg?cache=1' },
    });
  });
  it('reports persistent conflicts and rejects requests after dispose', async () => {
    const launcher = createLauncher(context(20));
    await expect(launcher.request('remember', { url: 'https://example.com/' })).rejects.toThrow('请重试');
    launcher.dispose();
    await expect(launcher.request('recent')).rejects.toThrow('已停用');
  });
  it('waits out a briefly locked data file instead of dropping the visit', async () => {
    // 别的窗口 / 迁移正在写同一个 data.json：不隔一会儿重试，八次都会落在同一段
    // 锁窗口里，这次访问就无声无息地丢了。
    let value: any = null;
    let version = 0;
    const unlockedAt = Date.now() + 40;
    const ctx = {
      readData: async () => ({ value: structuredClone(value), version }),
      writeData: async (next: any, options: any) => {
        if (Date.now() < unlockedAt) return { ok: false, conflict: true };
        if (options.expectedVersion !== version) return { ok: false, conflict: true };
        value = structuredClone(next); version++;
        return { ok: true, version };
      },
    };
    const launcher = createLauncher(ctx);
    expect(await launcher.request('remember', { url: 'https://locked.example/deep/path' })).toMatchObject({
      ok: true,
      saved: true,
      urls: ['https://locked.example/deep/path'],
    });
    expect((await ctx.readData()).value.recentUrls).toEqual(['https://locked.example/deep/path']);
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
    expect(await launcher.request('recent')).toEqual({ urls: ['https://b.example/', 'https://a.example/'], favorites: [], favicons: {} });
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
    expect(await launcher.request('recent')).toEqual({ urls: ['https://new.example/secret', 'https://concurrent.example/'], favorites: [], favicons: {} });
    expect((await ctx.readData()).value.other).toBe('keep');
  });
  it('keeps one icon per site and only for sites the lists still show', async () => {
    const ctx = context();
    const launcher = createLauncher(ctx);
    await launcher.request('remember', { url: 'https://a.example/one', faviconUrl: 'https://a.example/icon.svg' });
    // 同一站点的第二个地址共用这一个图标，不新增键。
    await launcher.request('remember', { url: 'https://a.example/two' });
    expect(((await launcher.request('recent')) as any).favicons).toEqual({ 'https://a.example': 'https://a.example/icon.svg' });
    // 站点掉出最近访问、也没有收藏之后，图标跟着一起收掉。
    for (let i = 0; i < MAX_RECENT_SITES; i++) await launcher.request('remember', { url: `https://filler${i}.example/page` });
    expect(((await launcher.request('recent')) as any).favicons).toEqual({});
  });
  it('keeps an inline icon the page declared, and ignores non-image ones', async () => {
    const svg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3C/svg%3E";
    const launcher = createLauncher(context());
    expect(await launcher.request('remember', { url: 'https://a.example/', faviconUrl: svg })).toMatchObject({ favicons: { 'https://a.example': svg } });
    // 换成一个不认识的图标地址时保留原有图标，不把记录清空。
    expect(await launcher.request('remember', { url: 'https://a.example/', faviconUrl: 'data:text/html,<b>x</b>' })).toMatchObject({ favicons: { 'https://a.example': svg } });
    expect(await launcher.request('remember', { url: 'https://a.example/', faviconUrl: 'javascript:alert(1)' })).toMatchObject({ favicons: { 'https://a.example': svg } });
  });
  it('reads legacy per-address icon keys as their site', async () => {
    const ctx = context();
    await ctx.writeData({ recentUrls: ['https://a.example/page?x=1'], favoriteUrls: [], favicons: { 'https://a.example/': 'https://cdn.example/icon.png' } }, { expectedVersion: 0 });
    expect(await createLauncher(ctx).request('recent')).toMatchObject({ favicons: { 'https://a.example': 'https://cdn.example/icon.png' } });
  });
  it('keeps one entry per address, moves a revisit to the front, and caps history', async () => {
    const ctx = context();
    const launcher = createLauncher(ctx);
    for (let i = 0; i < MAX_RECENT_SITES + 3; i++) await launcher.request('remember', { url: `https://site${i}.example/path?page=${i}` });
    await launcher.request('remember', { url: 'https://site5.example/path?page=5' });
    const { urls = [] } = await launcher.request('recent') as any;
    expect(urls).toHaveLength(MAX_RECENT_SITES);
    expect(urls[0]).toBe('https://site5.example/path?page=5');
    expect(urls.filter((url: string) => url === 'https://site5.example/path?page=5')).toHaveLength(1);
    expect(urls).not.toContain('https://site0.example/path?page=0');
    // 同一站点的另一个地址是另一条记录：最近访问保存的是地址，不是站点。
    await launcher.request('remember', { url: 'https://site5.example/another' });
    const after = (await launcher.request('recent') as any).urls;
    expect(after[0]).toBe('https://site5.example/another');
    expect(after).toContain('https://site5.example/path?page=5');
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
  it('drops the address the user typed when the site redirected somewhere else', async () => {
    const ctx = context();
    const launcher = createLauncher(ctx);
    await launcher.request('remember', { url: 'https://example.com/' });
    await launcher.request('remember', { url: 'https://typed.example/a' });
    expect(await launcher.request('remember', { url: 'https://www.final.example/a?x=1', replaces: 'https://typed.example/a' })).toEqual({
      ok: true,
      saved: true,
      urls: ['https://www.final.example/a?x=1', 'https://example.com/'],
      favicons: {},
    });
    expect(await launcher.request('recent')).toMatchObject({ urls: ['https://www.final.example/a?x=1', 'https://example.com/'] });
  });
  it('filters malformed persisted entries', async () => {
    const ctx = context();
    await ctx.writeData({ recentUrls: ['javascript:bad', null, 'https://a.example/private?token=x', 'http://b.example/#secret'] }, { expectedVersion: 0 });
    expect(await createLauncher(ctx).request('recent')).toEqual({ urls: ['https://a.example/private?token=x', 'http://b.example/#secret'], favorites: [], favicons: {} });
  });
  it('adds, reorders and removes favorite addresses without changing recent sites', async () => {
    const ctx = context();
    const launcher = createLauncher(ctx);
    await launcher.request('remember', { url: 'https://example.com/path' });
    expect(await launcher.request('favorite', { url: 'https://example.com/private', favorite: true })).toEqual({
      ok: true,
      saved: true,
      favorite: true,
      favorites: ['https://example.com/private'],
    });
    expect(await launcher.request('recent')).toEqual({ urls: ['https://example.com/path'], favorites: ['https://example.com/private'], favicons: {} });
    expect(await launcher.request('favorite', { url: 'https://example.com/private', favorite: false })).toEqual({
      ok: true,
      saved: true,
      favorite: false,
      favorites: [],
    });
    expect((await ctx.readData()).value.recentUrls).toEqual(['https://example.com/path']);
  });

  it('caps and deduplicates favorite addresses', async () => {
    const launcher = createLauncher(context());
    for (let i = 0; i < MAX_FAVORITE_SITES + 3; i++) await launcher.request('favorite', { url: `https://favorite${i}.example/path`, favorite: true });
    const result = await launcher.request('recent') as any;
    expect(result.favorites).toHaveLength(MAX_FAVORITE_SITES);
    expect(result.favorites[0]).toBe(`https://favorite${MAX_FAVORITE_SITES + 2}.example/path`);
  });
});
