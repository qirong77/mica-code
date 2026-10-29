import { describe, expect, it } from 'vitest';
import {
  PluginPanelRegistry,
  normalizePluginPanelAction,
  normalizePluginPanelActionResult,
  normalizePluginPanelView,
} from './PluginPanel.js';

describe('normalizePluginPanelView', () => {
  it('keeps rows, items, fields and actions', () => {
    const view = normalizePluginPanelView({
      title: '需求开发',
      subtitle: '角色：需求开发',
      status: { label: '轮询中', tone: 'ok' },
      sections: [
        {
          title: '频道',
          rows: [{ label: '上次检查', value: '2026-10-01 10:00:00' }],
          items: [{ key: 'group:A', label: '群 A', value: '群 · 未读', actions: [{ id: 'remove', label: '删除' }] }],
          fields: [{ key: 'target', label: '群名', type: 'number', value: '5' }],
          actions: [{ id: 'add', label: '添加', tone: 'primary' }],
        },
      ],
    });
    expect(view.title).toBe('需求开发');
    expect(view.status).toEqual({ label: '轮询中', tone: 'ok' });
    expect(view.sections?.[0].items?.[0].actions?.[0].id).toBe('remove');
    expect(view.sections?.[0].fields?.[0].type).toBe('number');
    expect(view.sections?.[0].actions?.[0].tone).toBe('primary');
  });

  it('keeps the auto-commit action only when the section has fields', () => {
    const view = normalizePluginPanelView({
      title: 'x',
      sections: [
        { title: '设置', fields: [{ key: 'n', label: '每多少轮' }], commit: 'settings.save' },
        { title: '动作', actions: [{ id: 'go', label: '执行' }], commit: 'ignored' },
      ],
    });
    expect(view.sections?.[0].commit).toBe('settings.save');
    expect(view.sections?.[1].commit).toBeUndefined();
  });

  it('falls back to the plugin name and drops malformed entries', () => {
    const view = normalizePluginPanelView(
      {
        title: '   ',
        status: { label: '', tone: 'nope' },
        sections: [
          { rows: [{ label: '' }], items: [{ key: '', label: 'x' }], fields: [{ key: 'k' }], actions: [{ id: '' }] },
          { title: '只有标题' },
        ],
      },
      '需求开发',
    );
    expect(view.title).toBe('需求开发');
    expect(view.status).toBeUndefined();
    expect(view.sections).toEqual([{ title: '只有标题' }]);
  });

  it('truncates long text and caps lists', () => {
    const longText = 'x'.repeat(1000);
    const view = normalizePluginPanelView({
      title: 'T',
      sections: [
        {
          title: 'S',
          rows: Array.from({ length: 100 }, () => ({ label: 'l', value: longText })),
          actions: Array.from({ length: 20 }, (_, index) => ({ id: `a${index}`, label: 'b' })),
        },
      ],
    });
    expect(view.sections?.[0].rows?.length).toBe(40);
    expect(view.sections?.[0].actions?.length).toBe(8);
    expect(view.sections?.[0].rows?.[0].value?.endsWith('…')).toBe(true);
  });

  it('survives non-object input', () => {
    expect(normalizePluginPanelView(null, '插件').title).toBe('插件');
    expect(normalizePluginPanelView('nope', '插件').sections).toBeUndefined();
  });
});

describe('normalizePluginPanelAction', () => {
  it('keeps the one-line answer an action can give', () => {
    expect(normalizePluginPanelActionResult({ message: '  先添加频道  ' })).toEqual({
      message: '先添加频道',
    });
  });

  it('treats anything else as "said nothing"', () => {
    expect(normalizePluginPanelActionResult(undefined)).toEqual({});
    expect(normalizePluginPanelActionResult({ message: 42 })).toEqual({});
    expect(normalizePluginPanelActionResult({ message: 'x'.repeat(300) }).message?.length).toBe(120);
  });

  it('keeps action, key and string values only', () => {
    const action = normalizePluginPanelAction({ action: 'channel.add', key: 12, values: { a: 'x', b: 3, c: '  y  ' } });
    expect(action).toEqual({ action: 'channel.add', values: { a: 'x', c: 'y' } });
  });

  it('rejects a missing action id', () => {
    expect(normalizePluginPanelAction({})).toBeNull();
    expect(normalizePluginPanelAction({ action: '  ' })).toBeNull();
  });
});

describe('PluginPanelRegistry', () => {
  it('registers one panel per plugin and replaces on re-register', () => {
    const registry = new PluginPanelRegistry();
    const first = { view: () => ({ title: 'a' }), action: () => {} };
    const second = { view: () => ({ title: 'b' }), action: () => {} };
    registry.add('p', first);
    const registration = registry.add('p', second);
    expect(registry.get('p')).toBe(second);
    expect(registry.ids()).toEqual(['p']);
    registration.dispose();
    expect(registry.get('p')).toBeNull();
  });

  it('dispose of a replaced handler does not remove the replacement', () => {
    const registry = new PluginPanelRegistry();
    const first = registry.add('p', { view: () => ({ title: 'a' }), action: () => {} });
    registry.add('p', { view: () => ({ title: 'b' }), action: () => {} });
    first.dispose();
    expect(registry.get('p')).not.toBeNull();
  });
});
