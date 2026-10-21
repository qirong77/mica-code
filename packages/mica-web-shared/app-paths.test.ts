import { describe, expect, it } from 'vitest';
import {
  APP_BASE_PATH,
  SHARE_BASE_PATH,
  TERMINAL_PAGE_PATH,
  isAppPath,
  isSharePath,
  isTerminalPagePath,
  isUnderBasePath,
  normalizePathname,
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
