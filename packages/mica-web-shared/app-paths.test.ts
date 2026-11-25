import { describe, expect, it } from 'vitest';
import {
  APP_BASE_PATH,
  BROWSER_CHROME_PAGE_PATH,
  SHARE_BASE_PATH,
  TERMINAL_PAGE_PATH,
  isAppPath,
  isBrowserChromePagePath,
  isPluginPagePath,
  isPluginPageRoute,
  isSharePath,
  isTerminalPagePath,
  isUnderBasePath,
  normalizePathname,
  matchesPluginPagePath,
  pluginPagePath,
  readPluginPageId,
  toAssetPath,
} from './app-paths.js';

describe('normalizePathname', () => {
  it('adds a leading slash and drops the trailing one', () => {
    expect(normalizePathname('share/')).toBe('/share');
    expect(normalizePathname('mica-web')).toBe('/mica-web');
    expect(normalizePathname('/share/')).toBe('/share');
    expect(normalizePathname('/share//x')).toBe('/share/x');
  });

  it('keeps the root and tolerates junk', () => {
    expect(normalizePathname('/')).toBe('/');
    expect(normalizePathname('')).toBe('/');
    expect(normalizePathname(null)).toBe('/');
    expect(normalizePathname(undefined)).toBe('/');
  });
});

describe('isSharePath', () => {
  it('matches the share base path and everything under it', () => {
    expect(isSharePath('/share')).toBe(true);
    expect(isSharePath('/share/')).toBe(true);
    expect(isSharePath('/share/index.html')).toBe(true);
  });

  it('does not match the app or a lookalike path', () => {
    expect(isSharePath('/')).toBe(false);
    expect(isSharePath('/mica-web')).toBe(false);
    expect(isSharePath('/shares')).toBe(false);
    expect(isSharePath('/api/env')).toBe(false);
    // 前缀相同但不是同一层（`/share-x` 不是分享视图）
    expect(isSharePath('/share-x')).toBe(false);
  });
});

describe('isAppPath', () => {
  it('accepts the root and the explicit app path', () => {
    expect(isAppPath('/')).toBe(true);
    expect(isAppPath('/mica-web')).toBe(true);
    expect(isAppPath('/mica-web/')).toBe(true);
    expect(isAppPath('/mica-web/index.html')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isAppPath('/share')).toBe(false);
    expect(isAppPath('/assets/app.js')).toBe(false);
    expect(isAppPath('/mica-web-x')).toBe(false);
  });
});

describe('isTerminalPagePath', () => {
  it('matches only the terminal window page', () => {
    expect(isTerminalPagePath('/terminal-control')).toBe(true);
    expect(isTerminalPagePath('/terminal-control/')).toBe(true);
    expect(isTerminalPagePath(TERMINAL_PAGE_PATH)).toBe(true);
  });

  it('does not match the app, assets or a lookalike path', () => {
    expect(isTerminalPagePath('/')).toBe(false);
    expect(isTerminalPagePath('/mica-web')).toBe(false);
    expect(isTerminalPagePath('/terminal-controls')).toBe(false);
    expect(isTerminalPagePath('/assets/terminal.js')).toBe(false);
  });
});

describe('isBrowserChromePagePath', () => {
  it('matches the browser chrome page', () => {
    expect(isBrowserChromePagePath('/browser-chrome')).toBe(true);
    expect(isBrowserChromePagePath('/browser-chrome/')).toBe(true);
    expect(isBrowserChromePagePath(BROWSER_CHROME_PAGE_PATH)).toBe(true);
  });

  it('does not match the app, its own asset or a lookalike path', () => {
    expect(isBrowserChromePagePath('/')).toBe(false);
    expect(isBrowserChromePagePath('/browser-chrome.html')).toBe(false);
    expect(isBrowserChromePagePath('/browser-chromes')).toBe(false);
    expect(isBrowserChromePagePath('/assets/browser-chrome.js')).toBe(false);
  });
});

