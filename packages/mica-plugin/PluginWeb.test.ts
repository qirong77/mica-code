import { describe, expect, it } from 'vitest';
import { isPluginWebQuery, pluginWebPath } from './PluginWeb.js';

describe('plugin web endpoint contract', () => {
  it('builds a fixed path from a plugin identity and query name', () => {
    expect(pluginWebPath('demo', 'summary')).toBe('/plugins/demo/api/summary');
    expect(pluginWebPath('user.demo', 'query_2')).toBe('/plugins/user.demo/api/query_2');
    expect(isPluginWebQuery('Summary-1')).toBe(true);
  });

  it('rejects arbitrary URLs, separators, prototype magic and unbounded query names', () => {
    for (const query of ['', '../data', 'a/b', 'https://other.example', '?summary', '__proto__', 'a'.repeat(65)]) {
      expect(isPluginWebQuery(query)).toBe(false);
      expect(() => pluginWebPath('demo', query)).toThrow();
    }
    for (const id of ['../demo', '//other.example', 'a..b', 'demo?q=1']) {
      expect(() => pluginWebPath(id, 'summary')).toThrow();
    }
  });
});
