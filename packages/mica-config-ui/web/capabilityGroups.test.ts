import { describe, expect, it } from 'vitest';
import { applyGroupEnabled, buildCapabilitySections, nextGroupEnabled } from './capabilityGroups.js';

const tools = [
  { name: 'apply_patch', group: { key: 'edit', label: '文件修改' } },
  { name: 'pty_kill', group: { key: 'pty', label: '交互终端' } },
  { name: 'pty_read', group: { key: 'pty', label: '交互终端' } },
  { name: 'skill' },
];

describe('buildCapabilitySections', () => {
  it('splits by first appearance and keeps ungrouped items separate', () => {
    const sections = buildCapabilitySections(tools, () => true);
    expect(sections.map((section) => section.key)).toEqual(['edit', 'pty', null]);
    expect(sections[1]?.items.map((item) => item.name)).toEqual(['pty_kill', 'pty_read']);
    expect(sections[2]?.label).toBeNull();
  });

  it('reports all / none / partial from the enabled set', () => {
    const disabled = new Set(['pty_read']);
    const sections = buildCapabilitySections(tools, (name) => !disabled.has(name));
    expect(sections.map((section) => section.state)).toEqual(['all', 'partial', 'all']);
    expect(buildCapabilitySections(tools, () => false).map((section) => section.state)).toEqual([
      'none',
      'none',
      'none',
    ]);
  });

  it('merges a group even when other tools sit between its members', () => {
    const repeated = [
      { name: 'pty_spawn', group: { key: 'pty', label: '交互终端' } },
      { name: 'read_file', group: { key: 'file', label: '文件读取' } },
      { name: 'pty_kill', group: { key: 'pty', label: '交互终端' } },
    ];
    const sections = buildCapabilitySections(repeated, () => true);
    expect(sections.map((section) => section.key)).toEqual(['pty', 'file']);
    expect(sections[0]?.items.map((item) => item.name)).toEqual(['pty_spawn', 'pty_kill']);
  });

  it('keeps ungrouped rows in place instead of collecting them at the end', () => {
    const mixed = [
      { name: 'alpha', group: null },
      { name: 'pty_kill', group: { key: 'pty', label: '交互终端' } },
      { name: 'pty_read', group: { key: 'pty', label: '交互终端' } },
      { name: 'beta', group: null },
    ];
    const sections = buildCapabilitySections(mixed, () => true);
    expect(sections.map((section) => section.key)).toEqual([null, 'pty', null]);
    expect(sections.map((section) => section.items.length)).toEqual([1, 2, 1]);
  });
});

describe('nextGroupEnabled', () => {
  it('turns a fully enabled group off and anything else on', () => {
    expect(nextGroupEnabled('all')).toBe(false);
    expect(nextGroupEnabled('partial')).toBe(true);
    expect(nextGroupEnabled('none')).toBe(true);
  });
});

describe('applyGroupEnabled', () => {
  it('removes every member when enabling and appends missing ones when disabling', () => {
    expect(applyGroupEnabled(['pty_kill', 'run_shell'], ['pty_kill', 'pty_read'], true)).toEqual([
      'run_shell',
    ]);
    expect(applyGroupEnabled(['run_shell'], ['pty_kill', 'pty_read'], false)).toEqual([
      'run_shell',
      'pty_kill',
      'pty_read',
    ]);
  });

  it('does not duplicate names already disabled', () => {
    expect(applyGroupEnabled(['pty_read'], ['pty_read'], false)).toEqual(['pty_read']);
  });
});