describe('toAssetPath', () => {
  it('strips both service prefixes down to the static path', () => {
    expect(toAssetPath('/mica-web')).toBe('/');
    expect(toAssetPath(SHARE_BASE_PATH)).toBe('/');
    expect(toAssetPath('/share/')).toBe('/');
    expect(toAssetPath('/mica-web/index.html')).toBe('/index.html');
    expect(toAssetPath('/share/nested/page')).toBe('/nested/page');
  });

  it('leaves absolute asset urls and the root alone', () => {
    expect(toAssetPath('/')).toBe('/');
    expect(toAssetPath('/assets/index-a1b2.js')).toBe('/assets/index-a1b2.js');
    expect(toAssetPath('/favicon.ico')).toBe('/favicon.ico');
  });

  it('does not treat a lookalike prefix as a service path', () => {
    expect(toAssetPath('/shares/x')).toBe('/shares/x');
    expect(toAssetPath('/mica-webs/x')).toBe('/mica-webs/x');
  });
});

describe('isUnderBasePath', () => {
  it('is the shared rule both helpers use', () => {
    expect(isUnderBasePath('/a/b', '/a')).toBe(true);
    expect(isUnderBasePath('/a', '/a')).toBe(true);
    expect(isUnderBasePath('/ab', '/a')).toBe(false);
    expect(isUnderBasePath('/', '/')).toBe(true);
  });

  it('exposes the two service prefixes', () => {
    expect(APP_BASE_PATH).toBe('/mica-web');
    expect(SHARE_BASE_PATH).toBe('/share');
  });
});

describe('plugin pages', () => {
  it('builds and parses a custom single-segment page route', () => {
    expect(pluginPagePath('demo', 'console')).toBe('/plugins/demo/console');
    expect(readPluginPageId('/plugins/demo/console')).toBe('demo');
    expect(readPluginPageId('/plugins/user.demo/Console_2-')).toBe('user.demo');
    expect(matchesPluginPagePath('/plugins/demo/console', 'demo', 'console')).toBe(true);
    expect(matchesPluginPagePath('/plugins/demo/console/', 'demo', 'console')).toBe(true);
    expect(matchesPluginPagePath('/plugins/pages/demo', 'demo', 'console')).toBe(false);
    expect(matchesPluginPagePath('/plugins/demo/other', 'demo', 'console')).toBe(false);
    expect(matchesPluginPagePath('/plugins/demo/console', 'demo')).toBe(false);
    expect(matchesPluginPagePath('/plugins//demo/console', 'demo', 'console')).toBe(false);
  });

  it('rejects reserved, nested, encoded and traversal routes before building an address', () => {
    for (const route of ['', 'api', 'API', 'pages', '..', '.', '../console', 'a/b', 'a.b', '%2e%2e', 'has space', 'a'.repeat(65)]) {
      expect(isPluginPageRoute(route)).toBe(false);
      expect(() => pluginPagePath('demo', route)).toThrow('route');
    }
    for (const path of ['/plugins/demo/api', '/plugins/demo/pages', '/plugins/demo/api/summary', '/plugins/demo/console/extra', '/plugins/demo/%2e%2e', '/plugins/demo/a%2fb']) {
      expect(readPluginPageId(path)).toBeNull();
    }
    expect(() => pluginPagePath('../demo')).toThrow('id');
    expect(readPluginPageId('/plugins/demo..x/console')).toBeNull();
  });

  it('builds a readable address per plugin id', () => {
    expect(pluginPagePath('notebook')).toBe('/plugins/pages/notebook');
    // 用户插件 id 带点号，编码后仍是一个路径段，读回来是同一个 id。
    expect(pluginPagePath('user.demo')).toBe('/plugins/pages/user.demo');
    expect(readPluginPageId(pluginPagePath('user.demo'))).toBe('user.demo');
  });

  it('only accepts the page path itself', () => {
    expect(isPluginPagePath('/plugins/pages')).toBe(false);
    expect(isPluginPagePath('/plugins/pages/')).toBe(false);
    expect(isPluginPagePath('/plugins/pages/notebook')).toBe(true);
    expect(isPluginPagePath('/plugins/pages/notebook/')).toBe(true);
    expect(isPluginPagePath('/plugins/pages/notebook/extra')).toBe(false);
    expect(isPluginPagePath('/plugins/pagesX')).toBe(false);
  });

  it('rejects ids that could walk out of the path', () => {
    expect(readPluginPageId('/plugins/pages/..%2Fsecret')).toBe(null);
    expect(readPluginPageId('/plugins/pages/%2e%2e')).toBe(null);
    expect(readPluginPageId('/plugins/pages/.hidden')).toBe(null);
    expect(readPluginPageId('/plugins/pages/%E0%A4%A')).toBe(null);
  });
});
