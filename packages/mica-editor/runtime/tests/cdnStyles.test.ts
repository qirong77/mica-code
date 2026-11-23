import {afterEach, describe, expect, it, vi} from 'vitest';

import {ensureEditorOptionalStyle} from '../src/cdnStyles';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('optional editor styles', () => {
  it('injects a feature stylesheet once and does not duplicate it', () => {
    const links: Array<{
      rel: string;
      href: string;
      crossOrigin: string;
      dataset: Record<string, string>;
      getAttribute(name: string): string | null;
    }> = [];
    const fakeDocument = {
      querySelectorAll: () => links,
      createElement: () => {
        const link = {
          rel: '',
          href: '',
          crossOrigin: '',
          dataset: {},
          getAttribute(name: string) {
            return name === 'href' ? link.href : null;
          },
        };
        return link;
      },
      head: {appendChild: (link: (typeof links)[number]) => { links.push(link); }},
    } as unknown as Document;
    vi.stubGlobal('document', fakeDocument);

    ensureEditorOptionalStyle('katex');
    ensureEditorOptionalStyle('katex');

    expect(links).toHaveLength(1);
    expect(links[0].dataset.micaEditorOptionalStyle).toBe('katex');
    expect(links[0].href).toContain('katex@0.16.10/dist/katex.css');
  });
});
