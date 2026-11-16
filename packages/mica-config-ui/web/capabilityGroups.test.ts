import { describe, expect, it } from 'vitest';
import {
  applyGroupEnabled,
  buildCapabilitySections,
  capabilityToggleNames,
  nextGroupEnabled,
} from './capabilityGroups.js';

const tools = [
  { name: 'apply_patch', group: { key: 'edit', label: '文件修改' } },
  { name: 'background_tasks_kill', group: { key: 'background_tasks', label: '后台任务' } },
  { name: 'background_tasks_read', group: { key: 'background_tasks', label: '后台任务' } },
  { name: 'skill' },
];

describe('buildCapabilitySections', () => {
  it('splits by first appearance and keeps ungrouped items separate', () => {
    const sections = buildCapabilitySections(tools, () => true);
    expect(sections.map((section) => section.key)).toEqual(['edit', 'background_tasks', null]);
    expect(sections[1]?.items.map((item) => item.name)).toEqual(['background_tasks_kill', 'background_tasks_read']);
    expect(sections[2]?.label).toBeNull();
  });

  it('reports all / none / partial from the enabled set', () => {
    const disabled = new Set(['background_tasks_read']);
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
      { name: 'background_tasks_start', group: { key: 'background_tasks', label: '后台任务' } },
      { name: 'read_file', group: { key: 'file', label: '文件读取' } },
      { name: 'background_tasks_kill', group: { key: 'background_tasks', label: '后台任务' } },
    ];
    const sections = buildCapabilitySections(repeated, () => true);
    expect(sections.map((section) => section.key)).toEqual(['background_tasks', 'file']);
    expect(sections[0]?.items.map((item) => item.name)).toEqual(['background_tasks_start', 'background_tasks_kill']);
  });

  it('keeps ungrouped rows in place instead of collecting them at the end', () => {
    const mixed = [
      { name: 'alpha', group: null },
      { name: 'background_tasks_kill', group: { key: 'background_tasks', label: '后台任务' } },
      { name: 'background_tasks_read', group: { key: 'background_tasks', label: '后台任务' } },
      { name: 'beta', group: null },
    ];
    const sections = buildCapabilitySections(mixed, () => true);
    expect(sections.map((section) => section.key)).toEqual([null, 'background_tasks', null]);
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
    expect(
      applyGroupEnabled(
        ['background_tasks_kill', 'run_shell'],
        ['background_tasks_kill', 'background_tasks_read'],
        true,
      ),
    ).toEqual(['run_shell']);
    expect(
      applyGroupEnabled(['run_shell'], ['background_tasks_kill', 'background_tasks_read'], false),
    ).toEqual([
      'run_shell',
      'background_tasks_kill',
      'background_tasks_read',
    ]);
  });

  it('does not duplicate names already disabled', () => {
    expect(applyGroupEnabled(['background_tasks_read'], ['background_tasks_read'], false)).toEqual([
      'background_tasks_read',
    ]);
  });
});

describe('capabilityToggleNames', () => {
  it('updates every group member from an individual detail entry', () => {
    expect(capabilityToggleNames(tools, 'background_tasks_read')).toEqual([
      'background_tasks_kill',
      'background_tasks_read',
    ]);
    expect(applyGroupEnabled(['skill'], capabilityToggleNames(tools, 'background_tasks_read'), false)).toEqual([
      'skill',
      'background_tasks_kill',
      'background_tasks_read',
    ]);
    expect(capabilityToggleNames(tools, 'skill')).toEqual(['skill']);
  });
});
