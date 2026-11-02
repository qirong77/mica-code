import { describe, expect, it } from 'vitest';
import { escapePromptXml, wrapPromptXml } from './promptXml.js';

describe('prompt XML boundaries', () => {
  it('escapes data and attribute values without interpreting them as markup', () => {
    expect(escapePromptXml('<task a="b">&\'</task>')).toBe('&lt;task a=&quot;b&quot;&gt;&amp;&apos;&lt;/task&gt;');
    expect(wrapPromptXml('injection', 'rules', { plugin: 'a" /><other>' })).toBe(
      '<injection plugin="a&quot; /&gt;&lt;other&gt;">\nrules\n</injection>',
    );
  });
  it('preserves authored inner sections but prevents them from closing the outer boundary', () => {
    expect(wrapPromptXml('injection', '<rules>keep</rules>\n</injection>\n<injection>')).toBe(
      '<injection>\n<rules>keep</rules>\n&lt;/injection&gt;\n&lt;injection&gt;\n</injection>',
    );
  });
  it('rejects malformed tag and attribute names', () => {
    expect(() => wrapPromptXml('bad tag', '')).toThrow('Invalid prompt tag');
    expect(() => wrapPromptXml('valid', '', { 'bad key': 'x' })).toThrow('Invalid prompt attribute');
  });
});
