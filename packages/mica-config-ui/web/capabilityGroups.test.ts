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

  it('orders groups by the catalog order instead of the tool-name order', () => {
    const ordered = [
      { name: 'apply_patch', group: { key: 'edit', label: '文件修改', order: 20 } },
      { name: 'read_file', group: { key: 'file', label: '文件读取', order: 10 } },
      { name: 'pty_kill', group: { key: 'pty', label: '交互终端', order: 40 } },
    ];
    const sections = buildCapabilitySections(ordered, () => true);
    expect(sections.map((section) => section.key)).toEqual(['file', 'edit', 'pty']);
  });

  it('keeps ungrouped rows after the ordered groups', () => {
    const mixed = [
      { name: 'alpha', group: null },
      { name: 'read_file', group: { key: 'file', label: '文件读取', order: 10 } },
      { name: 'beta', group: null },
    ];
    const sections = buildCapabilitySections(mixed, () => true);
    expect(sections.map((section) => section.key)).toEqual(['file', null, null]);
    expect(sections.slice(1).map((section) => section.items[0]?.name)).toEqual(['alpha', 'beta']);
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
