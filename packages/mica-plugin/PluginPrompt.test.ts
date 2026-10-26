import { describe, expect, it } from 'vitest';
import { MAX_PLUGIN_STATE_BYTES, normalizePluginStateRecord, validatePluginStateValue } from './PluginSessionState.js';
import { PluginPromptSections } from './PluginPrompt.js';

describe('normalizePluginStateRecord', () => {
  it('keeps plain JSON values per plugin', () => {
    const record = normalizePluginStateRecord({ notes: 'hello', config: { a: [1, 2] } });
    expect(record).toEqual({ notes: 'hello', config: { a: [1, 2] } });
  });

  it('drops non-object input and unreadable entries', () => {
    expect(normalizePluginStateRecord(null)).toEqual({});
    expect(normalizePluginStateRecord('x')).toEqual({});
    expect(normalizePluginStateRecord([1, 2])).toEqual({});
    expect(normalizePluginStateRecord({ ok: 'yes', bad: () => 1 })).toEqual({ ok: 'yes' });
  });

  it('drops entries that exceed the per-plugin quota instead of truncating them', () => {
    const huge = 'x'.repeat(MAX_PLUGIN_STATE_BYTES + 1);
    expect(normalizePluginStateRecord({ notes: huge, keep: 'small' })).toEqual({ keep: 'small' });
  });
});

describe('validatePluginStateValue', () => {
  it('accepts JSON data and undefined', () => {
    expect(validatePluginStateValue('text')).toBeNull();
    expect(validatePluginStateValue({ nested: { deep: [1, true, null] } })).toBeNull();
    expect(validatePluginStateValue(undefined)).toBeNull();
  });

  it('rejects values that cannot round-trip through JSON', () => {
    expect(validatePluginStateValue(() => 1)).toContain('plain JSON');
    expect(validatePluginStateValue(new Map())).toContain('plain JSON');
    expect(validatePluginStateValue(Number.NaN)).toContain('plain JSON');
  });

  it('rejects values over the quota', () => {
    expect(validatePluginStateValue('x'.repeat(MAX_PLUGIN_STATE_BYTES + 1))).toContain('exceeds');
  });
});

describe('PluginPromptSections', () => {
  it('renders sections in order and skips empty ones', () => {
    const registry = new PluginPromptSections();
    registry.add('a', { id: 'late', order: 20, render: () => 'late' });
    registry.add('a', { id: 'early', order: 10, render: () => 'early' });
    registry.add('b', { id: 'empty', render: () => '   ' });
    expect(registry.render()).toBe('early\n\nlate');
  });

  it('keeps registration order when order ties', () => {
    const registry = new PluginPromptSections();
    registry.add('a', { id: 'one', render: () => 'one' });
    registry.add('b', { id: 'two', render: () => 'two' });
    expect(registry.render()).toBe('one\n\ntwo');
  });

  it('rejects duplicate ids per plugin but allows different plugins to reuse an id', () => {
    const registry = new PluginPromptSections();
    registry.add('a', { id: 'notes', render: () => 'a' });
    expect(() => registry.add('a', { id: 'notes', render: () => 'again' })).toThrow(/already registered/);
    expect(() => registry.add('b', { id: 'notes', render: () => 'b' })).not.toThrow();
  });

  it('removes only the disposed section', () => {
    const registry = new PluginPromptSections();
    const first = registry.add('a', { id: 'one', render: () => 'one' });
    registry.add('b', { id: 'two', render: () => 'two' });
    first.dispose();
    expect(registry.render()).toBe('two');
    expect(registry.size).toBe(1);
  });
});
