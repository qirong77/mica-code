import { describe, expect, it } from 'vitest';
import {
  capabilityCounts,
  capabilitySelectionEquals,
  emptyCapabilitySelection,
  isCapabilityEnabled,
  isCapabilitySelectionEmpty,
  normalizeCapabilitySelection,
  setAllCapabilitiesEnabled,
  setCapabilityEnabled,
} from './capabilities.js';

describe('capability selection', () => {
  it('treats missing or broken values as everything enabled', () => {
    expect(normalizeCapabilitySelection(undefined)).toEqual(emptyCapabilitySelection());
    expect(normalizeCapabilitySelection({ disabledSkills: 'x' })).toEqual(emptyCapabilitySelection());
    expect(isCapabilitySelectionEmpty(normalizeCapabilitySelection(null))).toBe(true);
  });

  it('trims, de-duplicates and ignores non-strings', () => {
    expect(
      normalizeCapabilitySelection({
        disabledSkills: [' review ', 'review', '', 42, null],
        disabledTools: ['run_shell'],
      }),
    ).toEqual({
      version: 1,
      disabledSkills: ['review'],
      disabledTools: ['run_shell'],
      disabledMcpServers: [],
    });
  });

  it('toggles one capability without touching the others', () => {
    const base = setCapabilityEnabled(emptyCapabilitySelection(), 'skills', 'pdf', false);
    expect(isCapabilityEnabled(base, 'skills', 'pdf')).toBe(false);
    expect(isCapabilityEnabled(base, 'tools', 'pdf')).toBe(true);
    expect(base.disabledTools).toEqual([]);

    const reverted = setCapabilityEnabled(base, 'skills', 'pdf', true);
    expect(isCapabilityEnabled(reverted, 'skills', 'pdf')).toBe(true);
  });

  it('sets all entries of one kind and keeps counts scoped to that kind', () => {
    const selection = setAllCapabilitiesEnabled(emptyCapabilitySelection(), 'mcpServers', ['a', 'b'], false);
    expect(capabilityCounts(selection, 'mcpServers', ['a', 'b', 'c'])).toEqual({ enabled: 1, total: 3 });
    expect(capabilityCounts(selection, 'skills', ['a', 'b'])).toEqual({ enabled: 2, total: 2 });
  });

  it('compares selections regardless of order', () => {
    const left = { version: 1 as const, disabledSkills: ['a', 'b'], disabledTools: [], disabledMcpServers: [] };
    const right = { version: 1 as const, disabledSkills: ['b', 'a'], disabledTools: [], disabledMcpServers: [] };
    expect(capabilitySelectionEquals(left, right)).toBe(true);
    expect(capabilitySelectionEquals(left, { ...right, disabledSkills: ['a'] })).toBe(false);
  });
});
