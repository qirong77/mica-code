import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArcoProvider } from '@mica-config-ui/web';
import { Launcher, Welcome } from './desktop.jsx';
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
  expect(html).toContain('/favicon.ico');
  expect(html).toContain('https://a.example/');
  expect(html).toContain('http://b.example:3000/');
  const inner = tree.props.children;
  const siteList = React.Children.toArray(inner.props.children).filter((item: any) => item?.props?.className === 'floatingwindow-sites').at(-1) as any;
  const entries = React.Children.toArray(siteList.props.children) as any[];
  const secondEntry = entries[1].type(entries[1].props) as any;
  secondEntry.props.children[0].props.onClick();
  expect(onOpen).toHaveBeenCalledWith('http://b.example:3000/');
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
