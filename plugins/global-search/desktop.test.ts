import { readFileSync } from 'node:fs';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcoProvider, Input } from '@mica-config-ui/web';
import { Launcher } from './desktop.jsx';

const css = readFileSync(new URL('./desktop.css', import.meta.url), 'utf8');
const inputSelector = '.global-search .global-search-input.arco-input';

// These assertions pin the plugin's local CSS contract; browser cascade and geometry
// are measured with the real shared controls in apps/desktop/.probe/global-search.
function declarations(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing local rule: ${selector}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length + 2).split('}')[0]!;
  return Object.fromEntries(
    body
      .split(';')
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(':');
        return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
      }),
  );
}

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

describe('global search input styling', () => {
  it('attaches the local styling class to the real shared Arco combobox', () => {
    // Server rendering runs the real Input without a browser or launcher effects.
    const html = renderToStaticMarkup(
      React.createElement(ArcoProvider, {
        children: React.createElement(Launcher, { api: { launcher: {} }, onClose: undefined }),
      }),
    );
    const input = html.match(/<input\b[^>]*>/g)?.find((tag) => tag.includes('global-search-input'));

    expect(input).toBeDefined();
    const classes = input?.match(/class="([^"]+)"/)?.[1]?.split(/\s+/);
    expect(classes).toContain('arco-input');
    expect(classes).toContain('global-search-input');
    expect(input).toContain('role="combobox"');
    expect(input).toContain('aria-label="搜索文件或文件夹"');
    expect(input).toContain('placeholder="搜索文件或文件夹…"');
  });

  it('fills the search row and inherits its typography instead of scoped form dimensions', () => {
    expect(declarations('.mica-config-ui.global-search')).toMatchObject({
      'font-size': '13px',
      'line-height': '1.5',
    });
    expect(declarations('.global-search-head')).toMatchObject({ height: '42px' });
    expect(declarations(inputSelector)).toEqual({
      width: 'auto',
      'min-width': '0',
      flex: '1 1 auto',
      height: '100%',
      padding: '0',
      background: 'transparent',
      border: 'none',
      outline: 'none',
      'box-shadow': 'none',
      color: 'inherit',
      font: 'inherit',
    });
    // app.css also has an unlayered #root input rule below 768px, so the
    // launcher's 720px native window needs a plugin-scoped ID override too.
    expect(declarations(`#root ${inputSelector}`)).toEqual({ font: 'inherit' });
    expect(css).not.toContain('!important');
    expect(css).not.toMatch(/(?:^|})\s*\.arco-input(?:[\s:.,{])/);
  });

  it('keeps hover, keyboard focus and disabled states borderless without resizing', () => {
    expect(
      declarations(`${inputSelector}:is(:hover, :focus, :focus-visible, :disabled, .arco-input-disabled)`),
    ).toEqual({ background: 'transparent', border: 'none', outline: 'none', 'box-shadow': 'none' });
    expect(declarations(`${inputSelector}:disabled`)).toEqual({
      color: 'var(--color-fg-muted, var(--text-soft))',
    });

    const html = renderToStaticMarkup(
      React.createElement(ArcoProvider, {
        children: React.createElement(Input, { className: 'global-search-input', disabled: true }),
      }),
    );
    expect(html).toContain('arco-input-disabled');
    expect(html).toMatch(/<input\b[^>]*\bdisabled=""/);
  });

  it('uses the theme secondary color for the placeholder in both appearances', () => {
    expect(declarations(`${inputSelector}::placeholder`)).toEqual({
      color: 'var(--color-fg-muted, var(--text-soft))',
      opacity: '1',
    });
  });
});
