import { describe, expect, it } from 'vitest';
import {
  CHROME_MESSAGE_PREFIX,
  chromeUpdateScript,
  encodeChromeMessage,
  parseChromeMessage,
} from './browser-chrome.js';

describe('browser chrome bridge', () => {
  it('round-trips a message through the log line', () => {
    const line = encodeChromeMessage({ action: 'navigate', url: 'https://example.com' });
    expect(line.startsWith(CHROME_MESSAGE_PREFIX)).toBe(true);
    expect(parseChromeMessage(line)).toEqual({ action: 'navigate', url: 'https://example.com' });
  });

  it('ignores page logs that are not ours', () => {
    expect(parseChromeMessage('hello')).toBeNull();
    expect(parseChromeMessage('')).toBeNull();
    expect(parseChromeMessage(null)).toBeNull();
  });

  it('rejects a prefixed line that is not a control message', () => {
    expect(parseChromeMessage(`${CHROME_MESSAGE_PREFIX}not-json`)).toBeNull();
    expect(parseChromeMessage(`${CHROME_MESSAGE_PREFIX}{"action":3}`)).toBeNull();
    expect(parseChromeMessage(`${CHROME_MESSAGE_PREFIX}null`)).toBeNull();
  });

  it('targets the bar and the recent panel with different globals', () => {
    expect(chromeUpdateScript('bar', { url: 'https://a.test' })).toBe(
      'window.__micaChrome.update({"url":"https://a.test"})'
    );
    expect(chromeUpdateScript('recent', null)).toBe('window.__micaRecent.update(null)');
    // JSON 里带引号/换行也不会把调用拆坏
    expect(chromeUpdateScript('bar', { title: 'a"b\nc' })).toContain('a\\"b\\nc');
  });
});
