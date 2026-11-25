import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArcoProvider } from '@mica-config-ui/web';
import { Launcher, Welcome, faviconSources, iconToRemember, resolveIcon, seedAfterPush, siteFavicon, suggestItems } from './desktop.jsx';
import manifest from './plugin.json';

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

it('declares the real backtick shortcut and a compact 40px web inset', () => {
  expect(manifest.desktop.launcher.shortcut).toBe('Command+`');
  expect(manifest.desktop.launcher.webContent).toEqual({ top: 40 });
});

it('renders a clear empty state without native web support', () => {
  const html = renderToStaticMarkup(React.createElement(ArcoProvider, { children: React.createElement(Launcher, { api: { launcher: {} } }) }));
  expect(html).toContain('当前环境不支持原生网页浮窗');
  expect(html).toContain('aria-label="网址"');
  expect(html).toContain('disabled');
});

it('starts with a welcome page and a home control when native web is available', () => {
  const method = () => {};
  const web = { state: method, navigate: method, home: method, back: method, forward: method, reload: method, subscribe: method };
  const html = renderToStaticMarkup(React.createElement(ArcoProvider, { children: React.createElement(Launcher, { api: { launcher: { web } } }) }));
  expect(html).toContain('欢迎使用 Floating Window');
  expect(html).toContain('还没有最近访问的站点');
  expect(html).toContain('aria-label="欢迎页"');
});

it('renders recent sites and opens the clicked origin', () => {
  const onOpen = vi.fn();
  const onToggle = vi.fn();
  const tree = Welcome({ favorites: ['https://a.example/'] as any, recent: ['https://a.example/', 'http://b.example:3000/'] as any, onOpen: onOpen as any, onToggle: onToggle as any });
  const html = renderToStaticMarkup(tree);
  expect(html).toContain('收藏');
  // 页面只允许 data: 图片，远端图标必须由外壳取回后内联；取到之前是通用地球图标。
  expect(html).toContain('floatingwindow-site-icon');
  expect(html).not.toContain('<img');
  expect(html).toContain('https://a.example/');
  expect(html).toContain('http://b.example:3000/');
  const inner = tree.props.children;
  const siteList = React.Children.toArray(inner.props.children).filter((item: any) => item?.props?.className === 'floatingwindow-sites').at(-1) as any;
  const entries = React.Children.toArray(siteList.props.children) as any[];
  const secondEntry = entries[1].type(entries[1].props) as any;
  secondEntry.props.children[0].props.onClick();
  expect(onOpen).toHaveBeenCalledWith('http://b.example:3000/');
});

it('tries the stored icon first and falls back to the site root', () => {
  expect(faviconSources('https://a.example/deep/page', 'https://cdn.example/icon.svg')).toEqual([
    'https://cdn.example/icon.svg',
    'https://a.example/favicon.ico',
  ]);
  expect(faviconSources('https://a.example/', '')).toEqual(['https://a.example/favicon.ico']);
  expect(faviconSources('not a url', '')).toEqual([]);
});

it('looks an address icon up by its site', () => {
  const favicons = { 'https://a.example': 'https://cdn.example/icon.svg' };
  expect(siteFavicon(favicons, 'https://a.example/deep/page?q=1')).toBe('https://cdn.example/icon.svg');
  expect(siteFavicon(favicons, 'https://b.example/')).toBe('');
  expect(siteFavicon(undefined, 'https://a.example/')).toBe('');
  expect(siteFavicon(favicons, 'not a url')).toBe('');
});

