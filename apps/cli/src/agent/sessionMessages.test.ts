import { describe, expect, it } from 'vitest';
import { sameSessionUserContent, sessionContentText, sessionPromptKey } from '@packages/mica-common/sessionMessages.js';

describe('unified session input identity', () => {
  it('matches pi content, display input and compacted media by shared body text', () => {
    const raw = [
      { type: 'text', text: 'inspect [Image](/tmp/a.png)' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ];
    const compacted = [{ type: 'text', text: 'inspect [image omitted during compact]' }];
    expect(sameSessionUserContent(raw, compacted)).toBe(true);
    expect(sameSessionUserContent(raw, 'inspect [图片]')).toBe(true);
    expect(sameSessionUserContent(raw, 'another request')).toBe(false);
    expect(sessionContentText(raw)).toBe('inspect [Image](/tmp/a.png)');
  });

  it('keeps media-only reference identity after compact and distinguishes separate images', () => {
    const raw = [
      { type: 'text', text: '[Image](/tmp/a.png)' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ];
    const compacted = [
      { type: 'text', text: '[Image](/tmp/a.png)' },
      { type: 'text', text: '[image omitted during compact]' },
    ];
    expect(sameSessionUserContent(raw, compacted)).toBe(true);
    expect(sameSessionUserContent(raw, '[Image](/tmp/b.png)')).toBe(false);
  });

  it('matches media-only AgentQueryContent and pi images without treating empty inputs as duplicates', () => {
    const input = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }];
    const pi = [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }];
    expect(sameSessionUserContent(input, pi)).toBe(true);
    expect(sameSessionUserContent(input, [{ type: 'image', mimeType: 'image/png', data: 'BBBB' }])).toBe(false);
    expect(sameSessionUserContent('', [])).toBe(false);
    expect(sessionPromptKey(undefined)).toBe('');
  });
});
