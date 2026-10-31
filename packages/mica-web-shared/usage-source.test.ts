import { describe, expect, test } from 'vitest';
import { countUsageRequests, usageSourceOf } from './usage-source.js';

describe('usageSourceOf', () => {
  test('treats main-loop style records without plugin hints as built-in helpers', () => {
    expect(usageSourceOf({ subagentType: 'compact' })).toEqual({
      kind: 'helper',
      id: 'compact',
      pluginId: null,
    });
  });

  test('keeps delegations delegated even when the delegating plugin records its id', () => {
    // 委派由 subagent 插件提供：记录里有 pluginId，但用户关心的是「主对话派出去的活」。
    expect(
      usageSourceOf({
        origin: 'plugin',
        pluginId: 'subagent',
        subagentType: 'Explore',
        initiatedByCallId: 'call-1',
      }),
    ).toEqual({ kind: 'delegation', id: 'Explore', pluginId: 'subagent' });
  });

  test('honours an explicit delegation origin without a tool-call id', () => {
    expect(usageSourceOf({ origin: 'delegation', subagentType: 'Implementer' })).toEqual({
      kind: 'delegation',
      id: 'Implementer',
      pluginId: null,
    });
  });

  test('groups plugin-owned requests by plugin id', () => {
    expect(usageSourceOf({ origin: 'plugin', pluginId: 'memory', subagentType: 'memory-curator' }))
      .toEqual({ kind: 'plugin', id: 'memory', pluginId: 'memory' });
    // 只带 pluginId、没写 origin 的历史记录同样归到插件。
    expect(usageSourceOf({ pluginId: 'session-rename', subagentType: 'title' })).toEqual({
      kind: 'plugin',
      id: 'session-rename',
      pluginId: 'session-rename',
    });
  });

  test('falls back to the subagent type when a plugin never recorded its id', () => {
    expect(usageSourceOf({ origin: 'plugin', subagentType: 'web-search' })).toEqual({
      kind: 'plugin',
      id: 'web-search',
      pluginId: null,
    });
  });

  test('survives empty and malformed records', () => {
    expect(usageSourceOf(null)).toEqual({ kind: 'helper', id: 'helper', pluginId: null });
    expect(usageSourceOf({ pluginId: '   ' })).toEqual({
      kind: 'helper',
      id: 'helper',
      pluginId: null,
    });
  });
});

describe('countUsageRequests', () => {
  test('adds the main history and every subagent / plugin record', () => {
    expect(
      countUsageRequests({
        usageHistory: [{}, {}],
        subagentUsageHistory: [
          { requests: [{}] },
          { requests: [{}, {}] },
          { requests: null },
        ],
      }),
    ).toBe(5);
  });

  test('treats missing histories as zero', () => {
    expect(countUsageRequests({})).toBe(0);
    expect(countUsageRequests({ usageHistory: [] })).toBe(0);
  });
});