it('replaces the typed address when the site redirects, but only for that navigation', () => {
  const typed = { url: 'https://typed.example/a', from: 'https://before.example/' };
  // 跳转落地：最终地址顶掉回车时记下的那一条。
  expect(seedAfterPush(typed, 'https://www.final.example/a', true)).toEqual({ replaces: 'https://typed.example/a', seed: null });
  // 还没落地时推来的旧页面地址不是跳转结果，种子留着等真正的那一次。
  expect(seedAfterPush(typed, 'https://before.example/', true)).toEqual({ replaces: '', seed: typed });
  expect(seedAfterPush(typed, 'https://typed.example/a', true)).toEqual({ replaces: '', seed: typed });
  // 这次导航已经结束：之后点链接进的是另一个页面，不能顶掉它。
  expect(seedAfterPush(typed, 'https://typed.example/a', false)).toEqual({ replaces: '', seed: null });
  expect(seedAfterPush(null, 'https://x.example/', true)).toEqual({ replaces: '', seed: null });
});

it('keeps the first icon the host can materialize and skips the rest', async () => {
  const asked: string[] = [];
  const loaded = await resolveIcon(
    ['https://cdn.example/icon.svg', 'https://a.example/favicon.ico'],
    async (url: string) => {
      asked.push(url);
      return url.includes('/favicon.ico') ? 'data:image/png;base64,AQ==' : '';
    },
  );
  expect(loaded).toBe('data:image/png;base64,AQ==');
  expect(asked).toEqual(['https://cdn.example/icon.svg', 'https://a.example/favicon.ico']);
  expect(await resolveIcon(['https://a.example/favicon.ico'], (async () => { throw new Error('离线'); }) as any)).toBe('');
  expect(await resolveIcon(['https://a.example/favicon.ico'], undefined as any)).toBe('');
});

it('keeps the icon an address announced when a later state carries none', () => {
  const seen = new Map([['https://qirong77.com/zencode/?problem=playground', 'https://qirong77.com/zencode/favicon.svg?v=zencode-fold']]);
  // 这一条推送没有图标（单页应用在自己内部导航），记账时要把此前看到的那张带上。
  expect(iconToRemember('', 'https://qirong77.com/zencode/?problem=playground', seen))
    .toBe('https://qirong77.com/zencode/favicon.svg?v=zencode-fold');
  // 推送自己带图标时以它为准，换版本能立刻更新。
  expect(iconToRemember('https://cdn.example/new.svg', 'https://qirong77.com/zencode/?problem=playground', seen))
    .toBe('https://cdn.example/new.svg');
  // 没见过的地址、没有记录时都只能是空，不能凭空造图标。
  expect(iconToRemember('', 'https://other.example/', seen)).toBe('');
  expect(iconToRemember(undefined as any, 'https://qirong77.com/zencode/?problem=playground', null as any)).toBe('');
});

it('lists recent addresses in the address bar, filtered by what is typed', () => {
  const recent = ['https://a.example/deep/page', 'http://b.example:3000/x', 'not a url', ''];
  // 没在编辑：输入框里是当前页地址，拿它筛等于只剩一条，所以列出全部最近访问。
  expect(suggestItems(recent, '')).toEqual([
    { url: 'https://a.example/deep/page' },
    { url: 'http://b.example:3000/x' },
  ]);
  expect(suggestItems(recent, 'B.EXAMPLE')).toEqual([{ url: 'http://b.example:3000/x' }]);
  expect(suggestItems(recent, 'nope')).toEqual([]);
  // 下拉只做快速回到刚才那一页，条数有上限。
  expect(suggestItems(recent, '', 1)).toEqual([{ url: 'https://a.example/deep/page' }]);
  expect(suggestItems(null as any, '')).toEqual([]);
});

it('renders a starred toolbar action for the current site', () => {
  const method = () => {};
  const web = { state: method, navigate: method, home: method, back: method, forward: method, reload: method, subscribe: method };
  const html = renderToStaticMarkup(React.createElement(ArcoProvider, { children: React.createElement(Launcher, { api: { launcher: { web } } }) }));
  expect(html).toContain('aria-label="收藏"');
  expect(html).toContain('floatingwindow-address-wrap');
  expect(html).toContain('floatingwindow-address-favorite');
  expect(html).toContain('aria-label="拖动窗口"');
  expect(html).not.toContain('aria-label="刷新"');
  expect(html).not.toContain('aria-label="关闭"');
});
