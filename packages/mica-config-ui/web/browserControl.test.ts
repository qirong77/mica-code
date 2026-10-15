import { describe, expect, it } from 'vitest';
import {
  browserEnvHint,
  browserStatusLabel,
  browserStatusTone,
  curlExample,
  endpointSummaryLine,
  groupEndpoints,
  methodOf,
  ownerLabel,
  pathWithSampleParams,
  tabSummary,
  unavailableBrowserControlDetails,
} from './browserControl.js';
import type { ConfigWebBrowserControlBrowser, ConfigWebBrowserControlEndpoint } from '../src/shared/types.js';

function browser(overrides: Partial<ConfigWebBrowserControlBrowser> = {}): ConfigWebBrowserControlBrowser {
  return {
    id: 'b1',
    owner: 'session-1',
    label: 'Docs',
    title: 'Example',
    url: 'https://example.com',
    visible: true,
    loading: false,
    activeTabId: 't1',
    tabs: [{ id: 't1', title: 'Example', url: 'https://example.com', active: true }],
    ...overrides,
  };
}

function endpoint(overrides: Partial<ConfigWebBrowserControlEndpoint> = {}): ConfigWebBrowserControlEndpoint {
  return { id: 'e1', method: 'GET', path: '/browser/browsers', summary: '', params: [], ...overrides };
}

describe('browser control labels', () => {
  it('says unowned instead of blank', () => {
    expect(ownerLabel('session-1')).toBe('session-1');
    expect(ownerLabel('  ')).toBe('未归属');
    expect(ownerLabel(null)).toBe('未归属');
    expect(ownerLabel(undefined)).toBe('未归属');
  });

  it('reports the three window states', () => {
    expect(browserStatusLabel(browser({ loading: true, visible: true }))).toBe('加载中');
    expect(browserStatusLabel(browser({ visible: true }))).toBe('可见');
    expect(browserStatusLabel(browser({ visible: false }))).toBe('隐藏');
    expect(browserStatusLabel(null)).toBe('隐藏');
    expect(browserStatusTone(browser({ loading: true }))).toBe('blue');
    expect(browserStatusTone(browser({ visible: true }))).toBe('green');
    expect(browserStatusTone(browser({ visible: false }))).toBe('default');
  });

  it('summarises the tabs of a window', () => {
    expect(tabSummary(browser())).toBe('1 个标签页 · Example');
    expect(
      tabSummary(
        browser({
          tabs: [
            { id: 'a', title: '', url: 'https://a.test', active: false },
            { id: 'b', title: 'Second', url: 'https://b.test', active: true },
          ],
        }),
      ),
    ).toBe('2 个标签页 · Second');
    expect(tabSummary(browser({ tabs: [] }))).toBe('无标签页');
  });

  it('normalises the method and one-line summary', () => {
    expect(methodOf(endpoint({ method: 'post' }))).toBe('POST');
    expect(methodOf(endpoint({ method: '' }))).toBe('GET');
    expect(methodOf(null)).toBe('GET');
    expect(endpointSummaryLine(endpoint({ method: 'post', path: '/browser/browsers' }))).toBe('POST /browser/browsers');
  });

  it('explains the environment variables', () => {
    expect(browserEnvHint({ url: 'MICA_BROWSER_URL', owner: 'MICA_BROWSER_OWNER' })).toContain('$MICA_BROWSER_URL');
    expect(browserEnvHint({ url: 'MICA_BROWSER_URL', owner: 'MICA_BROWSER_OWNER' })).toContain(
      'x-mica-owner: $MICA_BROWSER_OWNER',
    );
    expect(browserEnvHint(null)).toContain('$MICA_BROWSER_URL');
  });
});

describe('browser control endpoint grouping', () => {
  it('orders groups by method and sorts inside a group by path', () => {
    const groups = groupEndpoints([
      endpoint({ id: 'd', method: 'delete', path: '/browser/browsers/:id' }),
      endpoint({ id: 'b', method: 'POST', path: '/browser/browsers' }),
      endpoint({ id: 'a', method: 'GET', path: '/browser/docs' }),
      endpoint({ id: 'c', method: 'GET', path: '/browser/browsers' }),
      endpoint({ id: 'x', method: 'options', path: '/browser' }),
    ]);
    expect(groups.map((group) => group.method)).toEqual(['GET', 'POST', 'DELETE', 'OPTIONS']);
    expect(groups[0].endpoints.map((item) => item.path)).toEqual(['/browser/browsers', '/browser/docs']);
    // 同 method、同 path 时用 id 兜底，顺序稳定
    const stable = groupEndpoints([endpoint({ id: 'z', path: '/a' }), endpoint({ id: 'a', path: '/a' })]);
    expect(stable[0].endpoints.map((item) => item.id)).toEqual(['a', 'z']);
    expect(groupEndpoints(null)).toEqual([]);
  });
});

describe('browser control curl example', () => {
  it('replaces :id with a sample value', () => {
    expect(pathWithSampleParams('/browser/browsers/:id/close')).toBe('/browser/browsers/abc123/close');
    expect(pathWithSampleParams('/browser/:sessionId')).toBe('/browser/example-sessionId');
    const example = curlExample(
      endpoint({ method: 'POST', path: '/browser/browsers/:id/close' }),
      'http://127.0.0.1:8899',
    );
    expect(example).toBe(
      'curl -X POST "http://127.0.0.1:8899/browser/browsers/abc123/close" \\\n' +
        '  -H "x-mica-owner: $MICA_BROWSER_OWNER"',
    );
  });

  it('falls back to the env var and renders a body for required body params', () => {
    expect(curlExample(endpoint({ method: 'GET', path: '/browser/docs' }))).toContain(
      '"$MICA_BROWSER_URL/browser/docs"',
    );
    const example = curlExample(
      endpoint({
        method: 'POST',
        path: '/browser/browsers',
        params: [
          { name: 'url', in: 'body', required: true, description: '' },
          { name: 'label', in: 'body', required: false, description: '' },
        ],
      }),
      'http://127.0.0.1:8899/',
    );
    expect(example).toContain(`-d '{"url":"https://example.com"}'`);
    expect(example).not.toContain('"label"');
  });
});

describe('unavailableBrowserControlDetails', () => {
  // 这一节的入口各处都在（见 layout/Sidebar.tsx），所以拿不到服务时页面必须能照常渲染，
  // 并且明确说出「未开启」——而不是白屏或一个没有内容的空章节。
  it('describes an unopened service instead of an empty page', () => {
    const details = unavailableBrowserControlDetails();
    expect(details.available).toBe(false);
    expect(details.serviceUrl).toBeNull();
    expect(details.skillPath).toBeNull();
    expect(details.browsers).toEqual([]);
    expect(details.endpoints).toEqual([]);
    expect(details.error).toContain('桌面应用');
    // 环境变量名仍然给出：页面上的示例在没服务时也用同一套占位
    expect(details.envVars).toEqual({ url: 'MICA_BROWSER_URL', owner: 'MICA_BROWSER_OWNER' });
  });

  it('keeps an explicit reason when the host supplies one', () => {
    expect(unavailableBrowserControlDetails('服务没起来').error).toBe('服务没起来');
    // 空理由不写成空字符串，仍要有一句能读的说明
    expect(unavailableBrowserControlDetails('').error).toContain('桌面应用');
  });
});
